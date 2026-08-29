/**
 * The whole surface the renderer is allowed to see.
 *
 * One object, `window.dropscribe`, typed by `DropScribeApi`, exposed through
 * `contextBridge`. There is deliberately no generic `invoke(channel, ...args)`
 * here. That helper is the first thing people reach for and it hands the exact
 * capability back that context isolation exists to take away: a renderer that
 * can name a channel can call every handler main registers, including the ones
 * that write files and read the keychain. Enumerating the methods costs sixty
 * lines once and makes the attack surface something you can read in one screen.
 *
 * This file is bundled as CommonJS, not ESM. That is not a style preference:
 * a preload running with `sandbox: true` is loaded by a stripped-down module
 * system that has no ESM loader in it at all, and an ESM preload simply never
 * executes — the renderer comes up with `window.dropscribe` undefined and no
 * error anyone can find. `electron.vite.config.ts` pins the preload output to
 * `cjs` for this reason.
 *
 * Nothing in here does work. Every method is a forwarder, because a preload is
 * the one place in the app where a bug is reachable from renderer content *and*
 * runs with elevated privileges.
 */

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

import type {
  AppInfo,
  DropScribeApi,
  Job,
  KeyTestResult,
  ModelState,
  ProviderModel,
  ProviderState,
  Settings,
} from './api-types';

// ---------------------------------------------------------------------------
// Error messages the user is meant to read
// ---------------------------------------------------------------------------

/**
 * What Electron wraps every rejected `invoke` in.
 *
 * `ipcRenderer.invoke` does not re-throw the main-process error; it throws a new
 * one whose message is `Error invoking remote method 'jobs:enqueue': Error: …`.
 * Main writes those messages for the user — `path-policy.ts` explains that a
 * file may have been moved, `model-store.ts` explains that a download failed its
 * checksum — and every one of them arrives at the UI wearing a channel name and
 * a class name that mean nothing to anybody outside this repository.
 */
const REMOTE_METHOD_PREFIX = /^Error invoking remote method '[^']*':\s*/;

/**
 * The serialized error's own class prefix, left behind after the wrapper.
 *
 * Anchored on a capitalized identifier ending in `Error` so it matches `Error:`,
 * `TypeError:`, `QueueError:` and `ProviderError:` while leaving a real message
 * that happens to start with a word and a colon — `Note:`, `DropScribe:` —
 * completely alone.
 */
const ERROR_CLASS_PREFIX = /^[A-Z][A-Za-z0-9_$]*Error:\s*/;

/** A stack tail, on the builds that serialize one into the message. */
const STACK_TAIL = /\n\s+at\s[\s\S]*$/;

/** Shown only when stripping leaves nothing, which would be worse than useless. */
const FALLBACK_MESSAGE = 'Something went wrong inside DropScribe. Please try again.';

function userFacingMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const stripped = raw
    .replace(REMOTE_METHOD_PREFIX, '')
    .replace(ERROR_CLASS_PREFIX, '')
    .replace(STACK_TAIL, '')
    .trim();
  return stripped.length > 0 ? stripped : FALLBACK_MESSAGE;
}

/**
 * The only way this file talks to main, and the reason is the paragraph above.
 *
 * **Every new IPC method whose error text can reach the UI must go through
 * here.** A handler in `main.ts` that throws `new Error('Choose a folder for
 * transcripts in Settings first.')` has written a complete instruction for the
 * user; calling `ipcRenderer.invoke` directly turns it into "Error invoking
 * remote method 'output:exportMany': Error: Choose a folder…", and the renderer
 * then either shows that verbatim or grows its own second copy of this regex.
 *
 * The `as T` is a deliberate boundary cast. IPC is `unknown` on the wire by
 * construction, and `DropScribeApi` — compiled by both processes — is the one
 * declaration that says what each channel returns. There is nothing here to
 * validate against that main did not itself just produce.
 */
async function invokeUserFacing<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    const result: unknown = await ipcRenderer.invoke(channel, ...args);
    return result as T;
  } catch (error) {
    throw new Error(userFacingMessage(error));
  }
}

