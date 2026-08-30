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

export interface TimedWord {
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

/**
 * The most evenly balanced way to cut `words` into exactly `lineCount`
 * contiguous lines, none longer than `maxCharsPerLine`. `null` when there is no
 * such cut.
 *
 * The objective is unchanged from the version this replaced — minimise
 * `max(length) - min(length)` across the lines — and so is every result. What
 * changed is that the search used to build EVERY partition and check the
 * line-length constraint only at the leaves.
 *
 * That is fine at the default two lines, where the search is linear, and the
 * comment on `layoutLines` said as much: "a cue is a couple of dozen words at
 * most". The Output tab offers six lines and thirty seconds a cue, and at those
 * settings a cue holds enough words to genuinely need all six — so every n fails
 * and n = 6 enumerates C(41,5) ≈ 750 000 partitions, allocating an array at each
 * node. Measured: 842 ms for one cue, and over two minutes of frozen main
 * process for a four-hour recording, since `writeAutoExports` runs on it at the
 * end of every job.
 *
 * Three changes, none of which touch what is returned:
 *
 * - the running line length is carried down instead of being rebuilt with
 *   `slice().join()` at every node;
 * - a line is abandoned the moment it passes `maxCharsPerLine`, rather than at
 *   the leaf. This is the one that matters: it caps the branching factor at the
 *   number of words that fit on a line, so the tree stops being a function of
 *   the cue's length;
 * - a starting point that cannot be completed is remembered, so no dead end is
 *   explored twice.
 */
function balancedSplit(words: string[], lineCount: number, maxCharsPerLine: number): string[] | null {
  let bestLines: string[] | null = null;
  let bestSpread = Number.POSITIVE_INFINITY;
  /** `index * (lineCount + 1) + remaining` for starts already known to be hopeless. */
  const hopeless = new Set<number>();

  const walk = (index: number, taken: string[], remaining: number): boolean => {
    if (remaining === 0) {
      if (index !== words.length) return false;
      const lengths = taken.map((line) => line.length);
      const spread = Math.max(...lengths) - Math.min(...lengths);
      if (spread < bestSpread) {
        bestSpread = spread;
        bestLines = [...taken];
      }
      return true;
    }

    const key = index * (lineCount + 1) + remaining;
    if (hopeless.has(key)) return false;

    let completed = false;
    let line = '';
    // Leave at least one word for each remaining line.
    for (let end = index; end <= words.length - remaining; end++) {
      const word = words[end];
      if (word === undefined) break;
      line = line.length === 0 ? word : `${line} ${word}`;
      // Every longer prefix is longer still, so there is nothing further along
      // this branch. Before, the whole subtree below here was explored anyway.
      if (line.length > maxCharsPerLine) break;
      taken.push(line);
      if (walk(end + 1, taken, remaining - 1)) completed = true;
      taken.pop();
    }

    if (!completed) hopeless.add(key);
    return completed;
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
/**
 * Give a run of words that share one timestamp somewhere to sit.
 *
 * A recogniser is allowed to be unsure where a word falls, and whisper's DTW
 * alignment collapses outright on highly repetitive audio: a 110-second
 * recording of one sentence repeated sixty times came back with thirty-two of
 * its sixty words carrying `startMs === endMs`, and twelve consecutive words
 * carrying the SAME instant. Every timing rule below is written for words that
 * advance; handed a stack of them, the gap pass produced one-millisecond cues
 * with identical intervals (docs/bugs/0004).
 *
 * The repair is at the boundary, on purpose, and not in the rules. Once the
 * words advance again, `minDurationMs`, the reading-speed floor and the gap
 * pass all do exactly what they were written to do — where patching each rule
 * to tolerate stacked input would mean three places that have to keep agreeing
 * about a case none of them is really about.
 *
 * A run is spread across the space up to the next word that carries a different
 * start, or to `fallbackEndMs` when the run reaches the end. Runs with no space
 * at all are left alone: there is nothing to spread them over, and inventing a
 * span would move subtitles away from the audio to satisfy a rule. The timing
 * pass is what catches that remainder.
 */
export function spreadCollapsedRuns(
  words: readonly TimedWord[],
  fallbackEndMs: number,
): TimedWord[] {
  const out = words.map((word) => ({ ...word }));
  let index = 0;
  while (index < out.length) {
    const head = out[index];
    if (!head) break;
    let last = index;
    while (last + 1 < out.length && out[last + 1]?.startMs === head.startMs) last += 1;
    const runLength = last - index + 1;
    if (runLength > 1) {
      const after = out[last + 1];
      const until = after === undefined ? fallbackEndMs : after.startMs;
      const span = until - head.startMs;
      // One millisecond per word is the least that can still be told apart
      // after rounding. Below that the run genuinely occupies no time and is
      // left as it is.
      if (span >= runLength) {
        const step = span / runLength;
        for (let k = 0; k < runLength; k += 1) {
          const word = out[index + k];
          if (!word) continue;
          word.startMs = Math.round(head.startMs + step * k);
          word.endMs = Math.round(head.startMs + step * (k + 1));
        }
      }
    }
    index = last + 1;
  }
  return out;
}

export function resegment(
  segments: readonly { startMs: number; endMs: number; text: string; words: readonly TimedWord[]; speaker?: string }[],
  options: Partial<SegmentationOptions> = {},
): Cue[] {
  const opts: SegmentationOptions = { ...DEFAULT_SEGMENTATION, ...options };
  const budget = opts.maxCharsPerLine * opts.maxLines;
  // Before anything reads a timestamp. See `spreadCollapsedRuns`.
  //
  // A run that reaches the end of its segment is spread into what comes after
  // it rather than into the segment's own last few milliseconds. When whisper
  // stacks twenty-five words on the final instant of a segment, the segment end
  // leaves eighty milliseconds for all of them; the next segment does not start
  // for another half minute, and that gap is silence the words can be shown
  // over. Using `segment.endMs` there is technically tidy and produces
  // three-millisecond cues.
  const repaired = segments.map((segment, index) => {
    const next = segments[index + 1];
    const room = next?.startMs ?? options.mediaDurationMs ?? segment.endMs;
    return {
      ...segment,
      words: spreadCollapsedRuns(segment.words, Math.max(segment.endMs, room)),
    };
  });

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

  for (const segment of repaired) {
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
        else if (wouldNotFit || wouldOverrunTime) {
          flushAtBestBreak();
          // Ask again. `flushAtBestBreak` chooses where to break by language,
          // not by what will fit afterwards, and it carries the rest of the cue
          // over — so the carried words plus this one can still need more lines
          // than a cue has. Asking once was bug 0003's fix answering only half
          // the question; this is the other half, and without it the shipped
          // defaults draw a third line on roughly one cue in seventy.
          if (
            pending.length > 0 &&
            !fitsInLines([...pending, word].map((w) => w.text), opts.maxCharsPerLine, opts.maxLines)
          ) {
            flush();
          }
        }
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
  /** What one cue needs to be readable at all: the floor nothing may trade away. */
  const floorFor = (cue: Cue): number =>
    Math.max(
      opts.minDurationMs,
      Math.ceil((readableLength(cue.lines.join(' ')) / opts.maxCharsPerSecond) * 1000),
    );
  const needed = out.map(floorFor);
  for (let i = 0; i < out.length; i++) {
    const cue = out[i];
    const floor = needed[i];
    if (!cue || floor === undefined) continue;
    if (cue.endMs - cue.startMs < floor) cue.endMs = cue.startMs + floor;
    if (cue.endMs - cue.startMs > opts.maxDurationMs) cue.endMs = cue.startMs + opts.maxDurationMs;
  }
  // Shorten a cue that would run into the next one. When the next cue genuinely
  // comes later, the gap wins over the floor — that is deliberate and pinned by
  // a test: a cue whose neighbour starts 900 ms later is trimmed rather than
  // allowed to overlap it.
  //
  // What is NOT deliberate, and is where the collapsed-timestamp bug lived, is
  // what this used to do when the next cue starts at or BEFORE this one. There
  // is no gap to honour in that case; `latestEnd` lands before this cue even
  // begins, and the old `Math.max(cue.startMs + 1, latestEnd)` floor crushed a
  // cue that had just been widened to a readable second back down to one
  // millisecond. One millisecond does not render. The cue keeps its floor, and
  // the pass below moves the next one out of its way.
  for (let i = 0; i < out.length - 1; i++) {
    const cue = out[i];
    const next = out[i + 1];
    const floor = needed[i];
    if (!cue || !next || floor === undefined) continue;
    const latestEnd = next.startMs - opts.minGapMs;
    if (cue.endMs > latestEnd) {
      cue.endMs = latestEnd > cue.startMs ? latestEnd : cue.startMs + floor;
    }
  }
  // Which can leave a cue ending after the next one starts, so the next one
  // moves. Moving a cue later keeps it readable and keeps it in order; the two
  // alternatives are crushing it, which is what this bug was, and dropping it,
  // which loses the words. Anything pushed past the media is cut by the clamp
  // below, and the words at the very end of a collapsed run are the ones the
  // engine was least sure about in the first place.
  for (let i = 1; i < out.length; i++) {
    const previous = out[i - 1];
    const cue = out[i];
    if (!previous || !cue) continue;
    const earliestStart = previous.endMs + opts.minGapMs;
    if (cue.startMs < earliestStart) {
      const duration = cue.endMs - cue.startMs;
      cue.startMs = earliestStart;
      cue.endMs = earliestStart + duration;
    }
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

  // What the clamp leaves behind. A sign-off that lands in the last fraction of
  // a second keeps its start and has its end cut to the media end, and comes
  // out too short to read — 120 ms, against a configured floor of a second.
  //
  // The floor cannot be met by moving the end; there is nothing after the end.
  // It can be met by moving the START earlier, into silence the cue is not
  // competing with anything for, which is what a subtitler does. The previous
  // cue's end plus the minimum gap is the limit, and zero when there is no
  // previous cue.
  for (let i = 0; i < clamped.length; i++) {
    const cue = clamped[i];
    if (!cue) continue;
    const floor = floorFor(cue);
    if (cue.endMs - cue.startMs >= floor) continue;
    const previous = clamped[i - 1];
    const earliest = previous === undefined ? 0 : previous.endMs + opts.minGapMs;
    cue.startMs = Math.max(earliest, cue.endMs - floor);
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
