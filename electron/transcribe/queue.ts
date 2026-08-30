/**
 * The queue: the one place where a dropped file becomes a transcript.
 *
 * Everything else in this app is a leaf. `ffmpeg.ts` decodes, an engine
 * recognizes, an adapter uploads, `exports.ts` formats — none of them know what
 * a job is, none of them own a temp directory, and none of them decide what
 * happens when something fails halfway. This file owns all of that, which is
 * why it is the longest one in main and why almost every line of it is about a
 * failure path rather than the happy one.
 *
 * The shape is a small state machine per job, driven by a `pump()` that starts
 * as many as `maxConcurrentJobs` allows. There is no worker pool and no
 * scheduler: local inference is memory-bound, not CPU-bound, and the honest
 * default is one job at a time. A pool would be machinery in service of a
 * concurrency setting most users will never raise above 1.
 */

import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Settings } from '../api-types';
import { engineFor } from '../engines';
import { MediaInputError, compressForUpload, extractWav16k, probe } from '../ffmpeg';
import { assertAuthorized, authorizeAll } from '../path-policy';
import { adapterFor } from '../providers';
import { exportFileName, renderTranscript } from '../shared/exports';
import type { Job, JobError, TranscribeTarget } from '../shared/jobs';
import { isTerminal, targetLabel } from '../shared/jobs';
import { findLocalModel } from '../shared/models';
import type { CloudOptions } from '../shared/providers';
import { findProvider } from '../shared/providers';
import type { Transcript } from '../shared/transcript';
import { normalizeTranscript } from '../shared/transcript';
import { getKey } from '../services/credentials';
import { log } from '../services/logger';
import { isInstalled, modelPath } from '../services/model-store';
import { getSettings } from '../services/settings';
import { cleanupJobTemp, jobTempDir } from '../services/temp';

export interface JobQueue {
  enqueue(paths: string[], target: TranscribeTarget): Job[];
  list(): Job[];
  cancel(id: string): void;
  retry(id: string): void;
  remove(id: string): void;
  clearFinished(): void;
  onUpdate(callback: (job: Job) => void): () => void;
  shutdown(): void;
}

/**
 * Where audio extraction ends and transcription begins on the job's one bar.
 *
 * Both stages report their own 0–100, and the naive thing — showing each stage's
 * own percentage — produces a bar that fills, snaps back to zero, and fills
 * again. Users read that as a crash and a silent restart; several will cancel
 * the job at exactly the moment it started doing the expensive part. So the two
 * stages are mapped onto one monotonically rising bar for the whole job.
 *
 * Fifteen percent is roughly honest for the split. Decoding a two-hour H.264
 * file to 16 kHz mono runs at a few hundred times real time; whisper large-v3
 * on the same file does not. Extraction is a small slice of the wall clock on
 * every machine this app supports, and reserving a small slice of the bar for it
 * is what keeps the transcription phase moving visibly for the whole long middle.
 */
const EXTRACTION_CEILING = 15;

/**
 * The most threads the app will choose on its own when `settings.threads` is 0.
 *
 * whisper.cpp's throughput flattens somewhere around eight threads on every CPU
 * measured for this app — past that the matrix multiplies are waiting on memory
 * bandwidth, not on cores — so handing it sixteen buys nothing and costs the
 * rest of the machine everything.
 */
const MAX_AUTO_THREADS = 8;

/** Cores deliberately left for the compositor, the renderer and ffmpeg. */
const RESERVED_CORES = 2;

/** Suffixes tried before `writeWithoutOverwriting` gives up. */
const MAX_NAME_ATTEMPTS = 999;

/** errno values that mean "the network, not the request, was the problem". */
const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * A failure this file raised itself, already phrased for the user.
 *
 * The alternative was to throw plain `Error`s and pattern-match their messages
 * in `describeFailure`, which is how a "no API key" turns into a "retry" button
 * that can never work. Carrying `retryable` on the error means the decision is
 * made where the facts are.
 */
class QueueError extends Error {
  readonly detail: string | undefined;
  readonly retryable: boolean;

