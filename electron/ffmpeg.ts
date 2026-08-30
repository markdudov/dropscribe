/**
 * Everything the app asks of ffmpeg and ffprobe.
 *
 * Three jobs, and no fourth: measure a file, turn it into the one WAV shape
 * both local engines accept, and squeeze it small enough to upload. Every
 * other module talks to media through this one, which is what keeps the
 * "which exact flags did we use?" question answerable.
 *
 * The squeezing step asks the binary what it can do before it asks it to do
 * anything — see `UPLOAD_ENCODINGS` — because the vendored macOS and Windows
 * ffmpeg builds genuinely carry different audio encoders, and a flag list
 * written from memory is right on one platform and fatal on the other.
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
/**
 * A file that cannot be transcribed because of what it *is*, not because
 * something went wrong on the way.
 *
 * The queue's `describeFailure` marks unknown failures retryable on purpose —
 * "offering a button that turns out not to help costs one wasted click;
 * withholding it from somebody whose only problem was a half-open socket costs
 * them the whole transcript". That reasoning holds for unknown failures. This
 * one is known.
 */
export class MediaInputError extends Error {
  override readonly name = 'MediaInputError';
}

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
    //
    // A distinct class, so the queue can tell this apart from the failures its
    // last branch treats as worth another go. It is not: the absence of an
    // audio track is a property of the file, and "Try again" on it produces the
    // identical sentence, which reads as the app not having tried.
    throw new MediaInputError(`“${basename(filePath)}” has no audio track, so there is nothing to transcribe.`);
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

/** One way to encode the upload copy: what to ask ffmpeg for, and what comes out. */
export interface UploadEncoding {
  /** ffmpeg encoder name, e.g. 'libopus'. */
  codec: string;
  /** File extension WITHOUT the dot, e.g. 'ogg', 'm4a', 'mp3'. */
  extension: string;
  /** Target bitrate string handed to -b:a, e.g. '12k'. */
  bitrate: string;
  /** Extra args this encoder needs, e.g. ['-vbr', 'on'] — may be empty. */
  extraArgs: readonly string[];
  /** For the log and for the error message when nothing fits. */
  label: string;
}

/**
 * Every encoding we would accept for an upload copy, best first.
 *
 * Cloud speech APIs charge by audio duration, not by bytes, and every one of
 * them decodes server-side. It is tempting to conclude from that pair of facts
 * that file size only costs upload time — the first version of this table said
 * exactly that, and it was wrong. **OpenRouter rejects anything over 17 MiB
 * before it makes a network call**, and AAC at the 32 kbps below puts a
 * two-hour film at 30 MB, measured. So bytes are a correctness concern for at
 * least one shipped provider, and `fitBitrate` lowers the rate to fit whatever
 * ceiling the queue passes in. See `maxUploadBytes` in `shared/providers.ts`.
 *
 * All four rows sound thin to a human at 16 kHz mono and are comfortably above
 * what these recognizers need; they downsample to 16 kHz mono anyway.
 *
 * Ranked by measurement, on 171.2 s of 16 kHz mono speech extrapolated to a
 * two-hour film: AAC at 32k is 28.5 MB, AAC at 24k is 21.4 MB, FLAC is 137.8 MB.
 * Opus at 12k is roughly a third of AAC 32k, which is why it leads — and why
 * FLAC is absent entirely: a lossless upload costs nearly five times the wait
 * and buys nothing a recognizer can hear. AAC keeps 32k and not the 21.4 MB
 * that 24k would give, because the bottom row is the one that runs when nothing
 * better exists, and the fallback is the wrong place to be shaving quality for
 * seven megabytes.
 *
 * The list ends in `aac` because `aac` is ffmpeg's own native encoder, in every
 * configuration there is. That last row is what makes this table total in
 * practice — whatever the vendored build turned out to be, something matches.
 *
 * Deliberately NOT here: the native `opus` encoder, the one without the `lib`
 * prefix. Our macOS build does have it, so it looks like a free extra row, and
 * it is not: it rejects the input outright with “Specified sample rate 16000 is
 * not supported by the opus encoder” (measured 2026-08-29), and 16 kHz is the
 * only sample rate this function ever produces. Adding it back would move the
 * failure from a cheap probe into the conversion of a three-hour film.
 */
