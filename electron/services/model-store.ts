/**
 * Downloading, verifying and deleting the local model weights.
 *
 * The files here are between 550 MB and 3 GB, which is what makes almost every
 * decision in this file. At that size a download is not an atomic event the
 * user waits out — it is something they interrupt, resume tomorrow, and run
 * over a hotel connection that drops halfway. So:
 *
 * - bytes land in `<fileName>.part` and are renamed into place only after the
 *   SHA-256 matches, so a file with the catalogue's name is always a file the
 *   engine can load;
 * - an existing `.part` resumes with an HTTP Range request instead of starting
 *   over;
 * - cancelling LEAVES the `.part` behind, because "cancel" from a user holding
 *   2.4 GB of a 3 GB file means "not right now", not "throw it away";
 * - the hash is computed from the bytes as they stream past. Hashing a 3 GB
 *   file afterwards is a second full read — roughly a minute on a spinning
 *   disk, and pure waste when the bytes were already in hand.
 */

import { app } from 'electron';
import { createHash, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ModelState } from '../api-types';
import { findLocalModel, LOCAL_MODELS, type LocalModel } from '../shared/models';

/**
 * Progress is emitted at most this often.
 *
 * A 64 KB chunk size over a fast connection is several hundred callbacks per
 * second, each one an IPC message and a React render. 250 ms is four updates a
 * second: past the point where a progress bar looks smooth, and three orders of
 * magnitude below the rate the socket delivers at.
 */
const EMIT_INTERVAL_MS = 250;

type UpdateListener = (state: ModelState) => void;

interface ActiveDownload {
  controller: AbortController;
  listeners: Set<UpdateListener>;
  promise: Promise<void>;
  /** Bytes on disk right now, including anything a resume inherited. */
  receivedBytes: number;
  lastEmitAt: number;
}

const active = new Map<string, ActiveDownload>();

/**
 * The last failure per model, so a state rebuilt from disk can still show why
 * the previous attempt stopped. Cleared the moment a retry begins.
 */
const lastErrors = new Map<string, string>();

export function modelsDir(): string {
  const dir = join(app.getPath('userData'), 'models');
  // Created on read, not only on write. The path is shown in Settings with a
  // Reveal button, and revealing a directory that does not exist yet is a dead
  // end the user cannot fix.
  mkdirSync(dir, { recursive: true });
  return dir;
}

function requireModel(modelId: string): LocalModel {
  const model = findLocalModel(modelId);
  if (!model) throw new Error(`Unknown model “${modelId}”.`);
  return model;
}

export function modelPath(modelId: string): string {
  return join(modelsDir(), requireModel(modelId).fileName);
}

function partPathFor(finalPath: string): string {
  return `${finalPath}.part`;
}

function sizeOf(path: string): number {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Installed means present AND exactly the catalogue's byte count.
 *
 * Existence alone is not enough: the common failure is an interrupted copy or a
 * disk that filled up, which leaves a short file that whisper.cpp opens, reads a
 * truncated header from, and dies on with an error that says nothing about the
 * download. Comparing sizes catches that for the price of one `stat`. It is not
 * a substitute for the SHA — that runs once, at download time — but it is the
 * check that can afford to run on every listing.
 */
export function isInstalled(modelId: string): boolean {
  const model = findLocalModel(modelId);
  if (!model) return false;
  return sizeOf(join(modelsDir(), model.fileName)) === model.bytes;
}

function stateOf(model: LocalModel): ModelState {
  const finalPath = join(modelsDir(), model.fileName);
  const running = active.get(model.id);
  const finalSize = sizeOf(finalPath);
  const installed = finalSize === model.bytes;

  const onDiskBytes = running
    ? running.receivedBytes
    : installed
      ? finalSize
      : sizeOf(partPathFor(finalPath));

  const state: ModelState = {
    ...model,
    installed,
    onDiskBytes,
    downloading: running !== undefined,
    downloadPercent: running
      ? Math.min(100, Math.round((running.receivedBytes / model.bytes) * 1000) / 10)
      : null,
  };

  const error = lastErrors.get(model.id);
  if (error !== undefined) state.error = error;
  return state;
}

export function listModelStates(): ModelState[] {
  return LOCAL_MODELS.map(stateOf);
}

function emit(model: LocalModel, listeners: Iterable<UpdateListener>): void {
  const state = stateOf(model);
  for (const listener of listeners) listener(state);
}

function maybeEmit(model: LocalModel, running: ActiveDownload): void {
  const now = Date.now();
  if (now - running.lastEmitAt < EMIT_INTERVAL_MS) return;
  running.lastEmitAt = now;
  emit(model, running.listeners);
}

/**
 * Hash what is already in the `.part`, and report how many bytes that was.
 *
 * This is the one place a second read is unavoidable: a `Hash` cannot be
 * serialized between runs, so resuming a download means re-reading the prefix
 * to get the hash into the right state. Reading 2 GB of local disk to avoid
 * re-downloading 2 GB over the network is a trade worth making every time.
 *
 * The byte count comes from the read rather than from `stat` so the offset can
 * never disagree with what was actually hashed.
 */
async function hashExistingPart(partPath: string, hash: Hash): Promise<number> {
  let bytes = 0;
  for await (const chunk of createReadStream(partPath) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return bytes;
}

/** The full file size the server is claiming, or `null` if it did not say. */
function serverTotalBytes(response: Response): number | null {
  const contentRange = response.headers.get('content-range');
  if (contentRange !== null) {
    // `bytes 1024-3095033482/3095033483` — the part after the slash is the total.
    const match = /\/\s*(\d+)\s*$/.exec(contentRange);
    return match?.[1] !== undefined ? Number(match[1]) : null;
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength)) return Number(contentLength);
  return null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'ABORT_ERR');
}

