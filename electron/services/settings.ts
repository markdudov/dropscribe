/**
 * Everything the app remembers between launches, except the API keys.
 *
 * Two things live in `<userData>/settings.json`: the `Settings` object the
 * renderer edits, and one record per cloud provider holding the model list and
 * last test result fetched with that provider's key. The keys themselves are
 * deliberately elsewhere (`credentials.ts`), encrypted — this file is plain
 * JSON the user is welcome to read, and it must never become a place a secret
 * could accidentally land.
 *
 * The two rules that shape the rest of the file:
 *
 * 1. **Every write is atomic.** Settings are saved on almost every UI
 *    interaction, so the window where a crash or a power cut could catch a
 *    half-written file is not theoretical. Writing in place means a truncated
 *    file is a plausible outcome, and an unparseable settings file is how an
 *    app greets a user with factory defaults and no explanation.
 * 2. **Loading validates field by field and falls back per field.** The naive
 *    version — `JSON.parse` and cast — hands a `maxConcurrentJobs: "many"`
 *    straight into the queue. The next-naive version validates the whole object
 *    and discards it wholesale on any mismatch, which means a settings file
 *    written by a NEWER build, containing one field this build has never heard
 *    of or a value outside this build's range, resets everything the user ever
 *    configured. Per-field fallback makes a downgrade cost you one setting
 *    instead of all of them.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { EXPORT_FORMATS, type ExportFormat, type OutputSettings, type Settings } from '../api-types';
import type { TranscribeTarget } from '../shared/jobs';
import {
  DEFAULT_CLOUD_OPTIONS,
  PROVIDER_IDS,
  type CloudOptions,
  type KeyTestResult,
  type ProviderId,
  type ProviderModel,
  type ProviderModelCapabilities,
} from '../shared/providers';
import { DEFAULT_SEGMENTATION, type SegmentationOptions } from '../shared/subtitles';

const FILE_VERSION = 1;

/** What the app caches per provider. The key is NOT here; see `credentials.ts`. */
export interface ProviderRecord {
  models: ProviderModel[];
  selectedModelId?: string;
  lastTest?: KeyTestResult;
}

export type ProviderRecordPatch = Partial<{
  models: ProviderModel[];
  selectedModelId: string;
  lastTest: KeyTestResult;
}>;

interface SettingsFile {
  version: number;
  settings: Settings;
  providers: Partial<Record<ProviderId, ProviderRecord>>;
}

export const DEFAULT_SETTINGS: Settings = {
  // Nothing is chosen until the user has a model or a key. The drop zone reads
  // this null and says so, rather than silently queueing against a model that
  // is not on disk.
  defaultTarget: null,
  language: null,
  translate: false,
  diarize: false,
  // One. Local inference is memory-bound, not CPU-bound: two large-v3 jobs at
  // once is ~7 GB resident and each one is slower than it would have been on
  // its own. Concurrency here buys nothing and swaps.
  maxConcurrentJobs: 1,
  // Zero means "ask the CPU", resolved when the engine is spawned. Baking a
  // number in here would freeze a machine-specific value into a file that gets
  // synced between machines.
  threads: 0,
  output: {
    // Plain text for reading, SRT for anything that plays. The other four
    // formats are one checkbox away and none of them is what a first-time user
    // is expecting to find beside their video.
    formats: ['txt', 'srt'],
    besideSource: true,
    outputDir: null,
    includeSpeakers: false,
  },
  segmentation: DEFAULT_SEGMENTATION,
  cloud: DEFAULT_CLOUD_OPTIONS,
  theme: 'system',
  uiLanguage: 'en',
};

// ── Coercion helpers ──────────────────────────────────────────────────────
//
// Each takes the raw value and the value to keep when the raw one is unusable.
// That second argument is what makes one set of helpers serve both jobs: on
// load the fallback is the default, and on save the fallback is the current
// setting — which is precisely what "merge a partial patch" means.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function nullableString(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : fallback;
}

