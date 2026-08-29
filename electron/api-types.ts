/**
 * The single IPC surface, declared once.
 *
 * `electron/preload.ts` exposes exactly one object — `window.dropscribe` — and
 * this file is its type. It is compiled by BOTH TypeScript projects
 * (`tsconfig.node.json` for main and preload, `tsconfig.web.json` for the
 * renderer), so the handler, the bridge and the caller cannot drift apart into
 * three hand-synced copies.
 *
 * It therefore may not import anything from `node:` or `electron`. Only the
 * pure shared types under `electron/shared/`.
 */

import type { Job, TranscribeTarget } from './shared/jobs';
import type { LocalModel } from './shared/models';
import type { CloudOptions, KeyTestResult, ProviderId, ProviderModel } from './shared/providers';
import type { SegmentationOptions } from './shared/subtitles';
import type { Transcript } from './shared/transcript';

export type ExportFormat = 'txt' | 'md' | 'srt' | 'vtt' | 'json' | 'csv';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['txt', 'md', 'srt', 'vtt', 'json', 'csv'];

/** A catalogue entry plus what this machine actually has on disk. */
export interface ModelState extends LocalModel {
  installed: boolean;
  /** Bytes on disk. Equals `bytes` when installed, or the partial size mid-download. */
  onDiskBytes: number;
  downloading: boolean;
  /** 0..100 while downloading, otherwise `null`. */
  downloadPercent: number | null;
  /** Last download failure, cleared when a retry starts. */
  error?: string;
}

/** What the app knows about one provider on this machine. */
export interface ProviderState {
  id: ProviderId;
  hasKey: boolean;
  /** Last few characters only, so the UI can show which key is configured. */
  keyPreview?: string;
  /** Result of the last Test connection, persisted so the UI is right on relaunch. */
  lastTest?: KeyTestResult;
  /** Models fetched after a successful test. Empty until then. */
  models: ProviderModel[];
  /** The model the user picked for this provider. */
  selectedModelId?: string;
}

export interface OutputSettings {
  /** Which files to write when a job finishes. Empty means "write nothing automatically". */
  formats: ExportFormat[];
  /** Write beside the source file rather than into `outputDir`. */
  besideSource: boolean;
  /** Used when `besideSource` is false. `null` means ask on first export. */
  outputDir: string | null;
  /** Prefix each subtitle cue with its speaker when the transcript is diarized. */
  includeSpeakers: boolean;
}

export interface Settings {
  /** What a newly dropped file runs through. `null` until the user has any model or key. */
  defaultTarget: TranscribeTarget | null;
  /** Applies to local engines and to cloud adapters that accept a language hint. */
  language: string | null;
  translate: boolean;
  diarize: boolean;
  /** Jobs transcribed at once. Local inference is memory-bound; 1 is the honest default. */
  maxConcurrentJobs: number;
  /** Threads handed to whisper.cpp. 0 means "let the app choose from the CPU count". */
  threads: number;
  output: OutputSettings;
  segmentation: SegmentationOptions;
  cloud: CloudOptions;
  theme: 'system' | 'light' | 'dark';
  /** BCP-47 tag for the interface itself, not for the audio. */
  uiLanguage: 'en' | 'bg';
}

export interface AppInfo {
  version: string;
  platform: 'darwin' | 'win32' | 'linux';
  arch: string;
  /** Absolute path of the models directory, shown in settings. */
  modelsDir: string;
  /** False when a vendored engine binary is missing — the UI must say so, not fail later. */
  enginesReady: boolean;
  /** Per-binary detail behind a disclosure when `enginesReady` is false. */
  engineReport: { name: string; path: string; present: boolean }[];
}

/**
 * Links main is allowed to open, named semantically.
 *
 * The renderer never passes a URL. A compromised renderer that could name a
 * destination would turn `shell.openExternal` into an arbitrary-URL opener.
 */
