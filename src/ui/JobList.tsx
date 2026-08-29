/**
 * The queue, plus the two things you do to a queue rather than to one job.
 *
 * There is no selection model here — no checkboxes, no shift-click range. The
 * only bulk operations this app has are "clear the finished ones" and "export
 * everything that finished", and both of those are answerable from the job
 * statuses alone. A selection UI would be a second source of truth about which
 * rows matter, maintained for two buttons.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Download, ListChecks, Trash2 } from 'lucide-react';

import type { ExportFormat } from '../../electron/api-types';
import { isTerminal } from '../../electron/shared/jobs';
import { JobRow } from './JobRow';
import { api, useStore } from './store';

/**
 * What "Export all…" writes when the user has no automatic formats configured.
 *
 * `settings.output.formats` being empty means "write nothing when a job
 * finishes" — a preference about automatic behaviour, not a statement that the
 * user wants no files ever. Pressing Export all… is an explicit request, and
 * honouring it by writing zero files would look exactly like a bug. Plain text
 * is the least surprising thing to produce for someone who has expressed no
 * opinion at all.
 */
const FALLBACK_EXPORT_FORMATS: readonly ExportFormat[] = ['txt'];

export function JobList(): ReactElement {
  const jobs = useStore((s) => s.jobs);
  const outputFormats = useStore((s) => s.settings.output.formats);
  const clearFinished = useStore((s) => s.clearFinished);
  const setNotice = useStore((s) => s.setNotice);

  const [exporting, setExporting] = useState(false);

  const finishedCount = useMemo(() => jobs.filter((j) => isTerminal(j.status)).length, [jobs]);
  const doneIds = useMemo(() => jobs.filter((j) => j.status === 'done').map((j) => j.id), [jobs]);

  /**
   * The one bridge call this file makes directly.
   *
   * `exportMany` is not on the store, and it does not belong there: it writes
   * files and changes nothing the store mirrors, so wrapping it would add an
   * action whose only job is to forward its arguments. `api()` is the store's
   * own guarded accessor, so a missing preload still produces the store's
   * sentence about it rather than a `TypeError` in a click handler.
   */
  const exportAll = (): void => {
    const formats = outputFormats.length > 0 ? outputFormats : [...FALLBACK_EXPORT_FORMATS];
    setExporting(true);
    void api()
      .exportMany(doneIds, formats)
      .then((count) => {
        // Zero is a real answer — the save dialog was cancelled — and saying
        // "Wrote 0 files" is more honest than saying nothing and leaving the
        // user to check the folder.
        setNotice(count === 1 ? 'Wrote 1 file' : `Wrote ${count} files`);
      })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : 'The export failed.');
      })
      .finally(() => setExporting(false));
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Queue">
      {/*
        A toolbar belonging to the window rather than a strip laid on top of it:
        no fill of its own, a small-caps count on the left, ghost actions on the
        right, and one hairline underneath doing all the separating. A filled bar
        here would stack a third rectangle between the header and the cards.
      */}
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-5 pb-2.5 pt-1 dark:border-white/[0.06]">
        <h2 className="tnum text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {jobs.length === 1 ? '1 file' : `${jobs.length} files`}
        </h2>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void clearFinished()}
            disabled={finishedCount === 0}
            className="btn-ghost inline-flex items-center gap-1.5 px-2 py-1 text-xs"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            Clear finished
          </button>
          <button
            type="button"
            onClick={exportAll}
            // Nothing has finished means there is nothing to render, and a save
            // dialog that opens onto an empty batch is worse than a dim button.
            disabled={doneIds.length === 0 || exporting}
            className="btn-ghost inline-flex items-center gap-1.5 px-2 py-1 text-xs"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Export all…
          </button>
        </div>
      </div>

      {jobs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-5 pb-6 text-center">
          <ListChecks className="h-8 w-8 text-slate-300 dark:text-ink-600" aria-hidden="true" />
          <p className="text-sm text-slate-500 dark:text-slate-400">The queue is empty.</p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 pb-4 pt-3">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </ul>
      )}
    </section>
  );
}