/**
 * Clamp rather than reject. A `maxConcurrentJobs` of 400 from a corrupt file is
 * a real number that a real user might have meant as "lots"; snapping it to the
 * ceiling honours the intent, where falling back to 1 would look like the
 * setting silently did not take.
 */
function int(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

const THEMES: readonly Settings['theme'][] = ['system', 'light', 'dark'];
const UI_LANGUAGES: readonly Settings['uiLanguage'][] = ['en', 'bg'];

/**
 * A target is not checked against the installed models or the configured
 * providers here.
 *
 * It is tempting: a `defaultTarget` naming a model the user deleted is dead.
 * But settings load before the models directory has been scanned and before any
 * key has been decrypted, and silently blanking the default because a download
 * had not finished yet would be worse than leaving a stale target for the queue
 * to reject with a message that says which model is missing.
 */
function coerceTarget(value: unknown, fallback: TranscribeTarget | null): TranscribeTarget | null {
  if (value === null) return null;
  if (!isRecord(value)) return fallback;

  const modelId = value.modelId;
  if (typeof modelId !== 'string' || modelId.length === 0) return fallback;

  if (value.kind === 'local') return { kind: 'local', modelId };
  if (value.kind === 'cloud' && isProviderId(value.providerId)) {
    return { kind: 'cloud', providerId: value.providerId, modelId };
  }
  return fallback;
}

function coerceFormats(value: unknown, fallback: ExportFormat[]): ExportFormat[] {
  if (!Array.isArray(value)) return [...fallback];
  // An empty array is legal and meaningful — "write nothing automatically" —
  // so it is not treated as a missing value.
  const seen = new Set<ExportFormat>();
  for (const entry of value) {
    if (typeof entry === 'string' && (EXPORT_FORMATS as readonly string[]).includes(entry)) {
      seen.add(entry as ExportFormat);
    }
  }
  // Rebuilt in catalogue order rather than the order they arrived, so the
  // export menu never reshuffles itself between launches.
  return EXPORT_FORMATS.filter((format) => seen.has(format));
}

function coerceOutput(value: unknown, fallback: OutputSettings): OutputSettings {
  const raw = isRecord(value) ? value : {};
  return {
    formats: coerceFormats(raw.formats, fallback.formats),
    besideSource: bool(raw.besideSource, fallback.besideSource),
    outputDir: nullableString(raw.outputDir, fallback.outputDir),
    includeSpeakers: bool(raw.includeSpeakers, fallback.includeSpeakers),
  };
}

function coerceSegmentation(value: unknown, fallback: SegmentationOptions): SegmentationOptions {
  const raw = isRecord(value) ? value : {};
  // The bounds are sanity rails, not editorial opinion: one character per line
  // or a one-frame cue makes the exporter produce garbage, and nothing above
  // these ceilings is a subtitle any more.
  return {
    maxCharsPerLine: int(raw.maxCharsPerLine, fallback.maxCharsPerLine, 10, 200),
    maxLines: int(raw.maxLines, fallback.maxLines, 1, 6),
    maxDurationMs: int(raw.maxDurationMs, fallback.maxDurationMs, 500, 30_000),
    minDurationMs: int(raw.minDurationMs, fallback.minDurationMs, 100, 10_000),
    maxCharsPerSecond: int(raw.maxCharsPerSecond, fallback.maxCharsPerSecond, 1, 100),
    gapSplitMs: int(raw.gapSplitMs, fallback.gapSplitMs, 0, 10_000),
    minGapMs: int(raw.minGapMs, fallback.minGapMs, 0, 2000),
    includeSpeakers: bool(raw.includeSpeakers, fallback.includeSpeakers),
  };
}

function coerceCloud(value: unknown, fallback: CloudOptions): CloudOptions {
  const raw = isRecord(value) ? value : {};
  return {
    language: nullableString(raw.language, fallback.language),
    diarize: bool(raw.diarize, fallback.diarize),
    wordTimestamps: bool(raw.wordTimestamps, fallback.wordTimestamps),
    translate: bool(raw.translate, fallback.translate),
  };
}

/**
 * The one function that both loads and patches.
 *
 * `output`, `segmentation` and `cloud` merge deeply because their coercers
 * resolve each leaf against `fallback`'s corresponding leaf; a patch of
 * `{ output: { besideSource: false } }` therefore keeps the user's formats.
 * Everything else is a scalar and merges shallowly by construction — there is
 * no deeper level to reach.
 *
 * Unknown keys are dropped rather than carried through. Preserving them would
 * let a setting survive a downgrade-and-upgrade round trip, at the cost of
 * shuttling untyped data through a typed API; losing one field on a downgrade
 * is the cheaper of the two.
 */
function coerceSettings(raw: unknown, fallback: Settings): Settings {
  const value = isRecord(raw) ? raw : {};
  return {
    defaultTarget: coerceTarget(value.defaultTarget, fallback.defaultTarget),
    language: nullableString(value.language, fallback.language),
    translate: bool(value.translate, fallback.translate),
    diarize: bool(value.diarize, fallback.diarize),
    maxConcurrentJobs: int(value.maxConcurrentJobs, fallback.maxConcurrentJobs, 1, 8),
    threads: int(value.threads, fallback.threads, 0, 128),
    output: coerceOutput(value.output, fallback.output),
    segmentation: coerceSegmentation(value.segmentation, fallback.segmentation),
    cloud: coerceCloud(value.cloud, fallback.cloud),
    theme: oneOf(value.theme, THEMES, fallback.theme),
    uiLanguage: oneOf(value.uiLanguage, UI_LANGUAGES, fallback.uiLanguage),
  };
}

function coerceProviderModel(value: unknown): ProviderModel | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  if (typeof id !== 'string' || id.length === 0) return null;

  const label = typeof value.label === 'string' && value.label.length > 0 ? value.label : id;
  const model: ProviderModel = { id, label };

  if (typeof value.description === 'string') model.description = value.description;
  if (value.languages === null) {
    model.languages = null;
  } else if (Array.isArray(value.languages)) {
    model.languages = value.languages.filter((tag): tag is string => typeof tag === 'string');
  }
  if (typeof value.pricePerMinuteUsd === 'number' && Number.isFinite(value.pricePerMinuteUsd)) {
    model.pricePerMinuteUsd = value.pricePerMinuteUsd;
  }
  if (isRecord(value.capabilities)) {
    const raw = value.capabilities;
    const capabilities: ProviderModelCapabilities = {};
    if (typeof raw.diarization === 'boolean') capabilities.diarization = raw.diarization;
    if (typeof raw.wordTimestamps === 'boolean') capabilities.wordTimestamps = raw.wordTimestamps;
    if (typeof raw.translate === 'boolean') capabilities.translate = raw.translate;
    model.capabilities = capabilities;
  }

  return model;
}

