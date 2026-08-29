/**
 * Everything the app asks of ffmpeg and ffprobe.
 *
 * Three jobs, and no fourth: measure a file, turn it into the one WAV shape
 * both local engines accept, and squeeze it small enough to upload. Every
 * other module talks to media through this one, which is what keeps the
 * "which exact flags did we use?" question answerable.
 *
 * Two rules run through the whole file.
 *
 * **Arguments are always an array.** Never a shell string, not once, not for
 * "just a quick probe". Films are called `Mötley Crüe – Live '87 (1080p).mkv`
 * and live in `/Volumes/My Passport/Films & TV/`; a shell string turns that
 * into a quoting bug on a good day and an injection on a bad one. `spawn` with
 * an array hands the bytes to `execve` untouched.
 *
 * **Every child is tracked.** A 3-hour extraction is a process that will
 * happily keep running after its window is gone. The module-level registry
 * below exists so quitting the app takes them with it — an orphaned ffmpeg
 * pegging a core with no UI to stop it is the kind of bug users report as
 * "your app broke my laptop".
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { app } from 'electron';
import { binaryPath, type BinaryName } from './binaries-runtime';

export interface MediaInfo {
  durationMs: number;
  hasAudio: boolean;
  sampleRate: number | null;
  channels: number | null;
  codec: string | null;
  bytes: number;
}

/**
 * How long a cancelled child gets to exit politely before it is killed.
 *
 * ffmpeg handles SIGTERM by closing the output file, which is what we want —
 * a half-written WAV with no header is worse than none. Two seconds is far
 * more than closing a file takes and short enough that a user who hit Cancel
 * does not wonder whether the button worked.
 */
const SIGKILL_GRACE_MS = 2000;

/** How much stderr to keep. An ffmpeg failure is always in the last few lines. */
const STDERR_TAIL_BYTES = 8000;

// ── Child process registry ──────────────────────────────────────────────────

const running = new Map<number, ChildProcess>();
let nextChildId = 1;
let quitHookInstalled = false;

function killAllChildren(): void {
  for (const child of running.values()) {
    try {
      // No grace period here: the app is going away, and a `will-quit` handler
      // that waits is a beachball. `taskkill /T /F` is not needed on Windows —
      // ffmpeg spawns no children of its own, and we hold the handle, so
      // `TerminateProcess` on this pid is the whole tree.
      if (process.platform === 'win32') child.kill();
      else child.kill('SIGKILL');
    } catch {
      /* Already dead. Nothing to do and nothing worth logging. */
    }
  }
  running.clear();
}

/**
 * Installed on first spawn rather than at import time, because importing this
 * module must stay free of side effects for the unit tests — and because
 * `app` is undefined when a test imports it outside Electron at all.
 */
function ensureQuitHook(): void {
  if (quitHookInstalled) return;
  quitHookInstalled = true;
  if (typeof app === 'object' && app !== null && typeof app.once === 'function') {
    app.once('will-quit', killAllChildren);
  }
  // The backstop for the paths `will-quit` never reaches: a crash in main, or
  // `process.exit()` from an updater. Sending a signal is a synchronous
  // syscall, which is all an `exit` handler is allowed to do.
  process.once('exit', killAllChildren);
}

// ── Spawning ────────────────────────────────────────────────────────────────

