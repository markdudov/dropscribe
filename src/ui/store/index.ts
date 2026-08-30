/**
 * The renderer's one piece of mutable state.
 *
 * Main owns the truth — the queue, the models directory, the keychain — and
 * this store is a *mirror* of it, never a second copy that drifts. Every
 * mutation here goes out over IPC first and is written into the store only from
 * what main answered, so there is no optimistic local state to reconcile when a
 * download fails or a key is rejected. The obvious alternative, updating
 * locally and reconciling on the next event, buys a few milliseconds of
 * perceived speed and pays for it with a UI that can show a model as installed
 * when it is not.
 *
 * One flat store rather than a store per domain: the pieces are cross-wired
 * (the target picker needs models *and* providers *and* settings; the drop zone
 * needs the target and the queue), and four stores would only move the
 * cross-wiring into the components.
 */

import { create } from 'zustand';

import type {
  AppInfo,
  DropScribeApi,
  ExportFormat,
  ExternalLinkId,
  ModelState,
  OutputSettings,
  ProviderState,
  Settings,
} from '../../../electron/api-types';
import type { Job, TranscribeTarget } from '../../../electron/shared/jobs';
import type { KeyTestResult, ProviderId, ProviderModel } from '../../../electron/shared/providers';
import { DEFAULT_CLOUD_OPTIONS } from '../../../electron/shared/providers';
import type { SegmentationOptions } from '../../../electron/shared/subtitles';
import { DEFAULT_SEGMENTATION } from '../../../electron/shared/subtitles';

// ── The bridge ────────────────────────────────────────────────────────────

/**
 * `window.dropscribe`, fetched on each call.
 *
 * Deliberately not a `declare global` augmentation of `Window` here: the module
 * that owns `preload.ts` owns that declaration, and a second one in the
 * renderer is a second thing to keep in step for no gain. Deliberately not a
 * module-level `const` either — reading the bridge at import time would make
 * merely importing this store throw under jsdom, where there is no preload.
 */
export function api(): DropScribeApi {
  const bridge = (window as unknown as { dropscribe?: DropScribeApi }).dropscribe;
  if (bridge === undefined) {
    throw new Error('The app failed to start: its privileged bridge is missing. Reinstall DropScribe.');
  }
  return bridge;
}

// ── Fallbacks ─────────────────────────────────────────────────────────────

/**
 * What the store holds during the handful of frames before `init()` answers.
 *
 * A duplicate of `DEFAULT_SETTINGS` in `electron/services/settings.ts`, and it
 * has to be: that module reads `app.getPath` and `node:fs`, so the renderer
 * cannot import it at all. Both sides are pinned to the same two exported
 * constants — `DEFAULT_SEGMENTATION` and `DEFAULT_CLOUD_OPTIONS` — which is
 * where a divergence would actually be visible to the user, and the remaining
 * scalars are the ones the very first `settings:get` overwrites anyway.
 */
export const FALLBACK_SETTINGS: Settings = {
  defaultTarget: null,
  language: null,
  translate: false,
  diarize: false,
  maxConcurrentJobs: 1,
  threads: 0,
  output: { formats: ['txt', 'srt'], besideSource: true, outputDir: null, includeSpeakers: false },
  segmentation: DEFAULT_SEGMENTATION,
  cloud: DEFAULT_CLOUD_OPTIONS,
  theme: 'system',
  uiLanguage: 'en',
};

// ── Tabs ──────────────────────────────────────────────────────────────────

export type SettingsTab = 'models' | 'providers' | 'output' | 'about';

export const SETTINGS_TABS: readonly SettingsTab[] = ['models', 'providers', 'output', 'about'];

// ── The merge rule ────────────────────────────────────────────────────────

/**
 * Replace an entry by id **in place**, or prepend it when the id is new.
 *
 * This is the whole reason updates do not go through a `Map` keyed by id and a
 * `[...map.values()]` render: a list the user is looking at must not reorder
 * under them. A model row that jumps to the top of the list the instant its
 * download ticks 41 %, or a job that swaps places with its neighbour every time
 * a progress event lands, makes the button the user was aiming at move out from
 * under the cursor. Position is part of the UI's contract with the user, so
 * position is preserved and only the contents of the slot change.
 *
 * A genuinely unknown id is prepended rather than appended because the only
 * things that arrive unannounced are new — a freshly enqueued job, a model
 * catalogue entry this build did not have — and new belongs where it will be
 * seen without scrolling.
 */