function coerceModels(value: unknown): ProviderModel[] {
  if (!Array.isArray(value)) return [];
  const models: ProviderModel[] = [];
  for (const entry of value) {
    const model = coerceProviderModel(entry);
    if (model) models.push(model);
  }
  return models;
}

function coerceKeyTestResult(value: unknown): KeyTestResult | null {
  if (!isRecord(value)) return null;
  if (typeof value.ok !== 'boolean' || typeof value.message !== 'string') return null;

  const result: KeyTestResult = { ok: value.ok, message: value.message };
  if (typeof value.account === 'string') result.account = value.account;
  if (Array.isArray(value.models)) result.models = coerceModels(value.models);
  return result;
}

function coerceProviderRecord(value: unknown): ProviderRecord {
  const raw = isRecord(value) ? value : {};
  const record: ProviderRecord = { models: coerceModels(raw.models) };
  if (typeof raw.selectedModelId === 'string' && raw.selectedModelId.length > 0) {
    record.selectedModelId = raw.selectedModelId;
  }
  const lastTest = coerceKeyTestResult(raw.lastTest);
  if (lastTest) record.lastTest = lastTest;
  return record;
}

// ── Store ─────────────────────────────────────────────────────────────────

let cache: SettingsFile | null = null;

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function load(): SettingsFile {
  if (cache) return cache;

  const file: SettingsFile = {
    version: FILE_VERSION,
    settings: coerceSettings(undefined, DEFAULT_SETTINGS),
    providers: {},
  };

  let raw: string;
  try {
    raw = readFileSync(settingsPath(), 'utf8');
  } catch {
    // No file yet. Deliberately not written here: a getter that touches disk
    // makes `getSettings()` fail on a read-only or full volume for no reason.
    cache = file;
    return file;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    cache = file;
    return file;
  }

  if (isRecord(parsed)) {
    // `version` is recorded but not gated on. A file from a future build is
    // read with the same per-field validation as any other; refusing to read it
    // would be the wholesale reset this design exists to avoid.
    if (typeof parsed.version === 'number') file.version = parsed.version;
    file.settings = coerceSettings(parsed.settings, DEFAULT_SETTINGS);
    if (isRecord(parsed.providers)) {
      for (const [id, record] of Object.entries(parsed.providers)) {
        if (isProviderId(id)) file.providers[id] = coerceProviderRecord(record);
      }
    }
  }

  cache = file;
  return file;
}