export const UPLOAD_ENCODINGS: readonly UploadEncoding[] = [
  // `-vbr on` is libopus's own default. Stated anyway, so that a later change
  // to `-b:a` cannot quietly turn this into hard CBR at the same number.
  { codec: 'libopus', extension: 'ogg', bitrate: '12k', extraArgs: ['-vbr', 'on'], label: 'Opus' },
  { codec: 'libvorbis', extension: 'ogg', bitrate: '24k', extraArgs: [], label: 'Vorbis' },
  { codec: 'libmp3lame', extension: 'mp3', bitrate: '32k', extraArgs: [], label: 'MP3' },
  { codec: 'aac', extension: 'm4a', bitrate: '32k', extraArgs: [], label: 'AAC' },
];

/**
 * The muxer name `-f` wants, which is not reliably the extension.
 *
 * `.m4a` is the trap: the muxer that writes an audio-only MP4 is called `ipod`,
 * and `-f m4a` is not a muxer name at all — ffmpeg exits non-zero with “Error
 * opening output files: Invalid argument”, which reads like a bad path and is
 * not one. Named explicitly rather than left to ffmpeg's guess-from-the-
 * filename, so the container stays decided here, next to the table that chose
 * it, instead of depending on a path string a caller owns.
 */
const UPLOAD_MUXERS: Readonly<Record<string, string>> = { ogg: 'ogg', m4a: 'ipod', mp3: 'mp3' };

/**
 * The audio encoder names in `ffmpeg -encoders` output.
 *
 * The listing is a legend, a rule of dashes, then rows — and the legend rows
 * have the same shape as the real ones, which is the whole reason this is a
 * parser and not a `split`:
 *
 *      A..... = Audio
 *      ------
 *      A....D aac                  AAC (Advanced Audio Coding)
 *      A..X.D opus                 Opus
 *
 * Two filters do it. The flag field has to look like an ffmpeg flag field
 * beginning with `A`, which is what makes a row an *audio* row and what keeps
 * out the `V`/`S` rows, the `------` rule, and the decoder-only `D.....` rows
 * of a `-codecs` listing should this ever be pointed at one. The name field has
 * to look like a name, which is what drops the legend's `=`.
 *
 * Neither filter pins the column count, so an ffmpeg that grows a seventh flag
 * still parses. Anything that cannot be made sense of is skipped rather than
 * thrown over: a listing we only half understand still answers the one question
 * we ask of it, and the cost of guessing wrong here is one codec, never the
 * whole feature.
 */
export function parseEncoders(output: string): Set<string> {
  const names = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const fields = rawLine.trim().split(/\s+/);
    const flags = fields[0];
    const name = fields[1];
    if (flags === undefined || name === undefined) continue;
    if (!/^A[.A-Z]+$/.test(flags)) continue;
    if (!/^[A-Za-z0-9][\w-]*$/.test(name)) continue;
    names.add(name);
  }
  return names;
}

/**
 * The best encoding this build can actually produce, or `null` for none.
 *
 * The order of `UPLOAD_ENCODINGS` is the entire policy: first match wins, so
 * there is no score to tune and no way for the ranking to disagree with itself.
 */
export function chooseUploadEncoding(available: ReadonlySet<string>): UploadEncoding | null {
  return UPLOAD_ENCODINGS.find((encoding) => available.has(encoding.codec)) ?? null;
}

/**
 * What we assume about a build we could not interrogate.
 *
 * `aac` alone, because it is native to every ffmpeg ever configured. An app
 * that refuses to work because it could not read a capability list is worse
 * than one that goes ahead with the encoder every build has: the first fails
 * for certain, the second fails only if the assumption was wrong, and if it is
 * wrong the conversion says so in ffmpeg's own words a moment later.
 */
const ASSUMED_ENCODERS: ReadonlySet<string> = new Set(['aac']);

