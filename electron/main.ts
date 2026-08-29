/**
 * The main process: the window, the menu, and every IPC handler in the app.
 *
 * Everything reachable from here has already been written and tested on its
 * own — the queue transcribes, `path-policy` decides what may be touched,
 * `model-store` downloads, the adapters talk to providers. This file is the
 * wiring, and its job is to be boring: validate what came across the bridge,
 * call exactly one module, hand back what it returned.
 *
 * The two places it is not boring are worth reading before changing anything.
 *
 * **Nothing the renderer sends is trusted.** Every handler re-derives its
 * arguments from `unknown` through a guard in this file rather than believing
 * the `DropScribeApi` types, because those types describe what *our* renderer
 * sends and the threat model is a renderer that has stopped being ours.
 *
 * **Every error message thrown from a handler is written for the user.** The
 * preload strips Electron's `Error invoking remote method …` wrapper and the
 * UI shows what is left verbatim, so a message here that says `EACCES` or
 * `undefined is not a function` is a message that ships to a user's screen.
 */

import { basename, dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
  type WebContents,
} from 'electron';

import { EXPORT_FORMATS } from './api-types';
import type { AppInfo, ExportFormat, ProviderState, Settings } from './api-types';
import { engineReport, enginesReady, licenseNoticePath } from './binaries-runtime';
import { authorize, authorizeAll, isAuthorized } from './path-policy';
import { adapterFor } from './providers';
import { clearKey, getKey, hasKey, keyPreview, setKey } from './services/credentials';
import { log } from './services/logger';
import {
  cancelDownload,
  deleteModel,
  download,
  listModelStates,
  modelsDir,
} from './services/model-store';
import {
  clearProviderRecord,
  getProviderRecord,
  getSettings,
  saveProviderRecord,
  saveSettings,
} from './services/settings';
import { sweepOrphanedTemp } from './services/temp';
import type { RenderOptions } from './shared/exports';
import { exportFileName, renderTranscript } from './shared/exports';
import type { Job, TranscribeTarget } from './shared/jobs';
import { OPEN_DIALOG_FILTERS } from './shared/media-extensions';
import type { ProviderId, ProviderModel, KeyTestResult } from './shared/providers';
import { PROVIDERS, findProvider } from './shared/providers';
import type { Transcript } from './shared/transcript';
import { createQueue } from './transcribe/queue';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The only destinations `shell.openExternal` will ever be handed.
 *
 * Hardcoded rather than read from `package.json`, which is bundled into the
 * main chunk and would put a URL the build pipeline controls into a call that
 * opens the user's browser. Two string literals are not worth that.
 */
const REPO_URL = 'https://github.com/markdudov/dropscribe';
const ISSUES_URL = `${REPO_URL}/issues`;

/**
 * How long a key test or a model-list fetch may run before it is abandoned.
 *
 * The caller is a button with a spinner on it. A provider that accepts the
 * connection and then says nothing — a captive-portal Wi-Fi, a corporate proxy
 * holding the request open — would otherwise leave that spinner turning until
 * the user quits the app. Thirty seconds is far longer than any of the four
 * providers needs and short enough that a stuck request is recognisably stuck.
 */
const PROVIDER_REQUEST_TIMEOUT_MS = 30_000;

/** Suffixes tried before `writeWithoutOverwriting` gives up. Mirrors the queue's. */
const MAX_NAME_ATTEMPTS = 999;

const MIN_WINDOW_WIDTH = 900;
const MIN_WINDOW_HEIGHT = 620;

/**
 * The first paint, before React has mounted anything.
 *
 * `show: false` until `ready-to-show` removes the white flash of an empty
 * window, but not the flash of an unstyled document once it is shown. Painting
 * the frame in something close to the app's own background is one property and
 * removes the last of it.
 */
const LIGHT_BACKGROUND = '#f5f5f4';
const DARK_BACKGROUND = '#0c0a09';

// ---------------------------------------------------------------------------
// Process-wide state
// ---------------------------------------------------------------------------

const queue = createQueue();

let mainWindow: BrowserWindow | null = null;

/**
 * Whether the renderer has finished loading and can receive pushes.
 *
 * Files opened from Finder, from Explorer, or from the command line arrive
 * before there is a window at all — `open-file` on macOS routinely fires
 * *before* `whenReady`. They wait in `pendingFiles` until there is something to
 * enqueue them into.
 */
let rendererReady = false;
const pendingFiles: string[] = [];

/**
 * Paths `files:reveal` will open a file manager on.
 *
 * `shell.showItemInFolder` only selects an item in Finder or Explorer, so it is
 * a great deal less dangerous than `shell.openPath` — which would *execute* a
 * `.command` or a `.bat` — but it still discloses the existence of any path the
 * renderer names, and "which files exist on this disk" is exactly the kind of
 * question a compromised renderer wants answered. So reveal, like everything
 * else here, works from a list main itself built: media the user pointed at
 * (via `path-policy`), a folder they chose in a dialog, files this process
 * wrote, and the models directory it owns.
 */
