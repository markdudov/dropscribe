/**
 * The local models: download once, then never send audio anywhere again.
 *
 * Grouped by engine rather than shown as one flat list of six. The two engines
 * are not interchangeable — Whisper translates and covers a hundred languages,
 * Parakeet is several times faster across twenty-five and cannot translate at
 * all — and a flat list sorted by size invites the user to compare a 574 MB
 * Whisper against a 669 MB Parakeet as though the only difference were the
 * number. The heading is where that difference gets said once, above the rows
 * it applies to.
 */

import { Ban, Download, FolderOpen, Loader2, Trash2 } from 'lucide-react';

import type { ModelState } from '../../../electron/api-types';
import type { EngineId } from '../../../electron/shared/models';
import { LOCAL_MODELS, formatBytes } from '../../../electron/shared/models';
import { useStore } from '../store';

const BUTTON =
  'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ' +
  'focus:outline-none focus:ring-2 focus:ring-brand/50 disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY = `${BUTTON} bg-brand text-white hover:bg-brand-hover`;
const QUIET =
  `${BUTTON} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 ` +
  'dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';
const DANGER =
  `${BUTTON} border border-red-300 bg-white text-red-700 hover:bg-red-50 ` +
  'dark:border-red-900 dark:bg-slate-900 dark:text-red-300 dark:hover:bg-red-950';

const ENGINE_GROUPS: readonly { id: EngineId; label: string; blurb: string }[] = [
  {
    id: 'whisper-cpp',
    label: 'Whisper',
    blurb: 'A hundred languages, and the only local option that can translate to English while it transcribes.',
  },
  {
    id: 'parakeet-cpp',
    label: 'Parakeet',
    blurb: 'NVIDIA’s model, several times faster than Whisper across 25 European languages. No translation.',
  },
];

/** RAM is quoted in MB in the catalogue; GB is the unit people own machines in. */
function ramLabel(mb: number): string {
  return mb >= 1024 ? `about ${(mb / 1024).toFixed(1)} GB of RAM` : `about ${mb} MB of RAM`;
}

function ModelRow({ state }: { state: ModelState }): JSX.Element {
  const downloadModel = useStore((s) => s.downloadModel);
  const cancelModelDownload = useStore((s) => s.cancelModelDownload);
  const deleteModel = useStore((s) => s.deleteModel);

  const percent = state.downloadPercent;
  const languages = state.languages;

  return (
    <li className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h4 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            {state.label}
            {state.recommended === true ? (
              <span className="rounded-full bg-brand-subtle px-2 py-0.5 text-xs font-medium text-brand">Recommended</span>
            ) : null}
            {state.installed ? (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                Ready to use
              </span>
            ) : null}
          </h4>
          <p className="mt-1 max-w-prose text-sm text-slate-600 dark:text-slate-400">{state.blurb}</p>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {formatBytes(state.bytes)} · {ramLabel(state.approxRamMb)} · Weights licensed {state.license} ·{' '}
            {languages === null ? 'Any language' : `${languages.length} languages`}
          </p>
        </div>

        <div className="flex shrink-0 gap-2">
          {state.downloading ? (
            <button type="button" className={QUIET} onClick={() => { void cancelModelDownload(state.id); }}>
              <Ban aria-hidden className="h-4 w-4" />
              Stop
            </button>
          ) : state.installed ? (
            <button type="button" className={DANGER} onClick={() => { void deleteModel(state.id); }}>
              <Trash2 aria-hidden className="h-4 w-4" />
              Delete
            </button>
          ) : (
            <button type="button" className={PRIMARY} onClick={() => { void downloadModel(state.id); }}>
              <Download aria-hidden className="h-4 w-4" />
              {state.error !== undefined ? 'Download again' : 'Download'}
            </button>
          )}
        </div>
      </div>

      {state.downloading ? (
        <div className="mt-3">
          {/*
            An explicit `progressbar` role rather than `<progress>`: the native
            element cannot be styled consistently across macOS and Windows, and
            a download that reports no percentage yet needs an indeterminate
            state the element does not give for free.
          */}
          <div
            role="progressbar"
            aria-label={`Downloading ${state.label}`}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(percent !== null ? { 'aria-valuenow': Math.round(percent) } : {})}
            className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
          >
            <div
              className={percent === null ? 'h-full w-1/3 animate-pulse bg-brand' : 'h-full bg-brand transition-[width]'}
              style={percent === null ? undefined : { width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
          </div>
          <p className="mt-1 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
            <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
            {percent === null
              ? 'Starting the download…'
              : `Downloading… ${Math.round(percent)}% — ${formatBytes(state.onDiskBytes)} of ${formatBytes(state.bytes)}`}
          </p>
        </div>
      ) : null}

      {state.error !== undefined ? (
        <p className="mt-3 rounded-lg bg-red-50 p-2 text-xs text-red-900 dark:bg-red-950/50 dark:text-red-200">
          {state.error}
        </p>
      ) : null}
    </li>
  );
}

export function ModelsTab(): JSX.Element {
  const models = useStore((s) => s.models);
  const appInfo = useStore((s) => s.appInfo);
  const revealFile = useStore((s) => s.revealFile);

  /*
   * The catalogue is the source of order, and main's list only supplies the
   * on-disk facts. Iterating main's array instead would let a model whose state
   * happened to arrive first outrank the one marked `recommended`, and the
   * order of a list of six downloads is the whole of its editorial content.
   */
  const rows: ModelState[] = LOCAL_MODELS.map((model) => {
    const state = models.find((entry) => entry.id === model.id);
    return state ?? { ...model, installed: false, onDiskBytes: 0, downloading: false, downloadPercent: null };
  });

  const installed = rows.filter((row) => row.installed).length;
  const modelsDir = appInfo?.modelsDir ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Local models</h2>
        <p className="mt-1 max-w-prose text-sm text-slate-600 dark:text-slate-400">
          Downloaded once. After that everything runs on this computer and no audio leaves it.
        </p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {installed === 1 ? '1 installed' : `${installed} installed`}
        </p>
      </div>

      {ENGINE_GROUPS.map((group) => {
        const groupRows = rows.filter((row) => row.engine === group.id);
        if (groupRows.length === 0) return null;
        return (
          <section key={group.id} aria-labelledby={`engine-${group.id}`}>
            <h3 id={`engine-${group.id}`} className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {group.label}
            </h3>
            <p className="mb-2 max-w-prose text-xs text-slate-500 dark:text-slate-400">{group.blurb}</p>
            <ul className="space-y-2">
              {groupRows.map((row) => <ModelRow key={row.id} state={row} />)}
            </ul>
          </section>
        );
      })}

      <section
        aria-label="Models folder"
        className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-200">Models folder</p>
          <p className="truncate font-mono text-xs text-slate-500 dark:text-slate-400" title={modelsDir ?? ''}>
            {modelsDir ?? 'Not known yet'}
          </p>
        </div>
        <button
          type="button"
          className={QUIET}
          disabled={modelsDir === null}
          onClick={() => { if (modelsDir !== null) void revealFile(modelsDir); }}
        >
          <FolderOpen aria-hidden className="h-4 w-4" />
          Reveal
        </button>
      </section>
    </div>
  );
}

export default ModelsTab;