/**
 * The encoder set of the ffmpeg we ship, asked once per process.
 *
 * Asked, rather than assumed. This function used to be a hard-coded `libopus`
 * with a `libmp3lame` retry, on the reasoning that the real conversion is a
 * free probe and a second process on the happy path is not. The vendored macOS
 * ffmpeg has neither: it is the author's own build for a video editor,
 * configured `--enable-libx264 --enable-libx265 --enable-libzimg` and nothing
 * more, so both attempts died on “Encoder not found” and every cloud job failed
 * instantly. The Windows build (BtbN) does carry libopus, libmp3lame and
 * libvorbis, so the two platforms genuinely differ and no hard-coded encoder
 * can be right on both. One extra process per app run buys an answer that is
 * correct on both today and re-earns Opus by itself on the day the macOS binary
 * is rebuilt with it.
 *
 * The promise is cached, not the resolved Set, so two jobs starting together
 * share one process instead of racing to spawn two. And no `AbortSignal` is
 * passed: this is a property of the build, it costs milliseconds, and letting
 * one user's Cancel land here would cache the aborted answer — `aac` only — for
 * the rest of the run.
 */
let encoderProbe: Promise<ReadonlySet<string>> | null = null;

function availableEncoders(): Promise<ReadonlySet<string>> {
  encoderProbe ??= runBinary('ffmpeg', ['-hide_banner', '-encoders'])
    .then((result) => (result.code === 0 ? parseEncoders(result.stdout) : ASSUMED_ENCODERS))
    .catch(() => ASSUMED_ENCODERS);
  return encoderProbe;
}

const COMPRESS_INPUT_ARGS: readonly string[] = [
  '-nostdin',
  '-threads', '1',
];

/**
 * A copy small enough to upload over a phone tether.
 *
 * 16 kHz mono at a speech bitrate, in whichever of `UPLOAD_ENCODINGS` this
 * build supports — about 1.6 MB for three hours as Opus, down from ~3 GB, which
 * is the difference between an upload the user waits through and one they do
 * not notice.
 *
 * `outBase` is a path WITHOUT an extension, and the written path comes back in
 * the result. The caller cannot name the file, because the container is not
 * known until the probe has run, and a `.ogg` holding AAC is a landmine: every
 * provider we ship sniffs content first, but the one that falls back to the
 * extension would declare the wrong format and the request would fail somewhere
 * far away from here.
 *
 * The returned `encoding` is also what the caller logs — this module has no
 * logger of its own, on purpose.
 */
/**
 * The lowest bitrate this file is willing to fall to, in kbps.
 *
 * AAC-LC on 16 kHz mono speech is still intelligible here; below it the encoder
 * starts eating consonants, and a transcript is exactly the thing that notices.
 * If even this does not fit a provider's ceiling the file is simply too long for
 * that provider, and its own error says so better than a whisper-thin encode
 * that arrives and transcribes badly.
 */
const MIN_UPLOAD_KBPS = 16;

/** Headroom under a byte ceiling, for container overhead and VBR overshoot. */
const CEILING_HEADROOM = 0.88;

/**
 * The bitrate to actually use, given the encoder's preference and any ceiling.
 *
 * Exported for the tests. `null` for `maxBytes` means "no ceiling" and returns
 * the encoding's own figure unchanged, which is the common path — only
 * OpenRouter publishes a hard limit.
 *
 * It never raises the bitrate above the encoding's default. A ceiling is a
 * constraint, not a licence to spend more on a short file.
 */