/**
 * Subscribe to a main→renderer push, and return a real unsubscribe.
 *
 * `removeListener` with the same function reference, never
 * `removeAllListeners(channel)`. The store subscribes once and a details panel
 * may subscribe again while it is mounted; `removeAllListeners` in the panel's
 * cleanup would silently tear down the store's subscription too, and the job
 * list would stop updating for the rest of the session with nothing in the
 * console to explain it.
 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    callback(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

const api: DropScribeApi = {
  // ── Files ─────────────────────────────────────────────────────────────────
  openFiles: () => invokeUserFacing<string[]>('files:open'),

  /**
   * The one synchronous call in the bridge, and it has to be.
   *
   * A `drop` handler must decide whether it is holding a usable file *inside*
   * the event: the moment it awaits, the DataTransfer is neutered and the paths
   * are gone. `sendSync` blocks the renderer for the length of one `realpath`
   * and one `stat` in main, which is invisible next to the file dialog the user
   * just dismissed. `!== true` rather than a truthiness check, so a handler that
   * somehow returned `undefined` reads as "no".
   */
  authorizePath: (path) => ipcRenderer.sendSync('files:authorize', path) === true,

  chooseOutputDir: () => invokeUserFacing<string | null>('files:chooseOutputDir'),

  revealFile: (path) => invokeUserFacing<void>('files:reveal', path),

  /**
   * Not IPC — a synchronous read of something Chromium already knows.
   *
   * Electron 32 removed the `File.path` augmentation, so in a sandboxed
   * renderer a dropped `File` carries no path at all and `webUtils` is the only
   * way back to one. It works only in the preload, where the `electron` module
   * exists. A `File` constructed in JavaScript yields `''`, which
   * `authorizePath` rejects like any other path that is not a readable media
   * file, so nothing downstream needs a special case for it.
   */
  pathForFile: (file) => webUtils.getPathForFile(file),

  // ── Jobs ──────────────────────────────────────────────────────────────────
  enqueue: (paths, target) => invokeUserFacing<Job[]>('jobs:enqueue', paths, target),
  listJobs: () => invokeUserFacing<Job[]>('jobs:list'),
  cancelJob: (id) => invokeUserFacing<void>('jobs:cancel', id),
  retryJob: (id) => invokeUserFacing<void>('jobs:retry', id),
  removeJob: (id) => invokeUserFacing<void>('jobs:remove', id),
  clearFinished: () => invokeUserFacing<void>('jobs:clearFinished'),
  onJobUpdated: (callback) => subscribe<Job>('jobs:updated', callback),

  // ── Local models ──────────────────────────────────────────────────────────
  listModels: () => invokeUserFacing<ModelState[]>('models:list'),
  downloadModel: (id) => invokeUserFacing<void>('models:download', id),
  cancelModelDownload: (id) => invokeUserFacing<void>('models:cancelDownload', id),
  deleteModel: (id) => invokeUserFacing<void>('models:delete', id),
  onModelUpdated: (callback) => subscribe<ModelState>('models:updated', callback),

  // ── Cloud providers ───────────────────────────────────────────────────────
  listProviders: () => invokeUserFacing<ProviderState[]>('providers:list'),
  testProviderKey: (id, key) => invokeUserFacing<KeyTestResult>('providers:testKey', id, key),
  saveProviderKey: (id, key) => invokeUserFacing<KeyTestResult>('providers:saveKey', id, key),
  clearProviderKey: (id) => invokeUserFacing<void>('providers:clearKey', id),
  refreshProviderModels: (id) => invokeUserFacing<ProviderModel[]>('providers:refreshModels', id),
  selectProviderModel: (id, modelId) => invokeUserFacing<void>('providers:selectModel', id, modelId),

  // ── Settings ──────────────────────────────────────────────────────────────
  getSettings: () => invokeUserFacing<Settings>('settings:get'),
  saveSettings: (patch) => invokeUserFacing<Settings>('settings:save', patch),

  // ── Output ────────────────────────────────────────────────────────────────
  renderTranscript: (jobId, format) => invokeUserFacing<string>('output:render', jobId, format),
  exportTranscript: (jobId, format) => invokeUserFacing<string | null>('output:export', jobId, format),
  exportMany: (jobIds, formats) => invokeUserFacing<number>('output:exportMany', jobIds, formats),
  copyTranscript: (jobId, format) => invokeUserFacing<void>('output:copy', jobId, format),

  // ── Misc ──────────────────────────────────────────────────────────────────
  getAppInfo: () => invokeUserFacing<AppInfo>('app:info'),
  openExternal: (link) => invokeUserFacing<void>('app:openExternal', link),
  getLicenses: () => invokeUserFacing<string>('app:licenses'),
};

/**
 * Frozen before it crosses.
 *
 * `contextBridge` copies functions into the main world rather than sharing the
 * object, so this freeze does not protect the renderer's copy — it protects
 * *this* one, in the isolated world, from anything else that might later run in
 * the preload realm. It is one call, and it makes the claim in `SECURITY.md`
 * ("one frozen object exposed through contextBridge") literally true.
 */
contextBridge.exposeInMainWorld('dropscribe', Object.freeze(api));
