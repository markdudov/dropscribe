/**
 * `whisper-cli` from whisper.cpp b4938, wrapped into a `LocalEngine`.
 *
 * The binary is driven in file mode rather than through stdin: it is handed a
 * WAV path and an output base path, it writes `<base>.json`, we read that file
 * and delete it. Streaming its stdout instead would have avoided the temp file,
 * but whisper's textual stdout carries no token probabilities and rounds its
 * timestamps to centiseconds — the JSON is the only place the per-token `p` and
 * the millisecond offsets exist, and both are what make word-level subtitles
 * possible downstream.
 *
 * Everything about the JSON shape and the flag set below was measured by
 * running this exact binary on this machine. In particular: `offsets.from` and
 * `offsets.to` are ALREADY integer milliseconds. Older whisper.cpp wrappers
 * multiply by 10 because they are reading `t0`/`t1`, which are centiseconds.
 * Doing that here shifts every cue ten-fold; do not "fix" it.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { binaryPath } from '../binaries-runtime';
import type { Segment, Transcript, Word } from '../shared/transcript';
import { normalizeTranscript } from '../shared/transcript';
import type { LocalEngine, LocalRunContext, LocalRunRequest } from './types';

/** `whisper_print_progress_callback: progress =  42%` — always on stderr, never stdout. */
const PROGRESS_LINE = /progress\s*=\s*(\d+)\s*%/;

/**
 * Special tokens whisper emits alongside real text: `[_BEG_]`, `[_TT_123]`,
 * and the annotations `[BLANK_AUDIO]` / `[MUSIC]`. Anything wholly wrapped in
 * brackets is dropped. That does discard the audio-event annotations some users
 * like, but they carry no useful timing of their own and would otherwise be
 * glued onto the next real word by the merge below.
 */
const BRACKETED = /^\[.*\]$/;

/**
 * How much stderr travels with a failure. Enough to hold whisper's own error
 * plus the model-load banner above it, small enough to paste into an issue.
 */
const STDERR_TAIL_LINES = 40;

/**
 * A word is finished when the accumulated text ends a sentence, because the
 * token after a full stop frequently arrives without the leading space that
 * normally marks a word boundary.
 *
 * The known cost is decimals: `3` + `.` + `14` becomes `3.` and `14`. Requiring
 * the next token to look like a new sentence would fix that and break on
 * languages that do not capitalise, so the cheap rule wins.
 */
const SENTENCE_END = /[.!?…。！？][)"'”’\]]?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

/** `offsets` on a segment or a token. Already integer milliseconds — see the file header. */
function readOffsets(owner: Record<string, unknown>): { from: number; to: number } | null {
  const offsets = owner['offsets'];
  if (!isRecord(offsets)) return null;
  const from = readNumber(offsets, 'from');
  const to = readNumber(offsets, 'to');
  if (from === null || to === null) return null;
  return { from, to };
}

interface LineSink {
  push(chunk: string): void;
  /** Emits whatever is left when the stream closes without a final newline. */
  flush(): void;
}

function lineSink(onLine: (line: string) => void): LineSink {
  let buffer = '';
  return {
    push(chunk: string): void {
      buffer += chunk;
      // Split on \r as well as \n: whisper redraws its progress line with a
      // bare carriage return on some builds, and a reader that only knows \n
      // would hold the entire run in one unterminated "line".
      const parts = buffer.split(/\r\n|[\r\n]/);
      buffer = parts.pop() ?? '';
      for (const part of parts) onLine(part);
    },
    flush(): void {
      if (buffer.length > 0) {
        onLine(buffer);
        buffer = '';
      }
    },
  };
}

function decodeChunk(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  return Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
}

/**
 * `0` in settings means "choose for me". whisper.cpp's own default is a flat 4
 * regardless of the machine, which leaves an M-series laptop idle; the cap at 8
 * is there because past the performance-core count the efficiency cores join in
 * and the run gets *slower*, not faster.
 */
function resolveThreads(requested: number): number {
  if (Number.isFinite(requested) && requested >= 1) return Math.floor(requested);
  const detected = cpus().length;
  return Math.max(1, Math.min(8, detected > 0 ? detected : 4));
}

/**
 * `name` is `AbortError`, the platform convention, so the queue can tell a
 * cancellation from a failure without string-matching the message.
 */
function cancelledError(): Error {
  const error = new Error('Transcription cancelled.');
  error.name = 'AbortError';
  return error;
}

function isSpecialToken(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return BRACKETED.test(trimmed) || trimmed.startsWith('[_');
}

interface PendingWord {
  text: string;
  startMs: number;
  endMs: number;
  /** Lowest `p` seen so far, or `null` when no token carried one. */
  weakest: number | null;
}