  constructor(message: string, options: { detail?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = 'QueueError';
    this.detail = options.detail;
    // Default false. A message written by hand in this file describes a
    // structural problem — a missing model, a missing key, a file with no audio
    // — and none of those get better by pressing the button again.
    this.retryable = options.retryable ?? false;
  }
}

function errnoCodeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** The engine's own output, for the disclosure triangle. Never the user's key. */
function detailOf(error: unknown): { detail?: string } {
  if (error instanceof Error) return { detail: error.stack ?? error.message };
  return { detail: String(error) };
}

/**
 * Any thrown thing → a `JobError` the UI can render.
 *
 * The last branch uses the thrown error's own message verbatim, which looks
 * lazy and is not: `whisper-cpp.ts`, `parakeet-cpp.ts` and all four provider
 * adapters were written to throw sentences meant for a person, and they know
 * far more about what went wrong than a mapping here ever could. The mapping
 * above it covers only the failures that happen *before* an engine is reached,
 * where the thrown thing is a raw errno from the filesystem and means nothing
 * to anybody.
 */
function describeFailure(error: unknown): JobError {
  if (error instanceof QueueError) {
    return {
      message: error.message,
      ...(error.detail !== undefined ? { detail: error.detail } : {}),
      retryable: error.retryable,
    };
  }

  if (error instanceof MediaInputError) {
    return {
      message: error.message,
      ...detailOf(error),
      // Known, and permanent for this file. See the class.
      retryable: false,
    };
  }

  const code = errnoCodeOf(error);
  if (code === 'ENOENT') {
    return {
      message: 'The file is no longer where it was — it was moved, renamed or deleted while this job was waiting.',
      ...detailOf(error),
      retryable: false,
    };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return {
      message: 'The system refused access to this file. Grant DropScribe access to the folder it lives in, then try again.',
      ...detailOf(error),
      retryable: false,
    };
  }
  if (code === 'ENOSPC') {
    return {
      message: 'The disk is full, so the audio could not be extracted. Free some space and try again.',
      ...detailOf(error),
      retryable: true,
    };
  }
  if (code !== undefined && NETWORK_ERROR_CODES.has(code)) {
    return {
      message: 'The provider could not be reached. Check the connection and try again.',
      ...detailOf(error),
      retryable: true,
    };
  }

  if (error instanceof Error) {
    const message = error.message.trim();
    return {
      message: message.length > 0 ? message : 'Transcription failed.',
      ...detailOf(error),
      // Unknown failures are marked retryable. Offering a button that turns out
      // not to help costs one wasted click; withholding it from somebody whose
      // only problem was a half-open socket costs them the whole transcript.
      retryable: true,
    };
  }

  return {
    message: 'Transcription failed for a reason DropScribe could not identify.',
    ...detailOf(error),
    retryable: true,
  };
}

/**
 * How many threads to hand whisper.cpp / parakeet.
 *
 * `0` in settings means "you decide", and the decision is `cores - 2`, capped.
 * Leaving cores free is not politeness — it is the difference between an app
 * that stays usable and one that looks hung. whisper.cpp will saturate every
 * thread it is given, and this is a GUI: the compositor needs a core to draw the
 * progress bar, the renderer process needs one to run React, and ffmpeg needs
 * one if a second job is extracting audio at the same time. Starve them and the
 * window stops repainting, the traffic lights stop responding, and macOS puts up
 * the spinning beachball — at which point the user force-quits a job that was
 * two minutes from finishing.
 */
function resolveThreads(configured: number): number {
  if (Number.isFinite(configured) && configured > 0) return Math.trunc(configured);
  const cores = os.cpus().length;
  return Math.max(1, Math.min(MAX_AUTO_THREADS, cores - RESERVED_CORES));
}

/** Bytes on disk, for the job row. Zero rather than a throw — it is decoration. */
function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Write `text` to `desired`, or to `desired (2)`, `desired (3)`, … if taken.
 *
 * Silently overwriting is unrecoverable and this is the file it would destroy.
 * A user runs a two-hour film, hand-corrects three misheard names in the `.srt`,
 * re-runs the job to compare a different model — and the corrected file is gone.
 * It does not go to the Trash, because nothing put it there; `writeFile`
 * truncates in place. There is no undo anywhere in the chain. So the queue never
 * overwrites, full stop, and the numbered suffix is the same convention every
 * browser uses for a repeated download, which means it needs no explanation.
 *
 * The obvious implementation is stat-then-write, and it is wrong: drop a folder
 * of six clips with the same stem and two jobs finish inside the same
 * millisecond, both see no file, and the second one clobbers the first. The `wx`
 * flag makes the check and the create a single atomic operation, so the loser of
 * that race gets EEXIST and moves on to the next suffix.
 */
async function writeWithoutOverwriting(desired: string, text: string): Promise<string> {
  const directory = path.dirname(desired);
  const extension = path.extname(desired);
  const stem = path.basename(desired, extension);

  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const candidate =
      attempt === 1 ? desired : path.join(directory, `${stem} (${attempt})${extension}`);
    try {
      await writeFile(candidate, text, { encoding: 'utf8', flag: 'wx' });
      return candidate;
    } catch (error) {
      if (errnoCodeOf(error) === 'EEXIST') continue;
      throw error;
    }
  }