const revealable = new Set<string>();

/** In development electron-vite exports the dev server here; a packaged app has no such variable. */
const devServerUrl = process.env['ELECTRON_RENDERER_URL'];

/**
 * `__dirname` resolves inside `out/main/`, which is where electron-vite puts
 * this file, so the renderer bundle is one directory over. electron-vite injects
 * the `__dirname` shim into its ESM output; this is the documented way to find
 * sibling bundles and does not need a `fileURLToPath` dance of its own.
 */
const rendererFile = join(__dirname, '../renderer/index.html');

// ---------------------------------------------------------------------------
// Argument guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The message for an argument that could not have come from our own renderer.
 *
 * Phrased as a bug report rather than as advice, because it is one: there is no
 * user action that produces a malformed job id, and telling somebody to "try
 * again" when the cause is a mismatched build wastes their afternoon.
 */
function malformed(what: string): Error {
  return new Error(
    `DropScribe received an unusable ${what} from its own interface. This is a bug — please report it at ${ISSUES_URL}.`,
  );
}

/**
 * An API key as the user typed it, or a failed test explaining why it is not one.
 *
 * `requireString` is the right guard for an IPC argument, because a non-string
 * where a string belongs really is a bug in our own code. An EMPTY key is not:
 * it is somebody pressing Test connection on a blank field, or pasting
 * whitespace. Throwing "this is a bug — please report it" at them for that is
 * both wrong and alarming, so the two cases are separated here. Trimming also
 * saves the far more common paste-with-a-trailing-newline, which every one of
 * these APIs would otherwise reject with an authentication error the user has
 * no way to interpret.
 */
function readApiKey(value: unknown, providerLabel: string): { key: string } | { failure: KeyTestResult } {
  if (typeof value !== 'string') throw malformed('API key');
  const key = value.trim();
  if (key.length === 0) {
    return { failure: { ok: false, message: `Paste your ${providerLabel} API key first.` } };
  }
  return { key };
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw malformed(what);
  return value;
}

function requireStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) throw malformed(what);
  const out: string[] = [];
  // Non-strings are dropped rather than fatal. A selection array is assembled
  // in the renderer from a list that may have changed underneath it, and one
  // stale hole in it should not cost the user the other nine exports.
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) out.push(entry);
  }
  return out;
}

function requireProviderId(value: unknown): ProviderId {
  if (typeof value === 'string') {
    for (const provider of PROVIDERS) {
      if (provider.id === value) return provider.id;
    }
  }
  throw new Error(
    `This build of DropScribe has no provider called “${String(value)}”. Pick a different one in Settings.`,
  );
}

function requireFormat(value: unknown): ExportFormat {
  if (typeof value === 'string') {
    for (const format of EXPORT_FORMATS) {
      if (format === value) return format;
    }
  }
  throw malformed('export format');
}

/**
 * Rebuild a `TranscribeTarget` from whatever arrived, field by field.
 *
 * Not a shape check followed by a cast: the object is reconstructed from the
 * three fields that are allowed to exist, so a payload carrying anything extra
 * loses it here rather than at whatever depth of the queue first reads it.
 */
function requireTarget(value: unknown): TranscribeTarget {
  if (isRecord(value)) {
    const modelId = value['modelId'];
    if (typeof modelId === 'string' && modelId.length > 0) {
      if (value['kind'] === 'local') return { kind: 'local', modelId };
      if (value['kind'] === 'cloud') {
        return { kind: 'cloud', providerId: requireProviderId(value['providerId']), modelId };
      }
    }
  }
  throw new Error(
    'DropScribe could not tell which model that file should run through. Choose one again and retry.',
  );
}

/**
 * A settings patch, forwarded as-is on purpose.
 *
 * `services/settings.ts` coerces every leaf against the current value — that is
 * what `coerceSettings` is for, and it is the only place that knows each
 * field's range. Re-validating here would be a second, drifting copy of those
 * rules; the only thing worth asserting at this boundary is that the patch is
 * an object at all, since a string or an array would sail through the coercer
 * as "no fields present" and silently do nothing.
 */
function requireSettingsPatch(value: unknown): Partial<Settings> {
  if (!isRecord(value)) throw malformed('settings change');
  return value as Partial<Settings>;
}

// ---------------------------------------------------------------------------
// Job and export helpers
// ---------------------------------------------------------------------------

function findJob(jobId: string): Job | undefined {
  return queue.list().find((job) => job.id === jobId);
}

function requireJob(jobId: string): Job {
  const job = findJob(jobId);
  if (job === undefined) {
    throw new Error('That job is no longer in the list — it may have been cleared or removed.');
  }
  return job;
}

function requireTranscript(job: Job): Transcript {
  if (job.transcript === undefined) {
    throw new Error(`“${job.fileName}” has no transcript yet. It has to finish first.`);
  }
  return job.transcript;
}