export function mergeById<T extends { id: string }>(list: readonly T[], next: T): T[] {
  const index = list.findIndex((entry) => entry.id === next.id);
  if (index === -1) return [next, ...list];
  const copy = list.slice();
  copy[index] = next;
  return copy;
}

// ── The initial target ────────────────────────────────────────────────────

function targetIsRunnable(
  target: TranscribeTarget,
  models: readonly ModelState[],
  providers: readonly ProviderState[],
): boolean {
  if (target.kind === 'local') {
    return models.some((model) => model.id === target.modelId && model.installed);
  }
  const provider = providers.find((entry) => entry.id === target.providerId);
  return provider !== undefined && provider.hasKey;
}

/**
 * What a file dropped in the next second should run through.
 *
 * The stored `defaultTarget` leads *when it still works*. `settings.ts`
 * deliberately does not validate it on load — it cannot, since settings are
 * read before the models directory is scanned or a key is decrypted — so the
 * value reaching us here can name a model the user deleted last week. Honouring
 * it blindly would arm the drop zone with a target that fails on contact;
 * ignoring it would silently overrule a choice the user made on purpose. So it
 * is checked against what this machine actually has, once, here.
 *
 * After that: any installed local model beats any cloud provider, because local
 * costs nothing, works offline and uploads no audio — the defaults of this app
 * should never be the ones that send a file somewhere. A provider is only a
 * candidate once it has both a key and a chosen model; a key with no model
 * selected is a half-finished setup, not a target.
 */
export function pickInitialTarget(
  settings: Settings,
  models: readonly ModelState[],
  providers: readonly ProviderState[],
): TranscribeTarget | null {
  const stored = settings.defaultTarget;
  if (stored !== null && targetIsRunnable(stored, models, providers)) return stored;

  const installed = models.find((model) => model.installed);
  if (installed !== undefined) return { kind: 'local', modelId: installed.id };

  for (const provider of providers) {
    const modelId = provider.selectedModelId;
    if (provider.hasKey && modelId !== undefined && modelId.length > 0) {
      return { kind: 'cloud', providerId: provider.id, modelId };
    }
  }

  // Stale or not, it is the only expression of intent left. The queue rejects
  // it with a message naming the missing model, which is more use to the user
  // than a drop zone that says nothing at all.
  return stored;
}

// ── Theme ─────────────────────────────────────────────────────────────────

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Put the theme on `<html>`.
 *
 * Tailwind is configured `darkMode: 'class'`, so the class is the switch; the
 * `color-scheme` property is set alongside it so the things Tailwind does not
 * reach — scrollbars, the native focus ring, `<select>` popups, the flash of
 * background before the first paint — follow the same choice instead of
 * staying light inside a dark window.
 */
export function applyTheme(theme: Settings['theme']): void {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia(DARK_QUERY).matches);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

// ── The store ─────────────────────────────────────────────────────────────

export interface StoreState {
  /** False until `init()` has answered. Components render a skeleton, not an empty app. */
  ready: boolean;
  /** Set when `init()` could not reach main at all. Fatal, and worth saying out loud. */
  initError: string | null;

  settings: Settings;
  appInfo: AppInfo | null;
  jobs: Job[];
  models: ModelState[];
  providers: ProviderState[];
  /** What a newly dropped file runs through. Not persisted until the user makes it the default. */
  target: TranscribeTarget | null;

  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /** The finished job whose transcript is open, or `null`. */
  transcriptJobId: string | null;
  /** One transient line for the user: an export path, a failure. `null` when nothing to say. */
  notice: string | null;
  /** Bumped on every `setNotice`, so an identical message twice is still twice. */
  noticeSeq: number;

  init(): Promise<void>;
  dispose(): void;

  openSettings(tab?: SettingsTab): void;
  closeSettings(): void;
  setSettingsTab(tab: SettingsTab): void;
  openTranscript(jobId: string): void;
  closeTranscript(): void;
  setNotice(notice: string | null): void;

  setTarget(target: TranscribeTarget | null): void;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  updateOutput(patch: Partial<OutputSettings>): Promise<void>;
  updateSegmentation(patch: Partial<SegmentationOptions>): Promise<void>;
  resetSegmentation(): Promise<void>;

  openFiles(): Promise<void>;
  addFiles(paths: string[]): Promise<void>;
  cancelJob(id: string): Promise<void>;
  retryJob(id: string): Promise<void>;
  removeJob(id: string): Promise<void>;
  clearFinished(): Promise<void>;
  revealFile(path: string): Promise<void>;

  refreshModels(): Promise<void>;
  downloadModel(id: string): Promise<void>;
  cancelModelDownload(id: string): Promise<void>;
  deleteModel(id: string): Promise<void>;