interface RunOptions {
  signal?: AbortSignal;
  /** When present, stdout is streamed here and not retained. */
  onStdout?: (chunk: string) => void;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * An error shaped like the platform's own cancellation error.
 *
 * `name === 'AbortError'` is the check the queue uses to mark a job
 * `cancelled` rather than `failed`, and it is the shape `fetch` and Node's own
 * `signal`-aware APIs already produce — so the cloud path and the local path
 * can be told apart by one predicate instead of two.
 */
function abortError(): Error {
  const error = new Error('Cancelled.');
  error.name = 'AbortError';
  return error;
}

function tail(text: string): string {
  return text.length > STDERR_TAIL_BYTES ? text.slice(text.length - STDERR_TAIL_BYTES) : text;
}

function spawnFailure(name: BinaryName, exe: string, cause: Error): Error {
  const reason = 'code' in cause && cause.code === 'ENOENT' ? 'is missing' : `could not be started (${cause.message})`;
  // The path is named on purpose: this fires when someone skipped
  // `npm run binaries:fetch`, or when a packaged app was copied out of its
  // .app bundle, and neither is diagnosable without knowing where we looked.
  return new Error(`DropScribe's bundled ${name} ${reason}. Expected it at ${exe}.`);
}

/**
 * Spawn a vendored binary and wait for it.
 *
 * Resolves for *any* exit code — including a non-zero one — because two of the
 * three callers need to tell "ffmpeg refused this codec" apart from "ffmpeg is
 * not there", and an exception cannot carry that distinction cheaply. It
 * rejects only for a failure to run at all, or for cancellation.
 */
function runBinary(name: BinaryName, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const exe = binaryPath(name);
  const signal = options.signal;

  return new Promise<RunResult>((resolve, reject) => {
    if (signal !== undefined && signal.aborted) {
      reject(abortError());
      return;
    }
    ensureQuitHook();

    // Not `spawn`'s own `signal` option: it sends one SIGTERM and then
    // considers the job done. ffmpeg finishing a large write can outlive that,
    // and a "cancelled" job that still holds the CPU is a lie to the user. We
    // escalate instead.
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const id = nextChildId++;
    running.set(id, child);

    let stdout = '';
    let stderr = '';
    let cancelled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (options.onStdout !== undefined) options.onStdout(chunk);
      else stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = tail(stderr + chunk);
    });

    const onAbort = (): void => {
      cancelled = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32') {
        // Windows has no SIGTERM. `kill()` is TerminateProcess, which is
        // already the hard stop, so there is nothing to escalate to.
        child.kill();
        return;
      }
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, SIGKILL_GRACE_MS);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      running.delete(id);
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      signal?.removeEventListener('abort', onAbort);
    };

    child.once('error', (cause: Error) => {
      cleanup();
      reject(spawnFailure(name, exe, cause));
    });

    // `close` and not `exit`: `exit` can fire while stdout still has buffered
    // data, and for ffprobe that data is the entire answer.
    child.once('close', (code: number | null) => {
      cleanup();
      if (cancelled) {
        reject(abortError());
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

// ── Failure messages ────────────────────────────────────────────────────────

/** The last line ffmpeg actually said, trimmed to something a UI can show. */
function lastLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const line = lines[lines.length - 1];
  if (line === undefined) return '';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function toolFailure(what: string, filePath: string, result: RunResult): Error {
  const said = lastLine(result.stderr);
  const because = said.length > 0 ? ` ffmpeg said: ${said}` : ` It exited with code ${String(result.code)}.`;
  return new Error(`${what} “${basename(filePath)}”.${because}`);
}

/**
 * Remove a half-written output.
 *
 * A truncated WAV is not obviously broken — it has a header, it opens, and
 * whisper.cpp will cheerfully transcribe the first 40 minutes of a film and
 * report success. Deleting on every failure path means a retry can never pick
 * up the wreckage of the attempt before it.
 */
function discard(outPath: string): void {
  try {
    rmSync(outPath, { force: true });
  } catch {
    /* The temp directory is swept elsewhere; a leftover file is not worth failing over. */
  }
}

// ── JSON narrowing (ffprobe output is untyped by definition) ────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** ffprobe quotes numbers as strings in JSON, and writes `"N/A"` for unknown. */
function numberFrom(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringFrom(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

// ── probe ───────────────────────────────────────────────────────────────────

const PROBE_ARGS: readonly string[] = [
  '-v', 'error',
  '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels',
  '-of', 'json',
];

function sizeOf(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    throw new Error(
      `DropScribe cannot open “${basename(filePath)}”. It may have been moved, renamed, or deleted since it was added.`,
    );
  }
}

/**
 * Duration from the audio stream itself.
 *
 * Only reached when the container does not carry one, which is common enough
 * to matter: Matroska written by a live recorder, a raw MPEG-TS capture, and
 * anything remuxed by a tool that did not bother. `-select_streams a:0` is why
 * this is a second process rather than one more field in the first probe —
 * without it a video stream's duration would be in the same list, and picking
 * the wrong one puts every subtitle cue in the wrong place.
 */
async function probeStreamDuration(filePath: string): Promise<number | null> {
  const result = await runBinary('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=duration',
    '-of', 'json',
    filePath,
  ]);
  if (result.code !== 0) return null;
  const parsed = parseJson(result.stdout);
  const streams = parsed === null || !Array.isArray(parsed['streams']) ? [] : parsed['streams'];
  for (const entry of streams) {
    const stream = asRecord(entry);
    if (stream === null) continue;
    const seconds = numberFrom(stream['duration']);
    if (seconds !== null && seconds > 0) return seconds;
  }
  return null;
}

/**
 * Measure a file before anything else touches it.
 *
 * This is also the app's gatekeeper: it is the one place that can say "this
 * has no audio" in words, rather than letting the extraction step fail two
 * seconds later with `Stream map '0:a:0' matches no streams`, which means
 * nothing to anyone who has not used ffmpeg.
 */
export async function probe(filePath: string): Promise<MediaInfo> {
  const bytes = sizeOf(filePath);
  const result = await runBinary('ffprobe', [...PROBE_ARGS, filePath]);
  if (result.code !== 0) {
    throw toolFailure('DropScribe could not read', filePath, result);
  }

  const parsed = parseJson(result.stdout);
  if (parsed === null) {
    throw new Error(`DropScribe could not read “${basename(filePath)}”. ffprobe returned nothing it could understand.`);
  }

  const format = asRecord(parsed['format']);
  const rawStreams = Array.isArray(parsed['streams']) ? parsed['streams'] : [];

  let audio: Record<string, unknown> | null = null;
  for (const entry of rawStreams) {
    const stream = asRecord(entry);
    if (stream !== null && stream['codec_type'] === 'audio') {
      audio = stream;
      break;
    }
  }
  if (audio === null) {
    // Thrown rather than returned as `hasAudio: false`. A file with no audio is
    // never a job — every caller would have to turn this into the same error —
    // and the message can name the file only here.
    throw new Error(`“${basename(filePath)}” has no audio track, so there is nothing to transcribe.`);
  }

  let seconds = format === null ? null : numberFrom(format['duration']);
  if (seconds === null || seconds <= 0) seconds = await probeStreamDuration(filePath);

  // An unknown duration is survivable and a refusal is not: progress goes
  // indeterminate, `normalizeTranscript` treats a zero duration as "do not
  // clamp", and the transcript still comes out right. Refusing a file ffmpeg
  // can plainly decode, because its container forgot to write a header field,
  // would be the worse trade.
  const durationMs = seconds === null || seconds <= 0 ? 0 : Math.round(seconds * 1000);

  return {
    durationMs,
    // Always true by the time we return: the alternative exits above.
    hasAudio: true,
    sampleRate: numberFrom(audio['sample_rate']),
    channels: numberFrom(audio['channels']),
    codec: stringFrom(audio['codec_name']),
    bytes,
  };
}

// ── Progress ────────────────────────────────────────────────────────────────

/** `out_time_us=1234567`, or `null` for every other progress key. */
function outTimeUs(line: string): number | null {
  if (!line.startsWith('out_time_us=')) return null;
  const value = Number.parseInt(line.slice('out_time_us='.length), 10);
  // ffmpeg prints `out_time_us=-9223372036854775807` in the first block, before
  // a single frame has been written. That is not zero progress, it is no
  // progress, and averaging it into a bar makes the bar jump backwards.
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * A stdout sink that turns `-progress pipe:1` output into fractions.
 *
 * Chunk boundaries land mid-line often enough to matter on a long run, so the
 * remainder is carried between chunks; parsing per chunk would silently drop
 * every progress line that straddled a 64 KB read.
 */
function progressReader(durationMs: number, onProgress: (fraction: number) => void): (chunk: string) => void {
  let pending = '';
  let last = -1;

  const emit = (fraction: number): void => {
    const clamped = Math.min(1, Math.max(0, fraction));
    // A 1% step. ffmpeg reports about twice a second, and forwarding every one
    // of those over IPC to redraw a bar that moved a pixel is pure noise.
    if (clamped <= last || (clamped - last < 0.01 && clamped < 1)) return;
    last = clamped;
    onProgress(clamped);
  };

  return (chunk: string): void => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
      // `progress=end` is the only reliable "done": the last `out_time_us` can
      // fall a few milliseconds short of the duration and leave the bar at 99%.
      if (line === 'progress=end') {
        emit(1);
        continue;
      }
      const micros = outTimeUs(line);
      if (micros === null) continue;
      emit(micros / 1000 / durationMs);
    }
  };
}

// ── extractWav16k ───────────────────────────────────────────────────────────

/**
 * Global options shared by both conversions.
 *
 * `-nostdin` because an ffmpeg that thinks it has a terminal will read stdin
 * and can swallow keystrokes; `-y` because the caller owns the output path and
 * a stale temp file must not turn into an interactive "overwrite?" prompt that
 * no one can answer; `-loglevel error` because everything quieter than that is
 * banner noise we would only have to filter out of the message shown to a user.
 */
const GLOBAL_ARGS: readonly string[] = ['-hide_banner', '-loglevel', 'error', '-nostats', '-y'];

/**
 * The 16 kHz mono 16-bit WAV both local engines are fed.
 *
 * Not negotiable, and not an optimization: whisper.cpp resamples internally to
 * exactly this, so handing it anything else only moves the same work into a
 * process with less error reporting. `-map 0:a:0` picks the first audio stream
 * — films routinely carry a commentary track and a second language, and
 * letting ffmpeg's default stream selection choose by channel count would
 * transcribe the 5.1 commentary of some discs. `-threads 1` because extraction
 * is I/O bound, and the cores matter to the engine that runs next.
 */
export async function extractWav16k(
  filePath: string,
  outPath: string,
  ctx: { signal: AbortSignal; onProgress?: (fraction: number) => void; durationMs?: number },
): Promise<void> {
  const durationMs = ctx.durationMs ?? 0;
  const onProgress = ctx.onProgress;
  const reader = onProgress !== undefined && durationMs > 0 ? progressReader(durationMs, onProgress) : undefined;

  const args = [
    ...GLOBAL_ARGS,
    ...(reader !== undefined ? ['-progress', 'pipe:1'] : []),
    '-nostdin',
    '-threads', '1',
    '-i', filePath,
    '-vn',
    '-map', '0:a:0',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    '-f', 'wav',
    outPath,
  ];

  let result: RunResult;
  try {
    result = await runBinary('ffmpeg', args, {
      signal: ctx.signal,
      ...(reader !== undefined ? { onStdout: reader } : {}),
    });
  } catch (error) {
    discard(outPath);
    throw error;
  }

  if (result.code !== 0) {
    discard(outPath);
    throw toolFailure('DropScribe could not extract the audio from', filePath, result);
  }
  // The bar has to land on full even when the file was short enough that
  // ffmpeg never printed a progress block.
  if (onProgress !== undefined) onProgress(1);
}

// ── compressForUpload ───────────────────────────────────────────────────────

/**
 * Whether this ffmpeg build has libopus. `null` until the first attempt.
 *
 * Latched at module scope because it is a property of the *build*, not of the
 * file: once one conversion has proved the encoder missing, paying for a
 * doomed attempt on every later upload would be a wasted process per job.
 */
let opusAvailable: boolean | null = null;

/** Does this stderr say "no such encoder" rather than "your file is broken"? */
function looksLikeMissingEncoder(stderr: string): boolean {
  return /unknown encoder|encoder not found|codec not currently supported|libopus/i.test(stderr);
}

const COMPRESS_INPUT_ARGS: readonly string[] = [
  '-nostdin',
  '-threads', '1',
];

/**
 * A copy small enough to upload over a phone tether.
 *
 * Cloud speech APIs charge by audio duration, not by bytes, and every one of
 * them decodes server-side — so the only thing file size costs is the user's
 * upload time, and that is exactly what dominates the wall clock on a film.
 * 16 kHz mono Opus at 12 kbps is about 1.6 MB for three hours, down from ~3 GB:
 * the upload stops being a stage the user waits through. 12 kbps sounds thin to
 * a human and is comfortably above what these recognizers need — they are all
 * downsampling to 16 kHz mono anyway.
 *
 * The MP3 fallback exists for a vendored build without libopus. Detected by
 * *trying*, rather than by parsing `ffmpeg -encoders`, because that would be a
 * whole extra process on the happy path to answer a question the real
 * conversion answers for free. The retry is the detection.
 *
 * One consequence worth knowing at the call site: on the fallback path the
 * bytes at `outPath` are MP3 even if the caller named the file `.ogg`. Every
 * provider we ship sniffs the content, and a build without libopus is already
 * off the supported path — but a caller that must be certain should keep the
 * name neutral.
 */
export async function compressForUpload(
  filePath: string,
  outPath: string,
  ctx: { signal: AbortSignal; durationMs?: number },
): Promise<void> {
  // `ctx.durationMs` is accepted for symmetry with `extractWav16k` and is not
  // needed here: compression is fast enough that the queue shows a single
  // "Compressing" stage rather than a bar, so there is no fraction to compute.
  const base = [
    ...GLOBAL_ARGS,
    ...COMPRESS_INPUT_ARGS,
    '-i', filePath,
    '-vn',
    '-map', '0:a:0',
    '-ac', '1',
    '-ar', '16000',
  ];

  try {
    if (opusAvailable !== false) {
      const opus = await runBinary('ffmpeg', [...base, '-c:a', 'libopus', '-b:a', '12k', '-f', 'ogg', outPath], {
        signal: ctx.signal,
      });
      if (opus.code === 0) {
        opusAvailable = true;
        return;
      }
      // Only latch the *encoder* verdict on an encoder-shaped complaint. A
      // corrupt input also fails here, and remembering that as "this build has
      // no Opus" would quietly downgrade every upload for the rest of the run.
      if (looksLikeMissingEncoder(opus.stderr)) opusAvailable = false;
    }

    const mp3 = await runBinary('ffmpeg', [...base, '-c:a', 'libmp3lame', '-b:a', '32k', '-f', 'mp3', outPath], {
      signal: ctx.signal,
    });
    if (mp3.code !== 0) {
      throw toolFailure('DropScribe could not compress', filePath, mp3);
    }
  } catch (error) {
    discard(outPath);
    throw error;
  }
}
