/**
 * Turning a transcript into subtitle cues, and cues into SRT / WebVTT.
 *
 * A recognizer's segments are not cues. Whisper emits ~30 s decode windows,
 * Deepgram emits paragraphs, ElevenLabs emits speaker turns — none of them
 * respect the things that make a subtitle readable: how many characters fit on
 * a line, how fast a person reads, how long a cue may sit on screen. So the
 * exporters never write segments directly; they go through `resegment` first.
 *
 * The defaults below are the ones professional subtitling houses use. They are
 * deliberately conservative — 42 characters per line and 17 characters per
 * second is the intersection of the BBC and Netflix English guidelines, and a
 * cue built to them is readable in every other Latin-script language too.
 */

export interface Cue {
  startMs: number;
  endMs: number;
  /** One entry per rendered line. At most `maxLines`. */
  lines: string[];
  speaker?: string;
}

export interface SegmentationOptions {
  /** Characters per rendered line before a break is forced. */
  maxCharsPerLine: number;
  /** Rendered lines per cue. */
  maxLines: number;
  /** A cue never sits on screen longer than this. */
  maxDurationMs: number;
  /**
   * A cue never sits on screen for less than this, even for one short word —
   * a 200 ms flash is unreadable. Extending is allowed to eat into the gap
   * before the next cue but never past its start.
   */
  minDurationMs: number;
  /**
   * Reading speed ceiling, characters per second. A cue whose text exceeds it
   * is split rather than shown too briefly.
   */
  maxCharsPerSecond: number;
  /**
   * A silence at least this long between two words forces a cue boundary. This
   * is what keeps a cue from spanning a pause the viewer can hear.
   */
  gapSplitMs: number;
  /** Blank frames between consecutive cues, so they do not visually merge. */
  minGapMs: number;
  /** Prefix each cue with `Speaker:` when the transcript is diarized. */
  includeSpeakers: boolean;
  /**
   * The media's own length, when the caller knows it.
   *
   * The timing pass EXTENDS cues to satisfy `minDurationMs` and the
   * reading-speed floor, and it has no other way of knowing where the file
   * ends — so without this a cue can finish after the video does. Measured: a
   * 5.414 s clip whose last segment ended at 5320 ms produced a cue ending at
   * 5463 ms. Some players silently drop such a cue and several NLEs refuse the
   * whole SRT on import, so the failure is not cosmetic.
   *
   * Optional because the pure segmentation tests have no media behind them;
   * `undefined` means "do not clamp".
   */
  mediaDurationMs?: number;
}

export const DEFAULT_SEGMENTATION: SegmentationOptions = {
  maxCharsPerLine: 42,
  maxLines: 2,
  maxDurationMs: 7000,
  minDurationMs: 1000,
  maxCharsPerSecond: 17,
  gapSplitMs: 700,
  minGapMs: 80,
  includeSpeakers: false,
};

/**
 * Punctuation that ends a clause. A weaker break than a sentence, and the
 * second choice when a cue has to be split somewhere.
 */