  refreshProviders(): Promise<void>;
  testProviderKey(id: ProviderId, key: string): Promise<KeyTestResult>;
  saveProviderKey(id: ProviderId, key: string): Promise<KeyTestResult>;
  clearProviderKey(id: ProviderId): Promise<void>;
  refreshProviderModels(id: ProviderId): Promise<ProviderModel[]>;
  selectProviderModel(id: ProviderId, modelId: string): Promise<void>;

  chooseOutputDir(): Promise<void>;
  renderTranscript(jobId: string, format: ExportFormat): Promise<string>;
  exportTranscript(jobId: string, format: ExportFormat): Promise<string | null>;
  copyTranscript(jobId: string, format: ExportFormat): Promise<void>;
  openExternal(link: ExternalLinkId): Promise<void>;
}

/**
 * Subscriptions live outside the store, not in it.
 *
 * They are not state: nothing renders differently because an unsubscribe
 * function exists. Putting them in the store would make every `set` copy a pair
 * of closures around, and would tempt someone into serialising the store one
 * day and finding functions in it.
 */
let teardown: Array<() => void> = [];
/** Guards a second `init()` from React 18's development double-effect. */
let initStarted = false;
/**
 * Bumped by `dispose()`, so an `init()` still waiting on its five round trips
 * can tell that it has been abandoned.
 *
 * StrictMode runs mount / unmount / mount, and without this the first init
 * resolves *after* the teardown that was meant to cancel it and subscribes a
 * second pair of listeners that nothing holds an unsubscribe for.
 */
let generation = 0;

function describe(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'Something went wrong and the app cannot say what.';
}