/**
 * Write to a sibling temp file and rename over the target.
 *
 * `rename` within a directory is atomic on APFS, HFS+ and NTFS: a reader sees
 * either the whole old file or the whole new one, never a prefix. Writing in
 * place would truncate first, and a crash in that window — or a laptop lid
 * closing on a low battery — leaves a zero-byte or half-written settings file
 * that parses as garbage on the next launch. The temp file is a sibling rather
 * than a temp-directory file specifically so the rename stays inside one volume
 * and cannot degrade into a copy.
 */
function persist(file: SettingsFile): void {
  const target = settingsPath();
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  writeFileSync(temp, JSON.stringify(file, null, 2), 'utf8');
  renameSync(temp, target);
  cache = file;
}

/** A deep copy, so a caller that mutates what it got cannot corrupt the cache. */
export function getSettings(): Settings {
  return structuredClone(load().settings);
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const file = load();
  file.version = FILE_VERSION;
  file.settings = coerceSettings(patch, file.settings);
  persist(file);
  return structuredClone(file.settings);
}

export function getProviderRecord(id: ProviderId): ProviderRecord {
  const stored = load().providers[id];
  if (!stored) return { models: [] };
  return structuredClone(stored);
}

/**
 * Shallow merge: each of the three fields is replaced wholesale when present.
 *
 * Deep-merging `models` would be wrong — a refresh that returns fewer models
 * than last time is the provider retiring one, and merging would resurrect it.
 */
export function saveProviderRecord(id: ProviderId, patch: ProviderRecordPatch): void {
  const file = load();
  const current = file.providers[id] ?? { models: [] };

  const next: ProviderRecord = {
    models: patch.models !== undefined ? coerceModels(patch.models) : current.models,
  };

  const selectedModelId = patch.selectedModelId ?? current.selectedModelId;
  if (selectedModelId !== undefined && selectedModelId.length > 0) {
    next.selectedModelId = selectedModelId;
  }

  const lastTest = patch.lastTest ?? current.lastTest;
  if (lastTest !== undefined) {
    // Re-coerced even though it came from an adapter in this process: it is the
    // one field written straight from a network response, and a provider that
    // returns something unexpected should not be able to poison the file for
    // every future launch.
    const coerced = coerceKeyTestResult(lastTest);
    if (coerced) next.lastTest = coerced;
  }

  file.providers[id] = next;
  file.version = FILE_VERSION;
  persist(file);
}

/**
 * Drops the whole record, not just the models.
 *
 * This runs when the user clears a provider's key. Leaving the cached model
 * list and the green "connected" test result behind would make the settings row
 * look configured when there is no longer a key to configure it with.
 */
export function clearProviderRecord(id: ProviderId): void {
  const file = load();
  if (file.providers[id] === undefined) return;
  delete file.providers[id];
  persist(file);
}