const CLAUSE_END = /[,;:、，；：]["'”’»)\]]*$/u;

/** Sentence-final punctuation, including the CJK and Arabic forms. */
const SENTENCE_END = /[.!?…。！？؟]["'”’»)\]]*$/u;

interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
  speaker?: string;
}

/**
 * Break one cue's words across at most `maxLines` lines, balancing their
 * lengths.
 *
 * Balanced rather than greedy on purpose: a greedy fill produces a 41-character
 * line above a 3-character line, which reads as a mistake. The search is over
 * every split point, which is fine — a cue is a couple of dozen words at most.
 */
export function layoutLines(words: string[], maxCharsPerLine: number, maxLines: number): string[] {
  const joined = words.join(' ');
  if (joined.length <= maxCharsPerLine || maxLines === 1 || words.length === 1) return [joined];

  // Try every way of splitting into exactly `n` lines for n = 2..maxLines, and
  // keep the first n whose longest line fits. Fewer lines is always better.
  for (let n = 2; n <= maxLines; n++) {
    const best = balancedSplit(words, n, maxCharsPerLine);
    if (best) return best;
  }
  // Nothing fits in `maxLines` — which happens only for a single token longer
  // than a line, since the caller caps a cue's total length at
  // maxCharsPerLine * maxLines. Fall back to a greedy fill and return every
  // line it produces. Truncating here would silently delete transcribed words,
  // which is worse than a cue one line taller than the style guide allows.
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > maxCharsPerLine && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function balancedSplit(words: string[], lineCount: number, maxCharsPerLine: number): string[] | null {
  let bestLines: string[] | null = null;
  let bestSpread = Number.POSITIVE_INFINITY;
  const walk = (index: number, taken: string[][], remaining: number): void => {
    if (remaining === 0) {
      if (index !== words.length) return;
      const lines = taken.map((chunk) => chunk.join(' '));
      if (lines.some((line) => line.length > maxCharsPerLine)) return;
      const lengths = lines.map((line) => line.length);
      const spread = Math.max(...lengths) - Math.min(...lengths);
      if (spread < bestSpread) {
        bestSpread = spread;
        bestLines = lines;
      }
      return;
    }
    // Leave at least one word for each remaining line.
    for (let end = index + 1; end <= words.length - (remaining - 1); end++) {
      walk(end, [...taken, words.slice(index, end)], remaining - 1);
    }
  };
  walk(0, [], lineCount);
  return bestLines;
}

/** The characters that count against the reading-speed budget. */
function readableLength(text: string): number {
  return text.replace(/\s+/g, ' ').trim().length;
}

/**
 * Words for a segment that has none, spread across its span by character count.
 *
 * This is a fallback, and it is honest about being one: the timings are
 * interpolated, not measured. It exists because Deepgram's Whisper tier and
 * DeepInfra's non-verbose responses return segment text with no word timings at
 * all, and a subtitle file with plausible cue boundaries beats one enormous cue.
 */
function interpolateWords(text: string, startMs: number, endMs: number, speaker?: string): TimedWord[] {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  const total = tokens.reduce((sum, t) => sum + t.length, 0) || 1;
  const span = Math.max(0, endMs - startMs);
  const out: TimedWord[] = [];
  let consumed = 0;
  for (const token of tokens) {
    const wordStart = startMs + Math.round((consumed / total) * span);
    consumed += token.length;
    const wordEnd = startMs + Math.round((consumed / total) * span);
    out.push({ text: token, startMs: wordStart, endMs: Math.max(wordEnd, wordStart), ...(speaker ? { speaker } : {}) });
  }
  return out;
}

/**
 * How many lines a greedy first-fit needs for these words.
 *
 * Greedy is not a heuristic here, it is exact: with the word order fixed, first-fit
 * minimises the line count. So this is the true answer to "can this cue be drawn
 * in `maxLines` lines", which is the question the accumulator below actually
 * needs to ask.
 *
 * A single word longer than a line still counts as one line. It has to go
 * somewhere, and refusing to place it would lose transcribed text.
 */
function linesNeeded(words: readonly string[], maxCharsPerLine: number): number {
  if (words.length === 0) return 0;
  let lines = 1;
  let current = 0;
  for (const word of words) {
    const candidate = current === 0 ? word.length : current + 1 + word.length;
    if (candidate > maxCharsPerLine && current > 0) {
      lines += 1;
      current = word.length;
    } else {
      current = candidate;
    }
  }
  return lines;
}

/**
 * Whether these words can be drawn as a legal cue.
 *
 * This replaced a character budget of `maxCharsPerLine * maxLines`, which was
 * subtly and visibly wrong. 84 characters is not the same as "fits on two
 * 42-character lines": the break has to fall between words. Measured on a real
 * transcript — "This video is for beginner video editors who waste hours on
 * tasks that could be done" is 83 characters, passed the budget, and had no
 * legal two-line split at all, so the layout fell through to a greedy fill and
 * drew THREE lines. See docs/bugs/0003.
 */
function fitsInLines(words: readonly string[], maxCharsPerLine: number, maxLines: number): boolean {
  return linesNeeded(words, maxCharsPerLine) <= maxLines;
}

/**
 * Transcript → cues.
 *
 * One pass over every word in the transcript, accumulating into a cue and
 * closing it when any rule says it must close. Segment boundaries are honoured
 * as cue boundaries too, because a segment change usually is a real pause.
 */
export function resegment(
  segments: readonly { startMs: number; endMs: number; text: string; words: readonly TimedWord[]; speaker?: string }[],
  options: Partial<SegmentationOptions> = {},
): Cue[] {
  const opts: SegmentationOptions = { ...DEFAULT_SEGMENTATION, ...options };
  const budget = opts.maxCharsPerLine * opts.maxLines;

  const cues: Cue[] = [];
  let pending: TimedWord[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    const first = pending[0];
    const last = pending[pending.length - 1];
    if (!first || !last) {
      pending = [];
      return;
    }
    const speaker = first.speaker;
    const words = pending.map((w) => w.text);
    const lines = layoutLines(words, opts.maxCharsPerLine, opts.maxLines);
    cues.push({
      startMs: first.startMs,
      endMs: Math.max(last.endMs, first.startMs),
      lines,
      ...(speaker !== undefined ? { speaker } : {}),
    });
    pending = [];
  };

  /**
   * Close the cue at the best linguistic break inside it, carrying the rest over.
   *
   * A cue that has simply run out of room used to be emitted whole, which is how
   * a subtitle ends on "that could be done" and the next one opens with "in
   * seconds." Professional practice is to break where the language does: after a
   * sentence, failing that after a clause, and only failing both at the last
   * word.
   *
   * The back-off is capped at 40 % of the cue. Breaking after the second word of
   * a full line, because that is where the only comma happened to fall, produces
   * a two-word flash and pushes everything else into the next cue — worse than
   * the mid-phrase break it was avoiding.
   */
  const flushAtBestBreak = (): void => {
    if (pending.length < 2) {
      flush();
      return;
    }
    const floor = Math.max(1, Math.ceil(pending.length * 0.4));
    let breakAfter = -1;
    for (let i = pending.length - 2; i >= floor - 1; i--) {
      const text = pending[i]?.text ?? '';
      if (SENTENCE_END.test(text)) { breakAfter = i; break; }
      if (breakAfter === -1 && CLAUSE_END.test(text)) breakAfter = i;
    }
    if (breakAfter === -1) {
      flush();
      return;
    }
    const carried = pending.slice(breakAfter + 1);
    pending = pending.slice(0, breakAfter + 1);
    flush();
    pending = carried;
  };

  for (const segment of segments) {
    const words: TimedWord[] = segment.words.length > 0
      ? segment.words.map((w) => ({ ...w, ...(w.speaker ?? segment.speaker ? { speaker: w.speaker ?? segment.speaker } : {}) }))
      : interpolateWords(segment.text, segment.startMs, segment.endMs, segment.speaker);

    for (const word of words) {
      const previous = pending[pending.length - 1];
      if (previous) {
        const gap = word.startMs - previous.endMs;
        const speakerChanged = (previous.speaker ?? null) !== (word.speaker ?? null);
        // The real question, not a character count: can the cue still be DRAWN?
        const wouldNotFit = !fitsInLines(
          [...pending, word].map((w) => w.text),
          opts.maxCharsPerLine,
          opts.maxLines,
        );
        const start = pending[0]?.startMs ?? word.startMs;
        const wouldOverrunTime = word.endMs - start > opts.maxDurationMs;
        if (gap >= opts.gapSplitMs || speakerChanged) flush();
        else if (wouldNotFit || wouldOverrunTime) flushAtBestBreak();
        else if (SENTENCE_END.test(previous.text) && readableLength(pending.map((w) => w.text).join(' ')) >= budget * 0.6) flush();
      }
      pending.push(word);
    }
    // A segment boundary is a natural cue boundary when the text ended a
    // sentence; otherwise let the next segment's words continue the cue.
    const lastWord = pending[pending.length - 1];
    if (lastWord && SENTENCE_END.test(lastWord.text)) flush();
  }
  flush();

  // Orphans are folded in BEFORE timing, so the merged cue gets one duration
  // computed from its final text rather than inheriting a floor set for the
  // fragment it used to be.
  return applyTiming(mergeOrphans(cues, opts), opts);
}

/**
 * Enforce the timing rules the accumulation pass could not: minimum duration,
 * reading speed, and the gap between neighbours.
 *
 * Order matters. Duration is extended first (a cue may need to grow), then the
 * gap is enforced (which may shrink the cue that just grew), and only then is
 * the result re-checked. Doing the gap first lets a later extension close it
 * again.
 */
/**
 * Fold an orphan cue back into its neighbour.
 *
 * A cue that has run out of room hands its overflow to the next one, and when
 * the overflow is a single short word the result is a cue that flashes "update."
 * on screen by itself. Subtitling houses call these orphans and treat them as a
 * defect; a reader's eye reaches the line before it has anything to read.
 *
 * Merging backwards, into the cue before, rather than forwards: the orphan is
 * the *tail* of the sentence that cue was carrying, so joining it there restores
 * the phrase. Forwards would staple it to the start of an unrelated one.
 *
 * A merge only happens when the result is still legal — it must still draw in
 * `maxLines` and must not exceed `maxDurationMs`. An orphan that cannot be
 * absorbed is left alone, because a slightly awkward cue beats an illegal one.
 */
function mergeOrphans(cues: readonly Cue[], opts: SegmentationOptions): Cue[] {
  const ORPHAN_CHARS = Math.floor(opts.maxCharsPerLine * 0.45);
  const out: Cue[] = [];
  for (const cue of cues) {
    const previous = out[out.length - 1];
    const text = cue.lines.join(' ');
    const mergeable =
      previous !== undefined &&
      readableLength(text) <= ORPHAN_CHARS &&
      (previous.speaker ?? null) === (cue.speaker ?? null) &&
      cue.endMs - previous.startMs <= opts.maxDurationMs &&
      // Never re-join what a real pause separated. A cue boundary that fell on
      // `gapSplitMs` of silence exists BECAUSE the speaker stopped there, and
      // stitching it back would put a cue on screen across the pause the viewer
      // can hear. This runs before `applyTiming`, so the gap here is still the
      // measured silence between the words and not a value the timing pass
      // manufactured.
      cue.startMs - previous.endMs < opts.gapSplitMs;

    if (mergeable) {
      const words = `${previous.lines.join(' ')} ${text}`.split(/\s+/).filter((w) => w.length > 0);
      if (fitsInLines(words, opts.maxCharsPerLine, opts.maxLines)) {
        out[out.length - 1] = {
          ...previous,
          endMs: cue.endMs,
          lines: layoutLines(words, opts.maxCharsPerLine, opts.maxLines),
        };
        continue;
      }

      /*
        Too big to merge, so rebalance instead.

        The pair is a full cue followed by an orphan, and the two together are
        one word past what a single cue holds. Splitting them evenly gives two
        ordinary cues rather than one crammed one and a flash — which is what a
        subtitler would do by hand.

        The boundary time is interpolated by character count across the pair's
        combined span. That is an estimate, and it is the honest one available:
        by this point the cues carry no per-word timings, and the alternative —
        leaving the orphan alone — is a defect the viewer sees rather than one
        they could measure.
      */
      const rebalanced = splitEvenly(words, opts);
      if (rebalanced !== null) {
        const [head, tail] = rebalanced;
        const span = cue.endMs - previous.startMs;
        const headShare = readableLength(head.join(' '));
        const total = headShare + readableLength(tail.join(' ')) || 1;
        const boundary = previous.startMs + Math.round((headShare / total) * span);
        out[out.length - 1] = { ...previous, endMs: boundary, lines: head };
        out.push({ ...cue, startMs: boundary, lines: tail });
        continue;
      }
    }
    out.push(cue);
  }
  return out;
}

/**
 * Split words into two legal cues as evenly as possible, or `null` if no split
 * makes both halves legal.
 *
 * Walks outwards from the midpoint so the first legal split found is also the
 * most balanced one, and prefers a sentence or clause boundary when one sits
 * within a couple of words of it.
 */
function splitEvenly(
  words: readonly string[],
  opts: SegmentationOptions,
): [string[], string[]] | null {
  const mid = Math.round(words.length / 2);
  const candidates: number[] = [];
  for (let offset = 0; offset < words.length; offset++) {
    for (const index of [mid - offset, mid + offset]) {
      if (index > 0 && index < words.length && !candidates.includes(index)) candidates.push(index);
    }
  }
  // A linguistic break within two words of the middle is worth taking over a
  // marginally more even one that lands mid-phrase.
  candidates.sort((a, b) => {
    const score = (i: number): number => {
      const previous = words[i - 1] ?? '';
      const near = Math.abs(i - mid) <= 2;
      if (near && SENTENCE_END.test(previous)) return -2;
      if (near && CLAUSE_END.test(previous)) return -1;
      return 0;
    };
    return score(a) - score(b) || Math.abs(a - mid) - Math.abs(b - mid);
  });

  for (const index of candidates) {
    const head = words.slice(0, index);
    const tail = words.slice(index);
    if (
      fitsInLines(head, opts.maxCharsPerLine, opts.maxLines) &&
      fitsInLines(tail, opts.maxCharsPerLine, opts.maxLines)
    ) {
      return [layoutLines(head, opts.maxCharsPerLine, opts.maxLines), layoutLines(tail, opts.maxCharsPerLine, opts.maxLines)];
    }
  }
  return null;
}

function applyTiming(cues: Cue[], opts: SegmentationOptions): Cue[] {
  const out = cues.map((cue) => ({ ...cue }));
  for (let i = 0; i < out.length; i++) {
    const cue = out[i];
    if (!cue) continue;
    const chars = readableLength(cue.lines.join(' '));
    const needed = Math.max(
      opts.minDurationMs,
      Math.ceil((chars / opts.maxCharsPerSecond) * 1000),
    );
    if (cue.endMs - cue.startMs < needed) cue.endMs = cue.startMs + needed;
    if (cue.endMs - cue.startMs > opts.maxDurationMs) cue.endMs = cue.startMs + opts.maxDurationMs;
  }
  for (let i = 0; i < out.length - 1; i++) {
    const cue = out[i];
    const next = out[i + 1];
    if (!cue || !next) continue;
    const latestEnd = next.startMs - opts.minGapMs;
    if (cue.endMs > latestEnd) cue.endMs = Math.max(cue.startMs + 1, latestEnd);
  }

  // The media clamp goes LAST, after both the extension pass and the gap pass.
  // Clamping earlier would let the gap pass — which only ever shortens — run on
  // an already-clamped value, and letting the extension pass run afterwards
  // would push the last cue straight back out past the end.
  const limit = opts.mediaDurationMs;
  if (limit === undefined || limit <= 0) return out;
  const clamped: Cue[] = [];
  for (const cue of out) {
    // A cue that begins at or after the end of the media has nothing to show.
    // This only happens when an engine hallucinates a tail segment, which
    // whisper does on trailing silence.
    if (cue.startMs >= limit) continue;
    clamped.push(cue.endMs > limit ? { ...cue, endMs: limit } : cue);
  }
  return clamped;
}

/** `HH:MM:SS,mmm` for SRT, `HH:MM:SS.mmm` for WebVTT. */
export function formatTimestamp(ms: number, separator: ',' | '.'): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(millis, 3)}`;
}

function cueText(cue: Cue, includeSpeakers: boolean): string {
  const lines = [...cue.lines];
  if (includeSpeakers && cue.speaker !== undefined && lines.length > 0) {
    lines[0] = `${cue.speaker}: ${lines[0] ?? ''}`;
  }
  return lines.join('\n');
}

/**
 * SubRip. Cues are numbered from 1, timestamps use a comma before the
 * milliseconds, and the file ends with a trailing blank line — players are
 * forgiving about the last one, but some parsers drop the final cue without it.
 */
export function toSrt(cues: readonly Cue[], options: { includeSpeakers?: boolean } = {}): string {
  const includeSpeakers = options.includeSpeakers ?? false;
  return cues
    .map((cue, index) =>
      [
        String(index + 1),
        `${formatTimestamp(cue.startMs, ',')} --> ${formatTimestamp(cue.endMs, ',')}`,
        cueText(cue, includeSpeakers),
        '',
      ].join('\n'),
    )
    .join('\n');
}

/**
 * WebVTT. The `WEBVTT` header is mandatory; without it browsers reject the file
 * outright. Timestamps use a dot, and cue identifiers are optional — they are
 * emitted anyway so a cue can be referenced from CSS or from an editor.
 */
export function toVtt(cues: readonly Cue[], options: { includeSpeakers?: boolean } = {}): string {
  const includeSpeakers = options.includeSpeakers ?? false;
  const body = cues
    .map((cue, index) =>
      [
        String(index + 1),
        `${formatTimestamp(cue.startMs, '.')} --> ${formatTimestamp(cue.endMs, '.')}`,
        cueText(cue, includeSpeakers),
        '',
      ].join('\n'),
    )
    .join('\n');
  return `WEBVTT\n\n${body}`;
}
