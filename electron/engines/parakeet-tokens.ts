/**
 * Turning `parakeet-cli -ps`'s per-token stderr stream into words and segments.
 *
 * Split out of `parakeet-cpp.ts` for the same reason `whisper-json.ts` was split
 * out of `whisper-cpp.ts`: the runner spawns a child process and asks
 * `binaries-runtime` where the executable lives, which reaches into `electron`.
 * This file reaches into nothing, so both TypeScript projects compile it and its
 * tests need no Electron runtime.
 *
 * The format was measured against the real binary, not remembered — one line per
 * decoded token, on stderr, of the form:
 *
 *     [50] id= 4128 frame=105 dur_idx= 2 dur_val= 2 p=1.0000 plog=-20.8481 t0= 840 t1= 856 word_start=true "_word"
 *
 * (the marker before `word` is U+2581, rendered as an underscore here so this
 * comment stays legible in a terminal that cannot draw it).
 *
 * Three details are easy to get wrong:
 *
 * - **`t0` and `t1` are centiseconds.** The last token of an 8.778 s recording
 *   reported `t1= 856`. Multiply by 10. Whisper, in the file next door, already
 *   reports milliseconds; conflating the two ships subtitles off by a factor of
 *   ten, and the error is invisible on a short test clip.
 * - **`word_start` is authoritative.** Do not infer boundaries from the U+2581
 *   marker or from spaces — a token like `"cri"` continues a word with neither.
 * - **Punctuation is its own token** with `word_start=false` and `t0 === t1`. It
 *   attaches to the word before it rather than becoming a word of its own, which
 *   is what stops a subtitle cue ending on a lone full stop.
 */

import type { Segment, Word } from '../shared/transcript';

/**
 * One `-ps` token line.
 *
 * Written tolerantly on purpose — the columns are space-padded to different
 * widths depending on the magnitude of each number, so every gap is `\s+` and
 * every value is captured rather than positioned.
 */
export const TOKEN_LINE =
  /^\s*\[\s*\d+\]\s+id=\s*(-?\d+)\s+frame=\s*\d+\s+dur_idx=\s*\d+\s+dur_val=\s*\d+\s+p=([\d.]+)\s+plog=(-?[\d.]+)\s+t0=\s*(\d+)\s+t1=\s*(\d+)\s+word_start=(true|false)\s+"(.*)"\s*$/;

/** SentencePiece's word-start marker, U+2581. It is a marker, not a character of the word. */
export const WORD_START_MARKER = '▁';

/** A silence this long between two words starts a new segment. */
export const SEGMENT_GAP_MS = 700;
/** No segment runs longer than this, so a monologue still breaks into readable units. */
export const SEGMENT_MAX_MS = 15_000;

export interface ParakeetToken {
  id: number;
  /** Token probability, 0..1. */
  p: number;
  /** Start, in centiseconds as printed. */
  t0: number;
  /** End, in centiseconds as printed. */
  t1: number;
  wordStart: boolean;
  /** Raw token text, `▁` marker included. */
  text: string;
}

/**
 * One `-ps` line to a token, or `null` for any of the header lines
 * (`parakeet_backend_init*`, `system_info:`, `Processing file:`, `ggml_metal_*`)
 * that share the stream.
 */
export function parseTokenLine(line: string): ParakeetToken | null {
  const match = TOKEN_LINE.exec(line);
  if (!match) return null;
  const [, id, p, , t0, t1, wordStart, text] = match;
  if (id === undefined || p === undefined || t0 === undefined || t1 === undefined || wordStart === undefined || text === undefined) {
    return null;
  }
  return {
    id: Number.parseInt(id, 10),
    p: Number.parseFloat(p),
    t0: Number.parseInt(t0, 10),
    t1: Number.parseInt(t1, 10),
    wordStart: wordStart === 'true',
    text,
  };
}

/**
 * Tokens → words.
 *
 * `word_start` opens a word; every following token appends to it until the next
 * one. A word's confidence is the MINIMUM probability across its tokens: a word
 * is only as trustworthy as its least certain piece, and averaging would hide a
 * 0.3 syllable behind three 1.0 ones.
 */
export function tokensToWords(tokens: readonly ParakeetToken[]): Word[] {
  const words: Word[] = [];
  let current: { text: string; startCs: number; endCs: number; minP: number } | null = null;

  const flush = (): void => {
    if (!current) return;
    const text = current.text.trim();
    if (text.length > 0) {
      words.push({
        text,
        startMs: current.startCs * 10,
        endMs: Math.max(current.endCs * 10, current.startCs * 10),
        confidence: current.minP,
      });
    }
    current = null;
  };

  for (const token of tokens) {
    const piece = token.text.split(WORD_START_MARKER).join('');
    if (token.wordStart || current === null) {
      flush();
      current = { text: piece, startCs: token.t0, endCs: token.t1, minP: token.p };
      continue;
    }
    current.text += piece;
    current.endCs = Math.max(current.endCs, token.t1);
    current.minP = Math.min(current.minP, token.p);
  }
  flush();
  return words;
}

/**
 * Words → segments.
 *
 * Parakeet reports no segmentation of its own, so one is derived from silence
 * and from length. These are NOT subtitle cues — `resegment()` builds those
 * later against the user's line-length and reading-speed settings. What this
 * produces is the utterance-sized unit the transcript model expects, and the
 * unit a reader sees in the TXT and Markdown exports.
 */
export function wordsToSegments(words: readonly Word[]): Segment[] {
  const segments: Segment[] = [];
  let bucket: Word[] = [];

  const flush = (): void => {
    if (bucket.length === 0) return;
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    if (first && last) {
      segments.push({
        startMs: first.startMs,
        endMs: last.endMs,
        text: bucket.map((w) => w.text).join(' '),
        words: [...bucket],
      });
    }
    bucket = [];
  };

  for (const word of words) {
    const previous = bucket[bucket.length - 1];
    const start = bucket[0]?.startMs;
    if (previous && start !== undefined) {
      const gap = word.startMs - previous.endMs;
      if (gap >= SEGMENT_GAP_MS || word.endMs - start > SEGMENT_MAX_MS) flush();
    }
    bucket.push(word);
  }
  flush();
  return segments;
}