async function runDownload(model: LocalModel, running: ActiveDownload): Promise<void> {
  const finalPath = join(modelsDir(), model.fileName);
  const partPath = partPathFor(finalPath);
  const signal = running.controller.signal;

  let hash = createHash('sha256');
  let offset = 0;

  const partSize = sizeOf(partPath);
  if (partSize > 0 && partSize < model.bytes) {
    offset = await hashExistingPart(partPath, hash);
    running.receivedBytes = offset;
  } else if (partSize >= model.bytes) {
    // A `.part` at or beyond the full size cannot be resumed into anything
    // valid — it was written by a different catalogue entry, or two downloads
    // appended to the same file. Start clean rather than serve a corrupt model.
    rmSync(partPath, { force: true });
  }
  if (signal.aborted) return;

  /**
   * Hugging Face `resolve` URLs are a 302 to a CDN (currently Cloudflare), and
   * the CDN host changes. Redirects must therefore be followed — `redirect:
   * 'follow'` is fetch's default, but it is spelled out because a future
   * refactor to `node:https`, which does NOT follow redirects on its own, would
   * otherwise download a few hundred bytes of redirect body and hash them.
   * The Range header survives the redirect; the CDN honours it.
   */
  const request = async (from: number): Promise<Response> =>
    fetch(model.url, {
      redirect: 'follow',
      signal,
      headers: from > 0 ? { Range: `bytes=${from}-` } : {},
    });

  let response = await request(offset);

  if (response.status === 416 && offset > 0) {
    // "Range Not Satisfiable": the remote file is now shorter than our offset,
    // so the `.part` belongs to a file that no longer exists. Drop it and take
    // the one restart this function allows itself.
    rmSync(partPath, { force: true });
    hash = createHash('sha256');
    offset = 0;
    running.receivedBytes = 0;
    response = await request(0);
  }

  if (!response.ok) {
    throw new Error(
      `Could not download ${model.label}: the server responded ${response.status} ${response.statusText || ''}`.trim() + '.',
    );
  }

  // A 200 in reply to a Range request means the server ignored it and is
  // sending the whole file. Appending that to the prefix would produce a file
  // of the right length made of the wrong bytes, which the SHA would catch an
  // hour later. Reset instead and pay for the restart now.
  const resumed = offset > 0 && response.status === 206;
  if (offset > 0 && !resumed) {
    hash = createHash('sha256');
    offset = 0;
    running.receivedBytes = 0;
  }

  const total = serverTotalBytes(response);
  if (total !== null && total !== model.bytes) {
    // Fail before writing gigabytes. The catalogue pins an exact size, so a
    // different one means the upstream file was replaced — the SHA is going to
    // fail regardless, and it is kinder to say so in the first second.
    rmSync(partPath, { force: true });
    throw new Error(
      `The published file for ${model.label} no longer matches DropScribe’s catalogue (the server offers ${total} bytes, the app expects ${model.bytes}). Update DropScribe and try again.`,
    );
  }

  const body = response.body;
  if (!body) throw new Error(`Could not download ${model.label}: the server sent an empty response.`);

  const source = Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  const sink = createWriteStream(partPath, { flags: resumed ? 'a' : 'w' });

  let received = 0;
  try {
    await pipeline(
      source,
      async function* hashing(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
        for await (const chunk of chunks) {
          hash.update(chunk);
          received += chunk.length;
          running.receivedBytes = offset + received;
          maybeEmit(model, running);
          yield chunk;
        }
      },
      sink,
      { signal },
    );
  } catch (error) {
    // On abort `pipeline` destroys the writable, so whatever it had already
    // flushed stays in the `.part` — which is exactly what resume needs. The
    // tail may be short by one buffered chunk; that is harmless, because a
    // resume re-hashes the file it actually finds rather than trusting a
    // remembered length.
    if (isAbortError(error) || signal.aborted) return;
    throw error;
  }

  const written = offset + received;
  if (written !== model.bytes) {
    // A short read is a dropped connection, not corruption. The `.part` is left
    // in place so the retry picks up where this attempt stopped.
    throw new Error(
      `The download of ${model.label} ended early (${written} of ${model.bytes} bytes). Check your connection and try again — it will resume.`,
    );
  }

  const digest = hash.digest('hex');
  if (digest !== model.sha256.toLowerCase()) {
    // Unlike a short read, a hash mismatch means the bytes on disk are wrong,
    // and resuming from them would only ever produce the same wrong file. The
    // partial file has to go.
    rmSync(partPath, { force: true });
    throw new Error(
      `${model.label} failed its integrity check and was discarded. The file did not match the checksum DropScribe expects, so it was not installed. Please try downloading it again.`,
    );
  }

  // Only now does the file get the name the engine looks for.
  renameSync(partPath, finalPath);
}