/**
 * The render options the queue's own auto-export uses, rebuilt here.
 *
 * Deliberately identical to `writeAutoExports` in `transcribe/queue.ts`,
 * including the way `includeSpeakers` is pushed down into the segmentation
 * options as well as passed alongside them. The preview pane, the clipboard,
 * the Export dialog and the file written automatically when a job finishes all
 * have to produce byte-identical text; the moment one of them derives its
 * options differently, a user's saved `.srt` stops matching the one they were
 * just reading, and nobody ever files that bug because nobody believes it.
 */
function renderOptionsFor(job: Job, settings: Settings): RenderOptions {
  return {
    segmentation: { ...settings.segmentation, includeSpeakers: settings.output.includeSpeakers },
    includeSpeakers: settings.output.includeSpeakers,
    sourceName: job.fileName,
  };
}

function errnoCodeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Write without ever replacing an existing file.
 *
 * The same rule, and the same `wx` implementation, as the queue's auto-export —
 * see the long comment on `writeWithoutOverwriting` in `transcribe/queue.ts`
 * for why stat-then-write loses the race. It is duplicated rather than exported
 * because the two callers differ in everything except this one invariant, and
 * an `exports-fs.ts` holding a single twelve-line function would be a module
 * created to avoid twelve lines.
 *
 * This governs `output:exportMany` only. `output:export` goes through the
 * system save dialog, which has already asked the user about overwriting and
 * has their answer; second-guessing it there would rename the file they just
 * typed a name for.
 */
async function writeWithoutOverwriting(desired: string, text: string): Promise<string> {
  const directory = dirname(desired);
  const dot = basename(desired).lastIndexOf('.');
  const name = basename(desired);
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';

  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const candidate = attempt === 1 ? desired : join(directory, `${stem} (${attempt})${extension}`);
    try {
      await writeFile(candidate, text, { encoding: 'utf8', flag: 'wx' });
      return candidate;
    } catch (error) {
      if (errnoCodeOf(error) === 'EEXIST') continue;
      throw error;
    }
  }

  throw new Error(
    `There are already ${MAX_NAME_ATTEMPTS} transcripts with this name in that folder. Move some of them somewhere else first.`,
  );
}

/** Where a batch export writes, or a sentence explaining why it cannot. */
function batchExportDirectory(job: Job, settings: Settings): string {
  if (settings.output.besideSource) return dirname(job.filePath);
  const configured = settings.output.outputDir;
  if (configured === null) {
    throw new Error(
      'Choose a folder for transcripts in Settings first, or turn on “Save beside the original file”.',
    );
  }
  return configured;
}

/** Where the save dialog should open. Never throws — a dialog can start anywhere. */
function suggestedExportDirectory(job: Job, settings: Settings): string {
  if (settings.output.besideSource) return dirname(job.filePath);
  return settings.output.outputDir ?? dirname(job.filePath);
}

// ---------------------------------------------------------------------------
// Windows and navigation
// ---------------------------------------------------------------------------

function send(channel: string, payload: unknown): void {
  const window = mainWindow;
  // `isDestroyed` rather than a try/catch: `webContents.send` into a window
  // that is closing throws, and this is called from a download callback and a
  // queue listener that both outlive the window they were started from.
  if (window === null || window.isDestroyed()) return;
  window.webContents.send(channel, payload);
}

/**
 * Whether a URL is the app's own document.
 *
 * In a packaged app the whole answer is the file path: one HTML file, loaded
 * once, and any other `file:` URL is something that should never have been
 * navigated to. Query and hash are ignored so a hash router can move between
 * views without tripping this.
 *
 * In development the dev server is the origin and any path under it is Vite's
 * to serve — HMR and the React refresh runtime both fetch from it — so origin
 * equality is the right test there and a path check would break the dev loop
 * for no security gain: the dev server serves only this app.
 */
function isOwnDocument(target: string): boolean {
  let url: URL;
  let own: URL;
  try {
    url = new URL(target);
    own = new URL(devServerUrl ?? pathToFileURL(rendererFile).toString());
  } catch {
    return false;
  }
  if (url.protocol !== own.protocol) return false;
  if (url.protocol === 'file:') return url.pathname === own.pathname;
  return url.origin === own.origin;
}

/**
 * Refuse to let renderer content navigate or open a window.
 *
 * **A denied navigation is dropped, not forwarded to `shell.openExternal`.**
 * The forwarding pattern is everywhere in Electron tutorials, and it quietly
 * undoes the entire reason `ExternalLinkId` exists: `window.open('https://…')`,
 * an injected `<a target="_blank">`, or a single `location = …` in any script
 * that reaches the renderer would then hand an arbitrary URL to the user's
 * default browser. That is an exfiltration channel — the URL can carry
 * whatever the renderer knows in its query string — and a phishing one, opened
 * from an app the user trusts. Links the app genuinely offers go through
 * `app:openExternal`, which takes a semantic id and looks the URL up here.
 *
 * Attached to every `WebContents` the app ever creates rather than to the one
 * window, so a future about-panel or print preview inherits it instead of
 * quietly becoming the exception.
 */
function hardenContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  contents.on('will-navigate', (details) => {
    if (isOwnDocument(details.url)) return;
    details.preventDefault();
    log('warn', 'blocked a navigation out of the app document', { url: details.url });
  });

  contents.on('will-frame-navigate', (details) => {
    if (isOwnDocument(details.url)) return;
    details.preventDefault();
    log('warn', 'blocked a frame navigation out of the app document', { url: details.url });
  });

  // The app has no `<webview>` anywhere. Denying the attach means adding one by
  // accident cannot silently create a second renderer without these guards.
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    // Shown from `ready-to-show`, so the user never sees an empty white frame
    // while the renderer bundle parses.
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND,
    // The traffic lights inset into the app's own header on macOS. Spread
    // conditionally because `exactOptionalPropertyTypes` will not accept the
    // property being present and `undefined` on the other platforms.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      // A renderer with no <webview> in it should not be able to grow one.
      webviewTag: false,
    },
  });

  mainWindow = window;
  rendererReady = false;

  window.once('ready-to-show', () => {
    window.show();
  });

  window.webContents.on('did-finish-load', () => {
    rendererReady = true;
    flushPendingFiles();
  });

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
      rendererReady = false;
    }
  });

  if (devServerUrl !== undefined && devServerUrl.length > 0) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(rendererFile);
  }
}

// ---------------------------------------------------------------------------
// Files arriving from outside the renderer
// ---------------------------------------------------------------------------

async function showOpenDialog(parent: BrowserWindow | null): Promise<string[]> {
  const options: OpenDialogOptions = {
    title: 'Open audio or video',
    buttonLabel: 'Transcribe',
    properties: ['openFile', 'multiSelections'],
    filters: OPEN_DIALOG_FILTERS,
  };
  const result =
    parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
  if (result.canceled) return [];
  // Authorized here, not in the caller: a path is only usable because *this*
  // dialog produced it, and `authorizeAll` returns the canonical paths, so the
  // renderer's copy and the queue's copy are the same string.
  return authorizeAll(result.filePaths);
}

/**
 * Everything the app was asked to open without the renderer's involvement:
 * a double-clicked file, `open -a DropScribe clip.mp4`, a drop on the Dock
 * icon, or File → Open… from the menu.
 *
 * These take the settings' default target, because there is nobody to ask.
 * The alternative — a new main→renderer channel that hands the paths over and
 * lets the UI pick — would need an API method the renderer does not have; going
 * through `enqueue` means the jobs reach the UI over `jobs:updated` like every
 * other job, and a renderer that was not listening yet still finds them in its
 * first `jobs:list`.
 */
function acceptExternalFiles(paths: string[]): void {
  if (paths.length === 0) return;
  pendingFiles.push(...paths);
  flushPendingFiles();
}

function flushPendingFiles(): void {
  const window = mainWindow;
  if (window === null || !rendererReady || pendingFiles.length === 0) return;

  const paths = pendingFiles.splice(0, pendingFiles.length);
  const target = getSettings().defaultTarget;

  if (target === null) {
    // Silently dropping the file would be the tidiest code and the cruellest
    // behaviour: the user double-clicked a film and the app opened, did
    // nothing, and gave no reason. This is the one place main talks to the user
    // directly, because there is no job to attach an error to.
    void dialog.showMessageBox(window, {
      type: 'info',
      message: 'DropScribe has nothing to transcribe with yet.',
      detail:
        paths.length === 1
          ? `Download a local model or add a provider key in Settings, then open “${basename(paths[0] ?? '')}” again.`
          : 'Download a local model or add a provider key in Settings, then open those files again.',
      buttons: ['OK'],
    });
    return;
  }

  const created = queue.enqueue(paths, target);
  if (created.length < paths.length) {
    log('warn', 'some externally opened files were refused', {
      offered: paths.length,
      queued: created.length,
    });
  }
  if (window.isMinimized()) window.restore();
  window.focus();
}

/**
 * Media paths hiding in `process.argv`.
 *
 * The slice differs by build: a packaged app is launched as
 * `DropScribe.exe file.mp4`, while `electron-vite dev` launches
 * `electron . --flag`, where `argv[1]` is the app directory and not a file.
 * Switches are skipped outright, and `authorizeAll` throws out everything that
 * is not a readable media file anyway — so `.` and `--no-sandbox` never survive
 * even if the slice is wrong on some future launcher.
 */