/**
 * Merge whisper's sub-word tokens into words.
 *
 * whisper tokenises `" transcription"` as `" trans"` + `"cription"`, and the
 * leading space is part of the token text — that space is the entire word
 * boundary signal, which is why the raw text is inspected before trimming.
 */
function wordsFromTokens(tokens: readonly unknown[]): Word[] {
  const words: Word[] = [];
  let pending: PendingWord | null = null;
  let boundaryPending = false;

  const flush = (): void => {
    if (pending === null) return;
    const text = pending.text.trim();
    if (text.length > 0) {
      words.push({
        text,
        startMs: pending.startMs,
        endMs: Math.max(pending.endMs, pending.startMs),
        // MINIMUM, not mean: a word is only as trustworthy as its worst token.
        // Averaging lets three confident sub-word tokens hide the one the model
        // was guessing at, and it is precisely that word a reviewer needs to see
        // flagged.
        ...(pending.weakest !== null ? { confidence: pending.weakest } : {}),
      });
    }
    pending = null;
  };

  for (const token of tokens) {
    if (!isRecord(token)) continue;
    const raw = readString(token, 'text');
    if (raw === null || isSpecialToken(raw)) continue;
    if (raw.trim().length === 0) {
      // A whitespace-only token carries no text but still separates words, so
      // remember the boundary for the next token that does have some.
      boundaryPending = true;
      continue;
    }
    const offsets = readOffsets(token);
    if (offsets === null) continue;

    const startsWord =
      pending === null || boundaryPending || /^\s/.test(raw) || SENTENCE_END.test(pending.text.trimEnd());
    if (startsWord) flush();
    boundaryPending = false;

    const probability = readNumber(token, 'p');
    if (pending === null) {
      pending = { text: raw, startMs: offsets.from, endMs: offsets.to, weakest: probability };
    } else {
      pending.text += raw;
      pending.endMs = Math.max(pending.endMs, offsets.to);
      pending.weakest =
        probability === null
          ? pending.weakest
          : pending.weakest === null
            ? probability
            : Math.min(pending.weakest, probability);
    }
  }

  flush();
  return words;
}

function segmentsFromJson(root: Record<string, unknown>): Segment[] {
  const raw = root['transcription'];
  if (!Array.isArray(raw)) return [];

  const segments: Segment[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const tokens = entry['tokens'];
    const words = Array.isArray(tokens) ? wordsFromTokens(tokens) : [];
    const offsets = readOffsets(entry);
    const first = words[0];
    const last = words[words.length - 1];

    // `-ojf` is what puts `tokens` in the file. If a future build drops it the
    // segment text is still usable, just not word-timed, so fall back rather
    // than throwing away the transcription.
    const text = (readString(entry, 'text') ?? '').trim() || words.map((w) => w.text).join(' ');
    if (text.length === 0) continue;
    // whisper marks a stretch of silence with a segment whose entire text is
    // `[BLANK_AUDIO]` and whose only token was dropped above. Keeping it would
    // put a subtitle on screen that reads "[BLANK_AUDIO]" during the silence,
    // which is worse than no cue at all — and worse than the gap it describes.
    if (words.length === 0 && BRACKETED.test(text)) continue;

    const startMs = offsets?.from ?? first?.startMs ?? 0;
    const endMs = offsets?.to ?? last?.endMs ?? startMs;
    segments.push({ startMs, endMs, text, words });
  }
  return segments;
}

/**
 * `result.language` is the language whisper actually decoded in, which is the
 * detected one when `-l auto` was passed and the requested one otherwise.
 * `auto` and `und` are echoes, not detections, so they become `null` — the
 * transcript contract is explicit that a language is never invented.
 */
function languageFromJson(root: Record<string, unknown>): string | null {
  const result = root['result'];
  if (!isRecord(result)) return null;
  const language = (readString(result, 'language') ?? '').trim().toLowerCase();
  if (language.length === 0 || language === 'auto' || language === 'und') return null;
  return language;
}

/**
 * The engine is given a model *path*, not a catalogue id, because it is the
 * path that whisper is handed. The file stem is therefore the most honest
 * identifier available here; `queue.ts` is free to overwrite the label with the
 * catalogue entry's once it has mapped the file back to a `LocalModel`.
 */
function modelIdentity(modelPath: string): { modelId: string; label: string } {
  const stem = basename(modelPath).replace(/\.(bin|gguf)$/i, '');
  return { modelId: stem, label: `Whisper ${stem.replace(/^ggml-/, '')} (local)` };
}

/**
 * A failure to even start the child. `enginesReady()` is supposed to catch a
 * missing binary long before a job runs, so reaching here means the install was
 * damaged after that check or Gatekeeper quarantined the file. Either way the
 * raw `spawn ENOENT` — which names an internal path and reads like a crash — is
 * not what the user should see.
 */