/**
 * Start (or join) a download.
 *
 * Resolves when the file is installed, when the user cancelled, or when the
 * model was already on disk. Rejects only on a real failure, with a message
 * written for the user.
 */
export function download(modelId: string, onUpdate: UpdateListener): Promise<void> {
  const model = requireModel(modelId);

  const existing = active.get(modelId);
  if (existing) {
    // A second Download click, or two windows watching the same model. Join the
    // download in flight rather than opening a second socket onto the same
    // `.part` and interleaving two writers into one file.
    existing.listeners.add(onUpdate);
    onUpdate(stateOf(model));
    return existing.promise;
  }

  if (isInstalled(modelId)) {
    onUpdate(stateOf(model));
    return Promise.resolve();
  }

  lastErrors.delete(modelId);

  const running: ActiveDownload = {
    controller: new AbortController(),
    listeners: new Set([onUpdate]),
    receivedBytes: sizeOf(partPathFor(join(modelsDir(), model.fileName))),
    lastEmitAt: 0,
    promise: Promise.resolve(),
  };
  active.set(modelId, running);

  running.promise = runDownload(model, running)
    .catch((error: unknown) => {
      lastErrors.set(modelId, error instanceof Error ? error.message : String(error));
      throw error;
    })
    .finally(() => {
      active.delete(modelId);
      // The final emit happens after the entry is removed, so listeners see
      // `downloading: false` and the real on-disk size — success, failure and
      // cancellation all reach the UI through this one path.
      emit(model, running.listeners);
      running.listeners.clear();
    });

  emit(model, running.listeners);
  return running.promise;
}

/**
 * Stop a download in flight, keeping the partial file.
 *
 * Deleting the `.part` here would be the tidier-looking choice and the wrong
 * one: cancelling at 90% of a 3 GB file and finding the progress back at zero
 * tomorrow is the behaviour that makes people stop trusting a download manager.
 */
export function cancelDownload(modelId: string): void {
  active.get(modelId)?.controller.abort();
}

export function deleteModel(modelId: string): void {
  const model = requireModel(modelId);

  // A delete during a download aborts it first, or the writer would recreate
  // the `.part` a moment after it was removed.
  cancelDownload(modelId);
  lastErrors.delete(modelId);

  const finalPath = join(modelsDir(), model.fileName);
  // Both files: leaving an orphaned `.part` behind means "Delete" frees a
  // fraction of the space the user expected, and a later download silently
  // resumes from bytes they thought they had thrown away.
  rmSync(finalPath, { force: true });
  rmSync(partPathFor(finalPath), { force: true });
}