function mediaFilesInArgv(argv: string[]): string[] {
  const start = app.isPackaged ? 1 : 2;
  const candidates: string[] = [];
  for (let index = start; index < argv.length; index++) {
    const value = argv[index];
    if (value === undefined || value.length === 0 || value.startsWith('-')) continue;
    candidates.push(value);
  }
  return authorizeAll(candidates);
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [];

  // The macOS application menu — About, Services, Hide, Quit. Building it by
  // hand is how apps end up without Services or without the standard Hide
  // Others accelerator; the role gives the platform's own menu.
  if (isMac) template.push({ role: 'appMenu' });

  template.push({
    label: 'File',
    submenu: [
      {
        label: 'Open…',
        accelerator: 'CmdOrCtrl+O',
        click: () => {
          void openFromMenu();
        },
      },
      { type: 'separator' },
      // Cmd+W closes the window on macOS and the app keeps running; everywhere
      // else the last window closing is quitting, so Quit is the honest item.
      { role: isMac ? 'close' : 'quit' },
    ],
  });

  // `editMenu` and not a hand-written list. The renderer has text fields — the
  // API key input, the language filter — and on macOS Undo, Redo, Cut, Copy,
  // Paste and Select All only work inside them if the menu carries those roles.
  // An Edit menu missing them does not fall back to the system's: it *removes*
  // Cmd+Z from every field in the app.
  template.push({ role: 'editMenu' });
  template.push({ role: 'viewMenu' });
  template.push({ role: 'windowMenu' });

  template.push({
    role: 'help',
    submenu: [
      {
        label: 'DropScribe on GitHub',
        click: () => {
          void openExternalUrl(REPO_URL);
        },
      },
      {
        label: 'Report an Issue…',
        click: () => {
          void openExternalUrl(ISSUES_URL);
        },
      },
    ],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openFromMenu(): Promise<void> {
  acceptExternalFiles(await showOpenDialog(mainWindow));
}

// ---------------------------------------------------------------------------
// External links
// ---------------------------------------------------------------------------

/**
 * A semantic id to a URL, or `null` for anything unrecognised.
 *
 * Compared against fully built literals rather than parsed into a prefix and an
 * id, so `provider-key:` plus something that merely looks like a provider id
 * cannot reach `findProvider`. The set of openable URLs is exactly: this repo,
 * its issues, and the two documented URLs each provider declares.
 */
function resolveExternalLink(link: string): string | null {
  if (link === 'repo') return REPO_URL;
  if (link === 'issues') return ISSUES_URL;
  for (const provider of PROVIDERS) {
    if (link === `provider-key:${provider.id}`) return provider.keyUrl;
    if (link === `provider-docs:${provider.id}`) return provider.docsUrl;
  }
  return null;
}

/**
 * Hand a URL to the OS, after checking it is https.
 *
 * Every URL that reaches here came from a constant in this repository, so the
 * check can never fail today. It is here for the day somebody adds a fifth
 * provider and types `http://` — `shell.openExternal` will happily open
 * `file:`, `smb:` and any protocol handler the machine has registered, and that
 * is a much larger blast radius than a typo deserves.
 */
async function openExternalUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw malformed('link');
  }
  if (parsed.protocol !== 'https:') throw malformed('link');
  await shell.openExternal(parsed.toString());
}

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

function providerStates(): ProviderState[] {
  return PROVIDERS.map((descriptor) => {
    const record = getProviderRecord(descriptor.id);
    const state: ProviderState = {
      id: descriptor.id,
      hasKey: hasKey(descriptor.id),
      models: record.models,
    };
    // Spread-free conditional assignment, because `exactOptionalPropertyTypes`
    // treats `keyPreview: undefined` as a different thing from an absent key.
    const preview = keyPreview(descriptor.id);
    if (preview !== undefined) state.keyPreview = preview;
    if (record.lastTest !== undefined) state.lastTest = record.lastTest;
    if (record.selectedModelId !== undefined) state.selectedModelId = record.selectedModelId;
    return state;
  });
}

function requireStoredKey(id: ProviderId): string {
  const key = getKey(id);
  if (key === null || key.length === 0) {
    const label = PROVIDERS.find((provider) => provider.id === id)?.label ?? id;
    throw new Error(`There is no ${label} key saved. Add one in Settings first.`);
  }
  return key;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/**
 * `ipcMain.handle` with one place to log the failure.
 *
 * The error is re-thrown untouched — the preload strips Electron's wrapper and
 * the UI shows the message verbatim — but it is also written to the log here,
 * where the stack is still attached. `logger.redact` scrubs anything key-shaped
 * on the way to disk, which is why the message can be logged at all.
 */
function handle(channel: string, listener: InvokeHandler): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      return await listener(event, ...args);
    } catch (error) {
      log('error', `ipc handler failed: ${channel}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
}

function windowOf(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function registerIpc(): void {
  // ── Files ─────────────────────────────────────────────────────────────────

  handle('files:open', async (event) => showOpenDialog(windowOf(event)));

  /**
   * Synchronous by contract. See `DropScribeApi.authorizePath`: a drop handler
   * has to answer inside the event, before the DataTransfer is neutered, so
   * this is `ipcMain.on` with `event.returnValue` rather than a `handle`.
   * The work behind it is one `realpath` and one `stat`.
   *
   * The try/catch is not defending against `authorize`, which swallows every
   * filesystem error itself. It is defending against the shape of `sendSync`:
   * a handler that throws before assigning `returnValue` leaves the renderer
   * blocked on a reply that will never come, and the app is then frozen with
   * no error anywhere. Answering "no" is always survivable; not answering is
   * not.
   */
  ipcMain.on('files:authorize', (event, path: unknown) => {
    let accepted = false;
    try {
      accepted = typeof path === 'string' && authorize(path);
    } catch (error) {
      log('error', 'files:authorize threw', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    event.returnValue = accepted;
  });

  handle('files:chooseOutputDir', async (event) => {
    const parent = windowOf(event);
    const options: OpenDialogOptions = {
      title: 'Choose where transcripts are saved',
      buttonLabel: 'Choose folder',
      properties: ['openDirectory', 'createDirectory'],
    };
    const result =
      parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
    const chosen = result.canceled ? undefined : result.filePaths[0];
    if (chosen === undefined) return null;
    revealable.add(chosen);
    return chosen;
  });

  handle('files:reveal', async (_event, rawPath) => {
    const target = requireString(rawPath, 'path');
    const settings = getSettings();
    const allowed =
      isAuthorized(target) ||
      revealable.has(target) ||
      target === modelsDir() ||
      (settings.output.outputDir !== null && target === settings.output.outputDir);
    if (!allowed) {
      throw new Error('DropScribe can only reveal files you added and files it wrote itself.');
    }
    // Not `shell.openPath`, which would *run* an executable that happens to sit
    // at this path. Revealing selects the item and leaves the decision to open
    // it with the user, in their file manager, where they can see what it is.
    shell.showItemInFolder(target);
  });

  // ── Jobs ──────────────────────────────────────────────────────────────────

  handle('jobs:enqueue', async (_event, rawPaths, rawTarget) => {
    const paths = requireStringArray(rawPaths, 'file list');
    const target = requireTarget(rawTarget);
    // The queue authorizes every path itself and drops the ones that fail, so a
    // renderer-supplied string that was never through `files:authorize` gets no
    // job. The renderer compares the returned length with what it sent.
    return queue.enqueue(paths, target);
  });

  handle('jobs:list', async () => queue.list());

  handle('jobs:cancel', async (_event, rawId) => {
    queue.cancel(requireString(rawId, 'job id'));
  });

  handle('jobs:retry', async (_event, rawId) => {
    queue.retry(requireString(rawId, 'job id'));
  });

  handle('jobs:remove', async (_event, rawId) => {
    queue.remove(requireString(rawId, 'job id'));
  });

  handle('jobs:clearFinished', async () => {
    queue.clearFinished();
  });

  // ── Local models ──────────────────────────────────────────────────────────

  handle('models:list', async () => listModelStates());

  handle('models:download', async (_event, rawId) => {
    const id = requireString(rawId, 'model id');
    // Every progress tick goes straight to the window. `model-store` throttles
    // them; a second Download click joins the download already in flight rather
    // than opening a second socket, and both callbacks are notified.
    await download(id, (state) => {
      send('models:updated', state);
    });
  });

  handle('models:cancelDownload', async (_event, rawId) => {
    const id = requireString(rawId, 'model id');
    cancelDownload(id);
    // `cancelDownload` aborts the request; the store's own `finally` emits the
    // final state to the listener registered by `models:download`. Nothing to
    // push here, and pushing a state read before the abort settled would show a
    // stale percentage.
  });

  handle('models:delete', async (_event, rawId) => {
    const id = requireString(rawId, 'model id');
    deleteModel(id);
    // Delete has no listener of its own, so this is the one path where the UI
    // would otherwise keep showing an installed model until something else
    // happened to refresh the list.
    const state = listModelStates().find((entry) => entry.id === id);
    if (state !== undefined) send('models:updated', state);
  });

  // ── Cloud providers ───────────────────────────────────────────────────────

  handle('providers:list', async () => providerStates());

  handle('providers:testKey', async (_event, rawId, rawKey) => {
    const id = requireProviderId(rawId);
    const read = readApiKey(rawKey, findProvider(id)?.label ?? id);
    if ('failure' in read) return read.failure;
    const { key } = read;
    // Nothing is written. Not the key, and not `lastTest` either: a test the
    // user ran on a key they then discarded must leave no trace in settings,
    // or the panel comes back next launch claiming a connection that has no
    // key behind it.
    return adapterFor(id).testKey(key, AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS));
  });

  handle('providers:saveKey', async (_event, rawId, rawKey) => {
    const id = requireProviderId(rawId);
    const read = readApiKey(rawKey, findProvider(id)?.label ?? id);
    if ('failure' in read) return read.failure;
    const { key } = read;
    const adapter = adapterFor(id);

    const result = await adapter.testKey(key, AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS));
    // **A key that failed its test never reaches the keychain.** Storing first
    // and testing after is the ordering that leaves a typo in the OS keystore
    // forever, silently failing every job the user starts until they think to
    // re-open Settings and look at a red badge they have learned to ignore.
    if (!result.ok) return result;

    setKey(id, key);

    // Most adapters answer both questions in one round trip and hand the models
    // back on the test result. The ones that cannot get a second call, and a
    // failure there is not fatal: the key is good and saved, and the model list
    // can be refreshed from the panel.
    let models: ProviderModel[] = result.models ?? [];
    if (models.length === 0) {
      try {
        models = await adapter.listModels(key, AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS));
      } catch (error) {
        log('warn', 'saved a provider key but could not list its models', {
          provider: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    saveProviderRecord(id, { models, lastTest: result });
    return { ...result, models };
  });

  handle('providers:clearKey', async (_event, rawId) => {
    const id = requireProviderId(rawId);
    clearKey(id);
    // The cached models and the green "connected" result go with it. Leaving
    // them would make the row look configured when there is no key behind it.
    clearProviderRecord(id);
  });

  handle('providers:refreshModels', async (_event, rawId) => {
    const id = requireProviderId(rawId);
    const models = await adapterFor(id).listModels(
      requireStoredKey(id),
      AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
    );
    saveProviderRecord(id, { models });
    return models;
  });

  handle('providers:selectModel', async (_event, rawId, rawModelId) => {
    const id = requireProviderId(rawId);
    saveProviderRecord(id, { selectedModelId: requireString(rawModelId, 'model id') });
  });

  // ── Settings ──────────────────────────────────────────────────────────────

  handle('settings:get', async () => getSettings());

  handle('settings:save', async (_event, rawPatch) => {
    const settings = saveSettings(requireSettingsPatch(rawPatch));
    // The native side of the window — the title bar, the scrollbars, the file
    // dialogs — follows `themeSource`, and only main can set it. A renderer
    // that changed only its own CSS would leave a light title bar bolted to a
    // dark app.
    nativeTheme.themeSource = settings.theme;
    return settings;
  });

  // ── Output ────────────────────────────────────────────────────────────────

  handle('output:render', async (_event, rawJobId, rawFormat) => {
    const job = requireJob(requireString(rawJobId, 'job id'));
    const format = requireFormat(rawFormat);
    return renderTranscript(requireTranscript(job), format, renderOptionsFor(job, getSettings()));
  });

  handle('output:export', async (event, rawJobId, rawFormat) => {
    const job = requireJob(requireString(rawJobId, 'job id'));
    const format = requireFormat(rawFormat);
    const settings = getSettings();
    const text = renderTranscript(requireTranscript(job), format, renderOptionsFor(job, settings));

    const options: SaveDialogOptions = {
      title: 'Save transcript',
      defaultPath: join(suggestedExportDirectory(job, settings), exportFileName(job.fileName, format)),
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    };
    // Parented on the window that asked, so it is a sheet on macOS rather than
    // a free-floating dialog the user can lose behind the app.
    const parent = windowOf(event);
    const result =
      parent === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(parent, options);
    if (result.canceled || result.filePath === undefined || result.filePath.length === 0) return null;

    // A plain write: the dialog has already asked about replacing an existing
    // file and the user answered. Adding a " (2)" here would save the file
    // somewhere other than where they just said to put it.
    await writeFile(result.filePath, text, 'utf8');
    revealable.add(result.filePath);
    // Show the user where it went.
    //
    // A Save dialog tells you the destination and then the window closes over
    // it; five minutes later "where did I put that SRT" is a real question. The
    // reveal answers it once, at the only moment the answer is obvious, and
    // costs nothing if the user already knew — the Finder window it opens is the
    // folder they just chose.
    shell.showItemInFolder(result.filePath);
    return result.filePath;
  });

  handle('output:exportMany', async (_event, rawIds, rawFormats) => {
    const ids = requireStringArray(rawIds, 'job list');
    const formats = requireStringArray(rawFormats, 'format list').map((value) => requireFormat(value));
    if (formats.length === 0) return 0;

    const settings = getSettings();
    let written = 0;
    /*
      The first file written, kept so the batch can end by revealing it.

      One reveal, not one per file: a batch of ten transcripts would otherwise
      open ten Finder windows, and `showItemInFolder` selects the item, so the
      last call would win anyway while the other nine sat behind it. Revealing
      the first file both opens the right folder and points at something real.
    */
    let firstWritten: string | null = null;

    for (const id of ids) {
      const job = findJob(id);
      // A selection can hold jobs that are still running, that failed, or that
      // were cleared between the click and this handler. Those are skipped
      // rather than failing the batch: the user asked for the transcripts they
      // have, and refusing all ten because one is unfinished helps nobody.
      if (job === undefined || job.transcript === undefined) continue;

      const directory = batchExportDirectory(job, settings);
      await mkdir(directory, { recursive: true });
      const options = renderOptionsFor(job, settings);

      // Sequential, like the queue's auto-export and for the same reason:
      // concurrent writes into one directory race for the un-suffixed name, so
      // which format got it would differ between runs.
      for (const format of formats) {
        const text = renderTranscript(job.transcript, format, options);
        const file = await writeWithoutOverwriting(
          join(directory, exportFileName(job.fileName, format)),
          text,
        );
        revealable.add(file);
        if (firstWritten === null) firstWritten = file;
        written++;
      }
    }

    // Same reason as the single export: the one moment the destination is
    // obvious is right now.
    if (firstWritten !== null) shell.showItemInFolder(firstWritten);

    return written;
  });

  handle('output:copy', async (_event, rawJobId, rawFormat) => {
    const job = requireJob(requireString(rawJobId, 'job id'));
    const format = requireFormat(rawFormat);
    clipboard.writeText(
      renderTranscript(requireTranscript(job), format, renderOptionsFor(job, getSettings())),
    );
  });

  // ── Misc ──────────────────────────────────────────────────────────────────

  handle('app:info', async (): Promise<AppInfo> => {
    const platform =
      process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
    return {
      version: app.getVersion(),
      platform,
      arch: process.arch,
      modelsDir: modelsDir(),
      // Read on every call, never cached: a developer who has just run
      // `npm run binaries:fetch` with the app open should see this flip without
      // relaunching. Four `access()` calls cost nothing.
      enginesReady: enginesReady(),
      engineReport: engineReport(),
    };
  });

  handle('app:openExternal', async (_event, rawLink) => {
    const link = requireString(rawLink, 'link');
    const url = resolveExternalLink(link);
    if (url === null) {
      // Not "invalid URL" — the renderer did not send one. It named a
      // destination this build does not have, which is a bug in the caller.
      throw malformed('link');
    }
    await openExternalUrl(url);
  });

  handle('app:licenses', async () => {
    const file = licenseNoticePath();
    try {
      return await readFile(file, 'utf8');
    } catch {
      // The notice covers ffmpeg's GPL-3.0-or-later and whisper.cpp's MIT terms, so a
      // missing one is a compliance problem rather than a cosmetic one. Naming
      // the path we looked in is what makes it fixable.
      throw new Error(
        `DropScribe could not open its third-party licence notice. It should be at ${file}. Re-running the installer, or “npm run binaries:fetch” in a development checkout, restores it.`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function bootstrap(): void {
  // Before `whenReady`, deliberately. `services/temp.ts` builds its root from
  // `os.tmpdir()` precisely so it works this early, and a gigabyte of WAVs left
  // by a crash is worth collecting before the user can start filling the disk
  // again. It never throws.
  sweepOrphanedTemp();

  // Registered before any window exists, because `web-contents-created` fires
  // during `new BrowserWindow(...)` and the guards have to be attached by then.
  app.on('web-contents-created', (_event, contents) => {
    hardenContents(contents);
  });

  // macOS delivers a double-clicked file through this event, and it commonly
  // fires *before* `whenReady`. The listener has to exist by then or the file
  // the user opened the app with is lost.
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    acceptExternalFiles(authorizeAll([filePath]));
  });

  app.on('second-instance', (_event, argv) => {
    const window = mainWindow;
    if (window !== null) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
    acceptExternalFiles(mediaFilesInArgv(argv));
  });

  registerIpc();

  // One subscription for the process lifetime. `send` no-ops while there is no
  // window, which is the normal state on macOS between closing the window and
  // reopening it from the Dock.
  queue.onUpdate((job) => {
    send('jobs:updated', job);
  });

  app.on('window-all-closed', () => {
    // macOS apps stay in the Dock with no windows open, and a transcription
    // running when the window is closed keeps running — closing a window is not
    // cancelling a job. Everywhere else, the last window closing is quitting.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('before-quit', () => {
    // The one thing that must happen on the way out. `shutdown` aborts every
    // job's AbortController, which is what kills the ffmpeg and whisper-cli
    // children — without it they keep decoding after the app is gone, holding
    // a CPU and a temp file nobody will ever collect, and on macOS the app
    // appears to quit while the fans stay up.
    queue.shutdown();
  });

  app
    .whenReady()
    .then(() => {
      nativeTheme.themeSource = getSettings().theme;

      // The app needs no camera, no microphone, no notifications and no
      // geolocation — it reads files the user hands it. Denying every request
      // by default means a permission prompt can never appear in a
      // transcription tool, which is exactly the prompt a user should be
      // suspicious of.
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
        callback(false);
      });

      buildMenu();
      createWindow();

      // Files named on the command line are collected only now: `authorizeAll`
      // stats them, and `app.isPackaged` — which decides the argv slice — is
      // only meaningful once the app object is up.
      acceptExternalFiles(mediaFilesInArgv(process.argv));

      log('info', 'DropScribe started', {
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        enginesReady: enginesReady(),
      });
    })
    .catch((error: unknown) => {
      log('error', 'failed to start', {
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      app.quit();
    });
}

/**
 * One instance, always.
 *
 * Two copies of DropScribe would each hold their own queue and their own
 * settings cache, writing the same `settings.json` and racing over the same
 * temp root — and on Windows, opening a second file from Explorer is exactly
 * how a second copy gets launched. The second process hands its argv to the
 * first through `second-instance` and exits.
 */
if (app.requestSingleInstanceLock()) {
  bootstrap();
} else {
  app.quit();
}