export type ExternalLinkId =
  | 'repo'
  | 'issues'
  | 'support:paypal'
  | 'support:revolut'
  | `provider-key:${ProviderId}`
  | `provider-docs:${ProviderId}`;

export interface DropScribeApi {
  // ── Files ───────────────────────────────────────────────────────────────
  /** Native picker. The returned paths are already authorized. */
  openFiles(): Promise<string[]>;
  /**
   * Authorize a path that arrived by drag-and-drop, before the renderer uses it.
   * Synchronous on purpose: the drop handler must decide within the event.
   */
  authorizePath(path: string): boolean;
  /**
   * The real path behind a `File` that arrived from a drop or a file input.
   *
   * Electron 32 removed the `File.path` augmentation, so in a sandboxed
   * renderer a dropped file carries no path at all and `webUtils` — which
   * exists only in the preload — is the only way back to one. Synchronous and
   * not IPC, because it reads a value Chromium already attached to the object
   * and the drop handler needs it before the DataTransfer is neutered.
   *
   * A `File` built in JavaScript returns `''`, which `authorizePath` then
   * refuses like any other path that is not a readable media file.
   */
  pathForFile(file: File): string;
  chooseOutputDir(): Promise<string | null>;
  revealFile(path: string): Promise<void>;

  // ── Jobs ────────────────────────────────────────────────────────────────
  enqueue(paths: string[], target: TranscribeTarget): Promise<Job[]>;
  listJobs(): Promise<Job[]>;
  cancelJob(id: string): Promise<void>;
  retryJob(id: string): Promise<void>;
  removeJob(id: string): Promise<void>;
  clearFinished(): Promise<void>;
  /** Returns an unsubscribe function. */
  onJobUpdated(callback: (job: Job) => void): () => void;

  // ── Local models ────────────────────────────────────────────────────────
  listModels(): Promise<ModelState[]>;
  downloadModel(id: string): Promise<void>;
  cancelModelDownload(id: string): Promise<void>;
  deleteModel(id: string): Promise<void>;
  onModelUpdated(callback: (state: ModelState) => void): () => void;

  // ── Cloud providers ─────────────────────────────────────────────────────
  listProviders(): Promise<ProviderState[]>;
  /**
   * Test a key WITHOUT saving it. This is what the Test connection button calls,
   * so a bad key never reaches the keychain.
   */
  testProviderKey(id: ProviderId, key: string): Promise<KeyTestResult>;
  /** Tests, and saves only if the test passes. Returns the same result. */
  saveProviderKey(id: ProviderId, key: string): Promise<KeyTestResult>;
  clearProviderKey(id: ProviderId): Promise<void>;
  /** Re-fetch the model list using the stored key. */
  refreshProviderModels(id: ProviderId): Promise<ProviderModel[]>;
  selectProviderModel(id: ProviderId, modelId: string): Promise<void>;

  // ── Settings ────────────────────────────────────────────────────────────
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;

  // ── Output ──────────────────────────────────────────────────────────────
  /** Renders a finished transcript. Returns the text so the renderer can preview it. */
  renderTranscript(jobId: string, format: ExportFormat): Promise<string>;
  /** Save-as dialog then write. Returns the written path, or `null` if cancelled. */
  exportTranscript(jobId: string, format: ExportFormat): Promise<string | null>;
  /** Writes every selected job in every chosen format. Returns how many files landed. */
  exportMany(jobIds: string[], formats: ExportFormat[]): Promise<number>;
  copyTranscript(jobId: string, format: ExportFormat): Promise<void>;

  // ── Misc ────────────────────────────────────────────────────────────────
  getAppInfo(): Promise<AppInfo>;
  openExternal(link: ExternalLinkId): Promise<void>;
  /** The third-party licence notice for the vendored binaries and the models. */
  getLicenses(): Promise<string>;
}

export type { Job, TranscribeTarget, LocalModel, ProviderId, ProviderModel, KeyTestResult, Transcript, SegmentationOptions, CloudOptions };
