/**
 * The whole application, in one window.
 *
 * There is no wizard, no onboarding carousel and no second screen. The app has
 * exactly one job — a file goes in, a transcript comes out — and everything
 * that is not that (models, keys, output folders, subtitle rules) is behind the
 * gear. What is left is a header, a drop target and a list, and the only layout
 * decision worth its own paragraph is what happens to the drop target when the
 * list stops being empty: it collapses from the whole window into a strip. The
 * alternative, keeping a large drop zone above a scrolling list, spends half
 * the window forever on an affordance the user has already understood.
 *
 * This component owns three things nothing else can: the one call to
 * `store.init()`, the fatal screen for when that call fails, and the transient
 * `notice` line. The store writes a notice from a dozen places and renders none
 * of them; without a shell that displays it, every handled error in the app
 * would be silent.
 */

import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { AlertTriangle, FileAudio, Settings as SettingsIcon, X } from 'lucide-react';

import { DropZone } from './DropZone';
import { JobList } from './JobList';
import { SettingsModal } from './SettingsModal';
import { TargetPicker } from './TargetPicker';
import { TranscriptView } from './TranscriptView';
import { useStore } from './store';

/** How long a notice stays before it stops being information and starts being clutter. */
const NOTICE_MS = 6000;

export function App(): ReactElement {
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const initError = useStore((s) => s.initError);
  const jobCount = useStore((s) => s.jobs.length);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const transcriptJobId = useStore((s) => s.transcriptJobId);
  const openSettings = useStore((s) => s.openSettings);
  const notice = useStore((s) => s.notice);
  const setNotice = useStore((s) => s.setNotice);
  // Assume the engines are fine until main says otherwise, so the warning strip
  // does not flash on every launch during the first IPC round trip.
  const enginesReady = useStore((s) => s.appInfo?.enginesReady ?? true);

  useEffect(() => {
    void init();
  }, [init]);

  /*
    No `dispose()` in this effect's cleanup, deliberately. `App` unmounts only
    when the renderer is being torn down, at which point the IPC listeners die
    with the process anyway — and a cleanup that ran while the in-flight
    `init()` was still resolving would clear the teardown list a moment before
    `init` pushed new entries onto it, leaking exactly what it meant to
    collect. `dispose()` exists for tests, which control both ends.
  */

  useEffect(() => {
    if (notice === null) return;
    const id = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(id);
  }, [notice, setNotice]);

  if (initError !== null) {
    // No header, no drop zone, no settings gear. Every one of them would be a
    // control that does nothing, because all of them are IPC calls to a main
    // process this window could not reach.
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md space-y-2 text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-red-500" aria-hidden="true" />
          <h1 className="text-lg font-semibold">DropScribe could not start</h1>
          <p className="selectable text-sm text-slate-600 dark:text-slate-400">{initError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="drag-region flex shrink-0 items-center gap-3 border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
        <div className="flex min-w-0 items-center gap-2">
          <FileAudio className="h-5 w-5 shrink-0 text-brand" aria-hidden="true" />
          <h1 className="truncate text-sm font-semibold tracking-tight">DropScribe</h1>
        </div>

        <div className="no-drag ml-auto flex items-center gap-2">
          <TargetPicker />
          <button
            type="button"
            onClick={() => openSettings()}
            aria-label="Settings"
            title="Settings"
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-600 transition hover:border-slate-400 hover:bg-slate-50 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            <SettingsIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      {!enginesReady ? (
        // Said here, at launch, rather than at the bottom of a failed job an
        // hour later. A missing vendored binary breaks every local model at
        // once, and no amount of retrying a job will fix it.
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            A transcription engine is missing from this build, so local models cannot run. Cloud
            providers still work.
          </span>
          <button
            type="button"
            onClick={() => openSettings('about')}
            className="shrink-0 rounded-md bg-amber-200/70 px-2 py-1 text-xs font-semibold text-amber-900 transition hover:bg-amber-200 dark:bg-amber-400/20 dark:text-amber-100 dark:hover:bg-amber-400/30"
          >
            Details
          </button>
        </div>
      ) : null}

      <main className="flex min-h-0 flex-1 flex-col">
        {ready ? (
          <>
            <DropZone variant={jobCount === 0 ? 'full' : 'bar'} />
            {jobCount > 0 ? <JobList /> : null}
          </>
        ) : (
          // Five frames on a fast machine, longer on a cold start with a big
          // models directory. Showing the empty-queue drop zone here would be a
          // lie: with no target picked yet, a file dropped into it bounces.
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-slate-400 dark:text-slate-600">Starting…</p>
          </div>
        )}
      </main>

      {settingsOpen ? <SettingsModal /> : null}
      {transcriptJobId !== null ? <TranscriptView /> : null}

      {notice !== null ? (
        /*
          Above both overlays (`z-40` for settings, `z-50` for the transcript),
          because the actions that produce a notice are mostly taken from inside
          them — a key that would not save, an export that would not write. A
          toast the modal covers is a toast nobody reads.
        */
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4"
        >
          <div className="pointer-events-auto flex max-w-xl items-start gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 shadow-lg dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
            <span className="selectable min-w-0 break-words">{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
              className="-mr-1 shrink-0 rounded-md p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-100"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
