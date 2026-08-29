/**
 * `parakeet-cli` from whisper.cpp b4938, wrapped into a `LocalEngine`.
 *
 * The binary looks impoverished next to `whisper-cli` — its whole option set is
 * `-t/--threads`, `-m/--model`, `-f/--file`, `-ng/--no-gpu`, `-dev/--device`,
 * `-ps/--print-segments`, `-otxt`, `-of` and `-np`, with no JSON writer, no
 * language flag and no progress callback. But `-ps` turns out to print, on
 * **stderr**, one line per decoded token carrying everything this adapter
 * needs:
 *
 *     [50] id= 4128 frame=105 dur_idx= 2 dur_val= 2 p=1.0000 plog=-20.8481 t0= 840 t1= 856 word_start=true "▁word"
 *
 * That is richer than the human-readable `[00:00.000 --> 00:05.040] text`
 * segment form, and it is what this file parses. Three details in it are easy
 * to get wrong and each was measured against the real binary (see
 * `docs/engines/verification.md`):
 *
 * - **`t0` and `t1` are centiseconds**, not milliseconds and not seconds. The
 *   last token of an 8.778 s recording reported `t1= 856`. Multiply by 10.
 * - **`word_start` is authoritative.** Do not infer word boundaries from the
 *   `▁` marker alone, and do not infer them from spaces — a token like `"cri"`
 *   continues the previous word with neither.
 * - **Punctuation is its own token** with `word_start=false` and `t0 == t1`.
 *   It attaches to the preceding word rather than becoming a word of its own,
 *   which is what keeps a subtitle from ending on a lone full stop.
 *
 * Parakeet v3 is transcribe-only and detects its own language, so
 * `request.language` and `request.translate` are ignored. Silently ignoring a
 * flag is normally a bug; here it is the honest behaviour, because the
 * alternative — failing a queued job because a global setting says "translate"
 * — punishes the user for a model capability they did not choose. The UI
 * disables both toggles while a Parakeet model is selected, so the ignored
 * value is never one the user set with this engine in mind.
 */

import { spawn } from 'node:child_process';
import { cpus } from 'node:os';

import { binaryPath } from '../binaries-runtime';
import type { Segment, Transcript, Word } from '../shared/transcript';
import { normalizeTranscript } from '../shared/transcript';
import type { LocalEngine, LocalRunContext, LocalRunRequest } from './types';

/**
 * One `-ps` token line.
 *
 * Written tolerantly on purpose — the columns are space-padded to different
 * widths depending on the magnitude of each number, so every gap is `\s+` and
 * every value is captured rather than positioned.
 */
const TOKEN_LINE =
  /^\s*\[\s*\d+\]\s+id=\s*(-?\d+)\s+frame=\s*\d+\s+dur_idx=\s*\d+\s+dur_val=\s*\d+\s+p=([\d.]+)\s+plog=(-?[\d.]+)\s+t0=\s*(\d+)\s+t1=\s*(\d+)\s+word_start=(true|false)\s+"(.*)"\s*$/;

/** SentencePiece's word-start marker, U+2581. It is a marker, not a character of the word. */
const WORD_START_MARKER = '▁';

/** A silence this long between two words starts a new segment. */
const SEGMENT_GAP_MS = 700;
/** No segment runs longer than this, so a monologue still breaks into readable units. */
const SEGMENT_MAX_MS = 15_000;

const STDERR_TAIL_LINES = 40;

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

/** `Math.max(1, min(8, cores - 2))` — see the note in the queue about leaving cores for the UI. */
function resolveThreads(requested: number): number {
  if (requested > 0) return requested;
  return Math.max(1, Math.min(8, cpus().length - 2));
}

async function run(request: LocalRunRequest, ctx: LocalRunContext): Promise<Transcript> {
  const args = [
    '-m', request.modelPath,
    '-f', request.wavPath,
    '-ps',
    '-np',
    '-t', String(resolveThreads(request.threads)),
  ];

  const tokens: ParakeetToken[] = [];
  const stderrTail: string[] = [];
  let stdout = '';
  let stderrCarry = '';

  const child = spawn(binaryPath('parakeet-cli'), args, { stdio: ['ignore', 'pipe', 'pipe'] });

  /**
   * Parakeet prints no progress at all, so the bar is driven by elapsed time
   * against a measured real-time factor. It is an estimate and it is capped
   * below 100 %: a bar that sits at 100 % while the process is still working
   * reads as a hang, and one that jumps backwards reads as a failure.
   */
  const startedAt = Date.now();
  const assumedRtf = process.platform === 'darwin' ? 20 : 6;
  const ticker = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    const expected = request.durationMs / assumedRtf;
    if (expected <= 0) return;
    ctx.onProgress(Math.min(95, Math.round((elapsed / expected) * 100)));
  }, 500);

  const onAbort = (): void => {
    child.kill('SIGKILL');
  };
  ctx.signal.addEventListener('abort', onAbort, { once: true });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    // Token lines arrive split across chunk boundaries; hold the partial line.
    stderrCarry += chunk;
    const lines = stderrCarry.split('\n');
    stderrCarry = lines.pop() ?? '';
    for (const line of lines) {
      const token = parseTokenLine(line);
      if (token) {
        tokens.push(token);
        continue;
      }
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    }
  });

  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve(exitCode ?? -1));
    });

    const trailing = parseTokenLine(stderrCarry);
    if (trailing) tokens.push(trailing);

    if (ctx.signal.aborted) {
      const error = new Error('Transcription was cancelled.');
      error.name = 'AbortError';
      throw error;
    }
    if (code !== 0) {
      throw new Error(`Parakeet could not transcribe this file (exit code ${code}).`, {
        cause: stderrTail.join('\n'),
      });
    }

    const words = tokensToWords(tokens);
    const segments = words.length > 0
      ? wordsToSegments(words)
      // No tokens at all means `-ps` gave us nothing — an older build, or a
      // change upstream. The plain transcript is still on stdout, so fall back
      // to one segment spanning the file rather than losing the transcription.
      : fallbackSegments(stdout, request.durationMs);

    ctx.onProgress(100);

    return normalizeTranscript({
      // Parakeet reports no language. Leaving this null is the honest answer;
      // guessing from the text would put a wrong flag next to a good transcript.
      language: null,
      durationMs: request.durationMs,
      segments,
      source: {
        kind: 'local',
        engineId: 'parakeet-cpp',
        modelId: request.modelPath,
        label: 'Parakeet TDT 0.6B v3 (local)',
      },
      createdAt: new Date().toISOString(),
    });
  } finally {
    clearInterval(ticker);
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

function fallbackSegments(stdout: string, durationMs: number): Segment[] {
  const text = stdout.trim();
  if (text.length === 0) return [];
  return [{ startMs: 0, endMs: durationMs, text, words: [] }];
}

export const parakeetEngine: LocalEngine = {
  id: 'parakeet-cpp',
  run,
};