  throw new QueueError(
    `There are already ${MAX_NAME_ATTEMPTS} transcripts with this name in that folder. Move some of them somewhere else first.`,
    { retryable: false },
  );
}

/** The label a transcript gets when the adapter left `source.label` empty. */
function describeTarget(target: TranscribeTarget): string {
  if (target.kind === 'local') {
    const model = findLocalModel(target.modelId);
    return targetLabel(target, model?.label ?? target.modelId);
  }
  return targetLabel(target, target.modelId, findProvider(target.providerId)?.label);
}

export function createQueue(): JobQueue {
  const jobs = new Map<string, Job>();
  const controllers = new Map<string, AbortController>();
  const listeners = new Set<(job: Job) => void>();
  let running = 0;
  let shuttingDown = false;

  /**
   * A copy, never the live object.
   *
   * `list()` and every `onUpdate` payload cross into the IPC layer and from
   * there into a zustand store. Handing out the object the queue is still
   * mutating means the renderer's "previous" job and its "next" job are the same
   * reference, every memoized selector sees no change, and the row stops
   * repainting at whatever percentage it happened to be on.
   */
  function snapshot(job: Job): Job {
    return { ...job, progress: { ...job.progress } };
  }

  function emit(job: Job): void {
    // A removed job has no row left to update. Emitting for one would resurrect
    // it in the renderer's store, since the store's update handler cannot tell
    // "here is a change to a job you have" from "here is a job you have not seen".
    if (!jobs.has(job.id)) return;
    const payload = snapshot(job);
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch (error) {
        // A listener that throws must never reach the job loop. The transcript
        // is the valuable thing here; a renderer that has already been destroyed
        // — which is what this usually is, a `webContents.send` after the window
        // closed — is not a reason to abandon forty minutes of inference.
        console.error('[queue] a job listener threw; the job continues', error);
      }
    }
  }

  function update(job: Job, patch: Partial<Job>): void {
    Object.assign(job, patch);
    emit(job);
  }

  function progress(job: Job, percent: number | null, stage: string): void {
    update(job, { progress: { percent, stage } });
  }

  function extractionPercent(fraction: number): number {
    const clamped = Math.min(Math.max(fraction, 0), 1);
    return Math.round(clamped * EXTRACTION_CEILING);
  }

  function transcriptionPercent(percent: number): number {
    const clamped = Math.min(Math.max(percent, 0), 100);
    return EXTRACTION_CEILING + Math.round((clamped / 100) * (100 - EXTRACTION_CEILING));
  }

  function throwIfCancelled(signal: AbortSignal): void {
    // Not `signal.throwIfAborted()`: that throws a `DOMException` whose message
    // is "This operation was aborted", which would end up in front of the user
    // as if it were a failure. Cancellation is not a failure here.
    if (signal.aborted) throw new QueueError('Cancelled.', { retryable: true });
  }

  function markCancelled(job: Job): void {
    if (isTerminal(job.status)) return;
    update(job, {
      status: 'cancelled',
      finishedAt: Date.now(),
      progress: { percent: null, stage: 'Cancelled' },
    });
  }

  /**
   * Start whatever the concurrency limit allows.
   *
   * The limit is read here rather than captured once, so that raising it in
   * Settings takes effect on the next job instead of on the next launch. Lowering
   * it never kills a job that is already running — stopping work the user is
   * watching, to honour a setting they just changed, would be astonishing.
   */
  function pump(): void {
    if (shuttingDown) return;
    const configured = getSettings().maxConcurrentJobs;
    const limit = Number.isFinite(configured) ? Math.max(1, Math.trunc(configured)) : 1;

    for (const job of jobs.values()) {
      if (running >= limit) return;
      if (job.status !== 'queued') continue;
      // A run can still be draining under this id. `cancel()` flips the job to
      // a terminal status the instant the user clicks, but the child process
      // only dies when it notices the signal — whisper checks between decode
      // windows, and one window of a large model runs for several seconds
      // (engines/whisper-cpp.ts). `retry()` inside that window sets the job
      // back to 'queued', and without this line the loop would start a SECOND
      // run under the same id. Both resolve to the same scratch directory,
      // because `jobTempDir` derives it from the id alone.
      //
      // Skipping rather than refusing: the job stays queued, and the `pump()`
      // in the draining run's own `finally` picks it up the moment the id is
      // free. The user's click is honoured, just not instantly.
      if (controllers.has(job.id)) continue;
      running += 1;
      void begin(job);
    }
  }

  /**
   * Run one job to a terminal state. Never rejects.
   *
   * `begin` owns the two things that must happen no matter how `runJob` ends:
   * the job reaches a terminal status, and the scratch directory goes away. A
   * two-hour film's extracted WAV is about 230 MB, and its compressed upload is
   * about 10 MB on a build with libopus or about 29 MB on one that falls back to
   * AAC; leaving either behind on every cancel would quietly cost a heavy user a
   * gigabyte a week in a folder they will never think to look in.
   */
  async function begin(job: Job): Promise<void> {
    const controller = new AbortController();
    controllers.set(job.id, controller);

    try {
      await runJob(job, controller.signal);
    } catch (error) {
      // A `retry()` that landed while this run was draining has already set the
      // job back to 'queued', and that status belongs to the run that has not
      // started yet — not to this one. Writing a terminal status over it loses
      // the user's click entirely: `pump()` in the `finally` below then finds
      // nothing queued, and the row sits at "Cancelled" having been asked to
      // try again. Whatever this run has to say about how it ended is no longer
      // interesting once the job has been asked for a second time.
      const reQueued = job.status === 'queued';
      if (controller.signal.aborted) {
        // Cancelled, not failed. The distinction is the whole reason
        // `JobStatus` has both: a red row with an error message, for something
        // the user themselves asked to stop, teaches them to distrust the app.
        if (!reQueued) markCancelled(job);
      } else if (!reQueued) {
        update(job, {
          status: 'failed',
          error: describeFailure(error),
          finishedAt: Date.now(),
          progress: { percent: null, stage: 'Failed' },
        });
      }
    } finally {
      // Only when this run is still the one registered for the id. The guard in
      // `pump()` should make a second concurrent run impossible, and this is the
      // belt to that pair of braces: an unconditional cleanup here deletes
      // whatever is currently under the id, and `cleanupJobTemp` is a recursive
      // remove of a directory a newer run may be writing its WAV into.
      if (controllers.get(job.id) === controller) {
        controllers.delete(job.id);
        // Sync, and it never throws — see `services/temp.ts`. Doing it here
        // rather than inside `runJob` means it also covers the cancellation
        // path and any failure between the `mkdir` and the first write.
        cleanupJobTemp(job.id);
      }
      running -= 1;
      pump();
    }
  }

  async function runJob(job: Job, signal: AbortSignal): Promise<void> {
    const settings = getSettings();

    update(job, {
      status: 'preparing',
      startedAt: Date.now(),
      progress: { percent: 0, stage: 'Reading the file' },
    });

    // Authorization was recorded at enqueue time, but a job can sit in the queue
    // for an hour behind a feature film, and this is the moment the path is
    // actually opened. Re-checking here is what stops a stale id in the map from
    // becoming a read of a file the user never authorized.
    assertAuthorized(job.filePath);
    throwIfCancelled(signal);

    const info = await probe(job.filePath);
    if (!info.hasAudio) {
      throw new QueueError(
        'This file has no audio track, so there is nothing to transcribe.',
        { retryable: false },
      );
    }
    update(job, { durationMs: info.durationMs, bytes: info.bytes });
    throwIfCancelled(signal);

    // Created before either branch because both need it, and because a failure
    // to create it is a clear, early error rather than an ffmpeg one three
    // steps later. `jobTempDir` makes the directory and returns its path.
    const workDir = jobTempDir(job.id);

    const target = job.target;
    const transcript =
      target.kind === 'local'
        ? await runLocal(job, target, settings, info.durationMs, workDir, signal)
        : await runCloud(job, target, settings, info.durationMs, workDir, signal);

    // An engine that ignores its AbortSignal and runs to completion must not
    // undo a cancellation the user already saw acknowledged in the UI.
    throwIfCancelled(signal);

    const finished = normalizeTranscript({
      ...transcript,
      // ffprobe is the authority on duration, and the queue is the only party
      // that has both numbers. An engine's own figure is a claim about the audio
      // it was handed, which is not the file the user dropped.
      durationMs: info.durationMs,
      // Stamped here because "created" means "the job finished", and the queue is
      // what knows that. An adapter would be stamping the moment it parsed a
      // response, which is a different and less useful instant.
      createdAt: new Date().toISOString(),
      source: {
        ...transcript.source,
        // Only filled in when the adapter left it blank — the adapter knows the
        // vendor's own name for the model and should win when it says anything.
        label:
          transcript.source.label.trim().length > 0
            ? transcript.source.label
            : describeTarget(target),
      },
    });

    update(job, {
      status: 'done',
      transcript: finished,
      finishedAt: Date.now(),
      progress: { percent: 100, stage: 'Done' },
    });

    // Deliberately after the job is marked done. Writing the auto-exports is the
    // cheap part and the transcript is already safe in memory and in the UI;
    // failing to write a file into a read-only folder must not throw away the
    // expensive thing, so this failure is reported on an otherwise successful
    // job rather than turning the whole job red.
    try {
      await writeAutoExports(job, finished, settings);
    } catch (error) {
      const failure = describeFailure(error);
      update(job, {
        error: {
          message: `The transcript is finished, but the export files could not be written. ${failure.message}`,
          ...(failure.detail !== undefined ? { detail: failure.detail } : {}),
          retryable: false,
        },
      });
    }
  }

  async function runLocal(
    job: Job,
    target: Extract<TranscribeTarget, { kind: 'local' }>,
    settings: Settings,
    durationMs: number,
    workDir: string,
    signal: AbortSignal,
  ): Promise<Transcript> {
    const model = findLocalModel(target.modelId);
    if (model === undefined) {
      throw new QueueError(
        `"${target.modelId}" is not a model this version of DropScribe knows about. Choose another one in Settings.`,
        { retryable: false },
      );
    }
    // Checked here rather than trusted from a `ModelState` the renderer sent,
    // because a model can be deleted — by the user, by a disk cleaner, by a
    // failed download — between choosing it and this job reaching the front of
    // the queue. Reaching whisper-cli with a path to nothing produces a stderr
    // dump nobody can act on.
    if (!isInstalled(model.id)) {
      throw new QueueError(
        `${model.label} has not been downloaded yet. Download it in Settings, then run this file again.`,
        { retryable: false },
      );
    }

    const wavPath = path.join(workDir, 'audio.wav');
    progress(job, 0, 'Extracting audio');
    await extractWav16k(job.filePath, wavPath, {
      signal,
      durationMs,
      onProgress: (fraction) => {
        progress(job, extractionPercent(fraction), 'Extracting audio');
      },
    });
    throwIfCancelled(signal);

    update(job, {
      status: 'running',
      progress: { percent: EXTRACTION_CEILING, stage: 'Transcribing' },
    });

    return engineFor(model.engine).run(
      {
        wavPath,
        modelPath: modelPath(model.id),
        durationMs,
        language: settings.language,
        translate: settings.translate,
        threads: resolveThreads(settings.threads),
      },
      {
        signal,
        onProgress: (percent) => {
          progress(job, transcriptionPercent(percent), 'Transcribing');
        },
      },
    );
  }

  async function runCloud(
    job: Job,
    target: Extract<TranscribeTarget, { kind: 'cloud' }>,
    settings: Settings,
    durationMs: number,
    workDir: string,
    signal: AbortSignal,
  ): Promise<Transcript> {
    const providerLabel = findProvider(target.providerId)?.label ?? target.providerId;

    const apiKey = getKey(target.providerId);
    if (apiKey === null || apiKey.length === 0) {
      throw new QueueError(
        `No ${providerLabel} API key is saved. Add one in Settings, then run this file again.`,
        { retryable: false },
      );
    }

    // A base name with no extension, because the container is not this file's
    // to choose: `compressForUpload` picks from whatever encoders the vendored
    // ffmpeg actually has, and that differs between the macOS and Windows
    // builds we ship. This line used to name `audio.ogg` and was wrong on the
    // Mac — a build without libopus wrote AAC bytes under an Ogg name, and
    // Deepgram, which picks its demuxer from the Content-Type we derive from
    // that name, was handed a lie about its own upload.
    //
    // It stays under `workDir` so `cleanupJobTemp` still collects it: cleanup
    // deletes the directory rather than a path this function predicted, which
    // is the only reason writing a filename we do not know in advance is safe.
    const uploadBase = path.join(workDir, 'audio');
    // `compressForUpload` reports no fraction, so this stage is honestly
    // indeterminate rather than the 0–15% the local path shows. A bar frozen at
    // 0 for two minutes on a long film is a worse lie than a spinner: one says
    // "stuck", the other says "working".
    progress(job, null, 'Compressing audio');
    /*
      The provider's own ceiling, when it publishes one, decides how hard the
      audio is squeezed. Only OpenRouter does today. Passing it here rather than
      letting the adapter discover the file is too big is the whole lesson of
      bug 0002: a size decided in one module and enforced in another is a bug
      waiting for the first module to change.
    */
    const uploadCeiling = findProvider(target.providerId)?.maxUploadBytes;

    const { path: uploadPath, encoding } = await compressForUpload(job.filePath, uploadBase, {
      signal,
      durationMs,
      // Spread rather than assigned: `exactOptionalPropertyTypes` refuses the
      // property being present and `undefined`, and most providers have no cap.
      ...(uploadCeiling !== undefined ? { maxBytes: uploadCeiling } : {}),
    });
    throwIfCancelled(signal);

    // Which encoder the build turned out to have is invisible everywhere else.
    // It is not in the transcript, not in the job row and not in any error,
    // because on this path nothing failed — yet it decides both the size of the
    // upload and how the audio sounds by the time a recognizer hears it, and
    // those are the two things users write in about. One line here is what
    // turns "my uploads got bigger after the update" into a question with an
    // answer, without asking anyone to run ffmpeg themselves.
    log('info', 'compressed for upload', {
      encoder: encoding.label,
      bytes: fileSize(uploadPath),
      ...(uploadCeiling !== undefined ? { ceilingBytes: uploadCeiling } : {}),
    });

    update(job, {
      status: 'running',
      progress: { percent: EXTRACTION_CEILING, stage: 'Uploading' },
    });

    // `settings.cloud` is the base and the top-level switches override it. The
    // three that appear in both places — language, diarize, translate — are the
    // ones the main window exposes, so what the user last touched there is what
    // they mean; `settings.cloud` survives as the base because it carries
    // `wordTimestamps`, which has no control anywhere else.
    const options: CloudOptions = {
      ...settings.cloud,
      language: settings.language,
      diarize: settings.diarize,
      translate: settings.translate,
    };

    return adapterFor(target.providerId).transcribe(
      { apiKey, modelId: target.modelId, filePath: uploadPath, durationMs, options },
      {
        signal,
        onProgress: (percent, stage) => {
          progress(job, percent === null ? null : transcriptionPercent(percent), stage);
        },
      },
    );
  }

  async function writeAutoExports(
    job: Job,
    transcript: Transcript,
    settings: Settings,
  ): Promise<void> {
    const formats = settings.output.formats;
    if (formats.length === 0) return;

    const directory = settings.output.besideSource
      ? path.dirname(job.filePath)
      : settings.output.outputDir;
    // `null` means "ask on first export". There is nobody to ask from inside a
    // finished background job, and popping a dialog the user did not initiate —
    // possibly while they are in another app — is worse than writing nothing.
    // The transcript is in the UI, and Export is one click away.
    if (directory === null) return;

    if (!settings.output.besideSource) await mkdir(directory, { recursive: true });

    const options = {
      segmentation: { ...settings.segmentation, includeSpeakers: settings.output.includeSpeakers },
      includeSpeakers: settings.output.includeSpeakers,
      sourceName: job.fileName,
    };

    // Sequential, not `Promise.all`. Six concurrent writes into one directory
    // make the " (2)" suffixes race, so which format got the plain name and
    // which got the numbered one would differ between runs of the same job.
    for (const format of formats) {
      const text = renderTranscript(transcript, format, options);
      await writeWithoutOverwriting(path.join(directory, exportFileName(job.fileName, format)), text);
    }
  }

  return {
    enqueue(paths, target) {
      const created: Job[] = [];
      // Every path is authorized before it becomes a job. A path that fails gets
      // no job at all rather than a pre-failed one: it never became work, and a
      // red row for a file the app declined to even look at is noise. The caller
      // compares the returned length with what it sent and says so once.
      for (const filePath of authorizeAll(paths)) {
        const job: Job = {
          // A random id, not a counter. This string becomes a directory name
          // under the OS temp root, and a counter restarts at 1 on every launch
          // — so job 1 of this session would inherit the scratch directory job 1
          // of a crashed session left behind, and read its half-written WAV.
          id: randomUUID(),
          filePath,
          fileName: path.basename(filePath),
          bytes: fileSize(filePath),
          durationMs: null,
          target,
          status: 'queued',
          progress: { percent: null, stage: 'Queued' },
        };
        jobs.set(job.id, job);
        created.push(snapshot(job));
        emit(job);
      }
      pump();
      return created;
    },

    list() {
      return [...jobs.values()].map(snapshot);
    },

    cancel(id) {
      const job = jobs.get(id);
      if (job === undefined || isTerminal(job.status)) return;
      // Abort first, then mark. The running task will see `signal.aborted` in
      // `begin`'s catch and agree; a queued job has no controller and is simply
      // skipped by `pump` from here on. Either way the UI updates immediately
      // rather than waiting for ffmpeg to notice.
      controllers.get(id)?.abort();
      markCancelled(job);
    },

    retry(id) {
      const job = jobs.get(id);
      if (job === undefined) return;
      // Only failures and cancellations. Re-running a job that already succeeded
      // would write a second set of export files beside the first as
      // "name (2).srt", which is not what anybody means by "retry" — and the
      // originals would still be there, so nothing is even replaced. Dropping
      // the file again is the way to transcribe it twice.
      if (job.status !== 'failed' && job.status !== 'cancelled') return;

      delete job.error;
      delete job.transcript;
      delete job.startedAt;
      delete job.finishedAt;
      update(job, { status: 'queued', progress: { percent: null, stage: 'Queued' } });
      pump();
    },

    remove(id) {
      const job = jobs.get(id);
      if (job === undefined) return;
      // Aborting before deleting is what stops a removed job's ffmpeg from
      // running to completion in the background with nothing left to receive it.
      controllers.get(id)?.abort();
      markCancelled(job);
      jobs.delete(id);
      // No event is emitted: there is no "job removed" channel, and `emit`
      // ignores jobs that are no longer in the map anyway. The caller resolves
      // its IPC promise and drops its own copy.
    },

    clearFinished() {
      // Deleting from a Map while iterating it is well defined and skips nothing.
      for (const [id, job] of jobs) {
        if (isTerminal(job.status)) jobs.delete(id);
      }
    },

    onUpdate(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },

    shutdown() {
      shuttingDown = true;
      // Listeners go first, deliberately. This runs from `before-quit`, and a
      // `webContents.send` into a window that is already being destroyed throws
      // — a shutdown path is the last place worth handling that.
      listeners.clear();

      for (const controller of controllers.values()) controller.abort();
      // The status is set directly rather than through `update`, because there
      // is nobody left to notify and the in-memory state is about to be
      // discarded with the process. It is set at all so that anything else still
      // reading `list()` during teardown sees the truth.
      for (const job of jobs.values()) {
        if (!isTerminal(job.status)) {
          job.status = 'cancelled';
          job.finishedAt = Date.now();
        }
        cleanupJobTemp(job.id);
      }
    },
  };
}