export function fitBitrate(encoding: UploadEncoding, durationMs: number, maxBytes: number | null): string {
  const preferred = Number.parseInt(encoding.bitrate, 10);
  if (maxBytes === null || !Number.isFinite(preferred) || durationMs <= 0) return encoding.bitrate;
  const seconds = durationMs / 1000;
  const fittedKbps = Math.floor((maxBytes * CEILING_HEADROOM * 8) / seconds / 1000);
  // The floor may not outrank the encoding. `Math.max(MIN_UPLOAD_KBPS, …)`
  // applied last did exactly that, and turned the ceiling into a licence to
  // spend more: Opus is configured at 12k, below the 16k floor, so every
  // duration came back at 16k and the upload grew by a third — the opposite of
  // what a ceiling is for, and on a one-minute file nowhere near it. Every test
  // for this function used AAC at 32k, which is above the floor, so it never
  // showed. `MIN_UPLOAD_KBPS` exists to stop the FITTING from producing
  // something unintelligible, not to raise a rate the encoding chose on purpose.
  const floor = Math.min(MIN_UPLOAD_KBPS, preferred);
  const chosen = Math.max(floor, Math.min(preferred, fittedKbps));
  return `${chosen}k`;
}

export async function compressForUpload(
  filePath: string,
  outBase: string,
  ctx: { signal: AbortSignal; durationMs?: number; maxBytes?: number },
): Promise<{ path: string; encoding: UploadEncoding }> {
  const encoding = chooseUploadEncoding(await availableEncoders());
  if (encoding === null) {
    // Not retryable, and not anything the user did. It means the ffmpeg in
    // `vendor/bin` was built with no audio encoder at all — not even the native
    // `aac` every configuration has — which cannot happen to a correctly
    // packaged app. Say that, instead of inviting a retry that fails the same
    // way for the same reason every time.
    const wanted = UPLOAD_ENCODINGS.map((entry) => entry.label).join(', ');
    throw new Error(
      `DropScribe cannot prepare “${basename(filePath)}” for upload: its bundled ffmpeg has none of the ` +
        `audio encoders cloud transcription needs (${wanted}). This copy of DropScribe is packaged ` +
        `incorrectly, so trying again will not help — reinstall it, or run “npm run binaries:fetch” if you ` +
        `are running from a checkout. Local transcription is unaffected and still works on this file.`,
    );
  }

  const outPath = `${outBase}.${encoding.extension}`;
  // `?? extension` rather than a non-null assertion: the three containers the
  // table can name are all in the map, and an extension added later without a
  // muxer entry should get ffmpeg's own guess instead of a crash here.
  const format = UPLOAD_MUXERS[encoding.extension] ?? encoding.extension;

  /*
    The bitrate answers to the provider's ceiling, when it has one.

    The first version of this fix reasoned that file size only costs upload
    time. That is false for OpenRouter, which rejects anything over 17 MiB
    before it makes a network call — and AAC at the table's 32 kbps puts a
    two-hour film at 30 MB, measured. So the ceiling, when the caller passes
    one, decides the bitrate; without one nothing changes.

    Fitting rather than refusing on purpose: a slightly thinner encode that
    arrives beats a perfect one the provider will not accept.
  */
  const bitrate = fitBitrate(encoding, ctx.durationMs ?? 0, ctx.maxBytes ?? null);

  const args = [
    ...GLOBAL_ARGS,
    ...COMPRESS_INPUT_ARGS,
    '-i', filePath,
    '-vn',
    '-map', '0:a:0',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', encoding.codec,
    '-b:a', bitrate,
    ...encoding.extraArgs,
    // Only the MP4 family has a moov atom, and moving it to the front is what
    // lets the far end start decoding before the last byte lands — measured on
    // this output at offset 32 rather than 120669, i.e. past the whole payload.
    // Conditional on the *container*, not the codec, and conditional at all for
    // the reader's sake rather than ffmpeg's: a stray `-movflags` on an ogg
    // output is accepted in silence and exits 0, which is exactly how an
    // unconditional flag would sit here for years looking like it did something.
    ...(format === 'ipod' ? ['-movflags', '+faststart'] : []),
    '-f', format,
    outPath,
  ];

  let result: RunResult;
  try {
    result = await runBinary('ffmpeg', args, { signal: ctx.signal });
  } catch (error) {
    discard(outPath);
    throw error;
  }

  if (result.code !== 0) {
    discard(outPath);
    throw toolFailure('DropScribe could not compress', filePath, result);
  }
  return { path: outPath, encoding };
}