export const useStore = create<StoreState>()((set, get) => ({
  ready: false,
  initError: null,
  settings: FALLBACK_SETTINGS,
  appInfo: null,
  jobs: [],
  models: [],
  providers: [],
  target: null,
  settingsOpen: false,
  settingsTab: 'models',
  transcriptJobId: null,
  notice: null,
  noticeSeq: 0,

  // ── Lifecycle ───────────────────────────────────────────────────────────

  init: async () => {
    if (initStarted) return;
    initStarted = true;
    const mine = ++generation;

    try {
      const bridge = api();
      // In parallel, because these five round trips are independent and the
      // slowest of them — listing models, which stats the models directory —
      // has no business delaying the settings that decide the theme. Awaiting
      // them in sequence made the window flash light before going dark.
      const [settings, models, providers, appInfo, jobs] = await Promise.all([
        bridge.getSettings(),
        bridge.listModels(),
        bridge.listProviders(),
        bridge.getAppInfo(),
        bridge.listJobs(),
      ]);

      // Disposed while those were in flight. Everything below this line
      // installs listeners, and installing them now would leak them.
      if (mine !== generation) return;

      applyTheme(settings.theme);
      set({
        ready: true,
        initError: null,
        settings,
        models,
        providers,
        appInfo,
        jobs,
        target: pickInitialTarget(settings, models, providers),
      });

      // Subscribed only after the initial lists are in. Subscribing first would
      // let an event for a job we have not listed yet prepend a duplicate that
      // the list then re-adds a moment later.
      teardown.push(bridge.onJobUpdated((job) => {
        set((state) => ({ jobs: mergeById(state.jobs, job) }));
      }));
      teardown.push(bridge.onModelUpdated((model) => {
        set((state) => ({ models: mergeById(state.models, model) }));
      }));

      // `system` is not a one-off reading: macOS flips it at sunset and Windows
      // on a schedule, and an app that only checks at launch is the one still
      // glowing white at midnight.
      const media = window.matchMedia(DARK_QUERY);
      const onSchemeChange = (): void => {
        if (get().settings.theme === 'system') applyTheme('system');
      };
      media.addEventListener('change', onSchemeChange);
      teardown.push(() => { media.removeEventListener('change', onSchemeChange); });
    } catch (error) {
      // `ready` stays false. There is no partial mode worth offering: without
      // main, nothing in this window can transcribe anything.
      initStarted = false;
      if (mine === generation) set({ initError: describe(error) });
    }
  },

  dispose: () => {
    generation++;
    for (const off of teardown) off();
    teardown = [];
    initStarted = false;
  },

  // ── UI ──────────────────────────────────────────────────────────────────

  openSettings: (tab) => {
    set(tab === undefined ? { settingsOpen: true } : { settingsOpen: true, settingsTab: tab });
  },
  closeSettings: () => { set({ settingsOpen: false }); },
  setSettingsTab: (settingsTab) => { set({ settingsTab }); },
  openTranscript: (transcriptJobId) => { set({ transcriptJobId }); },
  closeTranscript: () => { set({ transcriptJobId: null }); },
  setNotice: (notice) => { set((state) => ({ notice, noticeSeq: state.noticeSeq + 1 })); },

  // ── Target and settings ─────────────────────────────────────────────────

  setTarget: (target) => {
    set({ target });
    /*
     * And persisted, because the renderer's copy is not the one that matters
     * when a file arrives from outside the window.
     *
     * `flushPendingFiles` in main handles `open-file` and `second-instance` —
     * a double-click in Finder, a "Open with DropScribe", a file passed on the
     * command line — and it reads `settings.defaultTarget`, never the store.
     * With nothing ever writing that field it stayed `null` for the life of the
     * app, and every one of those paths met a dialog saying DropScribe had
     * nothing to transcribe with yet and to go download a model — to a user who
     * had downloaded one and picked it. `pickInitialTarget` was already written
     * to read this value back and re-validate it on the next launch; the write
     * was simply missing.
     *
     * Fire-and-forget: the pick has already taken effect locally, and a
     * settings write that fails should not undo it or interrupt the drop the
     * user is about to make. `updateSettings` surfaces its own failure.
     */
    void get().updateSettings({ defaultTarget: target });
  },

  updateSettings: async (patch) => {
    try {
      const settings = await api().saveSettings(patch);
      // The theme is re-applied from what main returned rather than from the
      // patch: main coerces, and if it ever refuses a value the window must
      // show what was actually stored, not what was asked for.
      applyTheme(settings.theme);
      set({ settings });
    } catch (error) {
      set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 }));
    }
  },

  updateOutput: async (patch) => {
    // `Partial<Settings>` types `output` as a whole `OutputSettings`, so the
    // current one is spread here even though main merges nested objects leaf by
    // leaf. Sending the whole object also makes the write idempotent if main's
    // merge rules ever change.
    const output: OutputSettings = { ...get().settings.output, ...patch };
    await get().updateSettings({ output });
  },

  updateSegmentation: async (patch) => {
    const segmentation: SegmentationOptions = { ...get().settings.segmentation, ...patch };
    await get().updateSettings({ segmentation });
  },

  resetSegmentation: async () => {
    await get().updateSettings({ segmentation: { ...DEFAULT_SEGMENTATION } });
  },

  // ── Files and jobs ──────────────────────────────────────────────────────

  openFiles: async () => {
    try {
      const paths = await api().openFiles();
      if (paths.length > 0) await get().addFiles(paths);
    } catch (error) {
      set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 }));
    }
  },

  addFiles: async (paths) => {
    const target = get().target;
    if (target === null) {
      // Nothing to run them through. Opening settings is the only action that
      // helps, so it is taken rather than described.
      set((s) => ({ notice: 'Download a local model or add a provider key first.', noticeSeq: s.noticeSeq + 1, settingsOpen: true, settingsTab: 'models' }));
      return;
    }
    try {
      const created = await api().enqueue(paths, target);
      set((state) => {
        let jobs = state.jobs;
        // Introduced, not merged. This reply is a snapshot from before the
        // `await` returned, and `job:updated` for these ids may already have
        // arrived — a short file can be extracting, or done, by now.
        // `mergeById` replaces the entry wholesale, so it wrote 'queued' with
        // no progress back over the fresher state and the row jumped
        // backwards. The reply's job is to make the rows exist; everything
        // after that belongs to the events.
        //
        // Folded back to front so that after each one is prepended the batch
        // ends up in the order the user dropped it, not reversed.
        for (const job of [...created].reverse()) {
          if (!jobs.some((existing) => existing.id === job.id)) jobs = [job, ...jobs];
        }
        return { jobs };
      });
    } catch (error) {
      set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 }));
    }
  },

  cancelJob: async (id) => {
    try { await api().cancelJob(id); } catch (error) { set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 })); }
  },
  retryJob: async (id) => {
    try { await api().retryJob(id); } catch (error) { set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 })); }
  },
  removeJob: async (id) => {
    try {
      await api().removeJob(id);
      set((state) => ({
        jobs: state.jobs.filter((job) => job.id !== id),
        transcriptJobId: state.transcriptJobId === id ? null : state.transcriptJobId,
      }));
    } catch (error) {
      set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 }));
    }
  },
  clearFinished: async () => {
    try {
      await api().clearFinished();
      // Re-listed rather than filtered locally by the same rule: `isTerminal`
      // living in two places is exactly how the two lists start to disagree.
      const jobs = await api().listJobs();
      set((state) => ({
        jobs,
        transcriptJobId: jobs.some((job) => job.id === state.transcriptJobId) ? state.transcriptJobId : null,
      }));
    } catch (error) {
      set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 }));
    }
  },
  revealFile: async (path) => {
    try { await api().revealFile(path); } catch (error) { set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 })); }
  },

  // ── Models ──────────────────────────────────────────────────────────────

  refreshModels: async () => {
    try { set({ models: await api().listModels() }); } catch (error) { set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 })); }
  },

  downloadModel: async (id) => {
    try {
      // No await-then-refresh: progress arrives on `models:updated`, and this
      // promise does not settle until the whole file is on disk.
      await api().downloadModel(id);
      await get().refreshModels();
      // A first model turns a dead drop zone into a live one. Arming it here
      // saves the user a trip to the target picker to state the obvious.
      //
      // Only if it is actually on disk. `downloadModel` settles when the
      // download STOPS, which includes the user cancelling it, so arming on the
      // id alone armed a model that was never installed — and the next drop
      // failed naming a file that is not there. `refreshModels` above has just
      // re-read the real state; ask it.
      const state = get();
      const installed = get().models.some((model) => model.id === id && model.installed);
      if (state.target === null && installed) set({ target: { kind: 'local', modelId: id } });
    } catch (error) {
      set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 }));
    }
  },

  cancelModelDownload: async (id) => {
    try { await api().cancelModelDownload(id); } catch (error) { set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 })); }
  },

  deleteModel: async (id) => {
    try {
      await api().deleteModel(id);
      await get().refreshModels();
      const state = get();
      // Leaving the deleted model armed would fail every drop from now on.
      if (state.target?.kind === 'local' && state.target.modelId === id) {
        set({ target: pickInitialTarget(state.settings, get().models, state.providers) });
      }
    } catch (error) {
      set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 }));
    }
  },

  // ── Providers ───────────────────────────────────────────────────────────

  refreshProviders: async () => {
    try { set({ providers: await api().listProviders() }); } catch (error) { set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 })); }
  },

  testProviderKey: async (id, key) => {
    // Returned rather than stored: this is the button that must NOT persist
    // anything, so the caller owns the result and the store learns nothing.
    return api().testProviderKey(id, key);
  },

  saveProviderKey: async (id, key) => {
    const result = await api().saveProviderKey(id, key);
    // The list is re-read whatever the answer: a failed save can still have
    // cleared a previously stored key on main's side.
    await get().refreshProviders();
    return result;
  },

  clearProviderKey: async (id) => {
    try {
      await api().clearProviderKey(id);
      await get().refreshProviders();
      const state = get();
      if (state.target?.kind === 'cloud' && state.target.providerId === id) {
        set({ target: pickInitialTarget(state.settings, state.models, get().providers) });
      }
    } catch (error) {
      set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 }));
    }
  },

  refreshProviderModels: async (id) => {
    const models = await api().refreshProviderModels(id);
    await get().refreshProviders();
    return models;
  },

  selectProviderModel: async (id, modelId) => {
    try {
      await api().selectProviderModel(id, modelId);
      await get().refreshProviders();
    } catch (error) {
      set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 }));
    }
  },

  // ── Output ──────────────────────────────────────────────────────────────

  chooseOutputDir: async () => {
    try {
      const dir = await api().chooseOutputDir();
      // `null` is a cancelled dialog, not a request to clear the folder. Writing
      // it through would silently move the user's exports back beside the source.
      if (dir === null) return;
      await get().updateOutput({ outputDir: dir, besideSource: false });
    } catch (error) {
      set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 }));
    }
  },

  renderTranscript: async (jobId, format) => api().renderTranscript(jobId, format),

  exportTranscript: async (jobId, format) => {
    try {
      const path = await api().exportTranscript(jobId, format);
      if (path !== null) set((s) => ({ notice: `Saved to ${path}`, noticeSeq: s.noticeSeq + 1 }));
      return path;
    } catch (error) {
      set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 }));
      return null;
    }
  },

  copyTranscript: async (jobId, format) => {
    try {
      await api().copyTranscript(jobId, format);
      set((s) => ({ notice: 'Copied to the clipboard', noticeSeq: s.noticeSeq + 1 }));
    } catch (error) {
      set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 }));
    }
  },

  openExternal: async (link) => {
    try { await api().openExternal(link); } catch (error) { set((s) => ({ notice: describe(error), noticeSeq: s.noticeSeq + 1 })); }
  },
}));

export default useStore;