function startupError(cause: unknown): Error {
  return new Error(
    'The local Whisper engine could not be started. Its bundled `whisper-cli` is missing or was blocked by the ' +
      'system; reinstalling DropScribe restores it.',
    { cause },
  );
}

async function run(request: LocalRunRequest, ctx: LocalRunContext): Promise<Transcript> {
  if (ctx.signal.aborted) throw cancelledError();

  // `-of` takes a base path and whisper appends `.json`. It goes in the system
  // temp directory rather than beside the media: the source may sit on a
  // read-only mount or a network share, and a failed run must not leave a
  // stray file in the user's movie folder.
  const outBase = join(tmpdir(), `dropscribe-whisper-${randomUUID()}`);
  const jsonPath = `${outBase}.json`;

  const args = [
    '-m', request.modelPath,
    '-f', request.wavPath,
    '-oj',            // write JSON
    '-ojf',           // ...with per-token entries; this is where `p` comes from
    '-of', outBase,
    '-np',            // no banner or per-segment echo; progress still reaches stderr
    '-pp',            // print progress, which is the only progress signal there is
    '-t', String(resolveThreads(request.threads)),
    '-l', request.language ?? 'auto',
  ];
  // `-tr` makes whisper decode into English instead of the spoken language.
  if (request.translate) args.push('-tr');

  const child = spawn(binaryPath('whisper-cli'), args, { windowsHide: true });
  // Nothing is ever written to the child: close stdin so a build that decides
  // to read from it fails fast instead of hanging the job forever.
  child.stdin.end();

  const stderrTail: string[] = [];
  let lastPercent = -1;

  const stderrLines = lineSink((line) => {
    const match = PROGRESS_LINE.exec(line);
    if (match?.[1] !== undefined) {
      const percent = Math.min(100, Math.max(0, Number(match[1])));
      // whisper repeats the same percentage for every decode window of a long
      // file; only forward movement is worth an IPC round trip.
      if (percent > lastPercent) {
        lastPercent = percent;
        ctx.onProgress(percent);
      }
      // Progress lines are deliberately kept out of the tail. A run that fails
      // after twenty minutes has thousands of them, and they would push the one
      // line that explains the failure out of the buffer.
      return;
    }
    stderrTail.push(line);
    if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: unknown) => stderrLines.push(decodeChunk(chunk)));
  // stdout is drained but ignored: with `-np` it holds nothing the JSON does not.
  child.stdout.resume();

  let killTimer: NodeJS.Timeout | null = null;
  let killedByUs = false;
  const onAbort = (): void => {
    killedByUs = true;
    child.kill('SIGTERM');
    // whisper only notices a signal between decode windows, and one window of a
    // large model can run for several seconds. Escalate rather than leave a
    // process holding 1.8 GB after the user pressed cancel.
    killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
    killTimer.unref();
  };
  ctx.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const exit = await new Promise<{ code: number | null; signalName: string | null }>((resolve, reject) => {
      child.once('error', (cause: unknown) => reject(startupError(cause)));
      // `close` rather than `exit`, so stderr has been fully flushed and the
      // tail actually contains the reason the process died.
      child.once('close', (code, signalName) => resolve({ code, signalName }));
    });
    stderrLines.flush();

    if (killedByUs || ctx.signal.aborted) throw cancelledError();

    const tail = stderrTail.join('\n');
    if (exit.code !== 0) {
      if (exit.code === null) {
        throw new Error(
          `Whisper was stopped by the system (${exit.signalName ?? 'unknown signal'}). ` +
            'On most machines that means it ran out of memory — a quantized model needs about a third as much.',
          { cause: tail },
        );
      }
      throw new Error(
        `Whisper stopped before it finished (exit code ${exit.code}). ` +
          'A corrupt model file is the usual cause; re-downloading the model in Settings fixes it.',
        { cause: tail },
      );
    }

    let raw: string;
    try {
      raw = await readFile(jsonPath, 'utf8');
    } catch (cause) {
      throw new Error('Whisper finished but wrote no transcript file.', { cause: tail || cause });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new Error('Whisper wrote a transcript this build cannot read.', { cause });
    }
    if (!isRecord(parsed)) throw new Error('Whisper wrote a transcript this build cannot read.', { cause: tail });

    if (lastPercent < 100) ctx.onProgress(100);

    return normalizeTranscript({
      language: languageFromJson(parsed),
      durationMs: request.durationMs,
      segments: segmentsFromJson(parsed),
      source: { kind: 'local', engineId: 'whisper-cpp', ...modelIdentity(request.modelPath) },
      createdAt: new Date().toISOString(),
    });
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
    if (killTimer !== null) clearTimeout(killTimer);
    // `force` so a run that died before writing anything reports its real error
    // instead of an ENOENT from the cleanup.
    await rm(jsonPath, { force: true }).catch(() => undefined);
  }
}

export const whisperEngine: LocalEngine = { id: 'whisper-cpp', run };
