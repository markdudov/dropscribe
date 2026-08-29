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

  for (const segment of segments) {
    const words: TimedWord[] = segment.words.length > 0
      ? segment.words.map((w) => ({ ...w, ...(w.speaker ?? segment.speaker ? { speaker: w.speaker ?? segment.speaker } : {}) }))
      : interpolateWords(segment.text, segment.startMs, segment.endMs, segment.speaker);

    for (const word of words) {
      const previous = pending[pending.length - 1];
      if (previous) {
        const gap = word.startMs - previous.endMs;
        const speakerChanged = (previous.speaker ?? null) !== (word.speaker ?? null);
        const wouldOverrunChars = readableLength([...pending, word].map((w) => w.text).join(' ')) > budget;
        const start = pending[0]?.startMs ?? word.startMs;
        const wouldOverrunTime = word.endMs - start > opts.maxDurationMs;
        if (gap >= opts.gapSplitMs || speakerChanged || wouldOverrunChars || wouldOverrunTime) flush();
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

  return applyTiming(cues, opts);
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
