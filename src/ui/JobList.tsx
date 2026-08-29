/**
 * The queue.
 *
 * There is no selection model here — no checkboxes, no shift-click range — and
 * no bulk actions either. Everything you do to a transcript you do to one job,
 * from that job's own row; the header above the list only counts.
 */

import type { ReactElement } from 'react';
import { ListChecks } from 'lucide-react';

import { JobRow } from './JobRow';
import { useStore } from './store';

export function JobList(): ReactElement {
  const jobs = useStore((s) => s.jobs);

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Queue">
      {/*
        A count, not a toolbar.

        There were two bulk actions here — Clear finished and Export all… — and
        they are gone on purpose. Everything you do to a transcript you do to the
        job it belongs to, from that job's own row, where the file name is right
        there to confirm you picked the right one. A bulk button acts on a set
        the user has to hold in their head.

        What is left has no fill of its own: a small-caps count and one hairline
        underneath doing all the separating. A filled bar would stack a third
        rectangle between the header and the cards.
      */}
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-5 pb-2.5 pt-1 dark:border-white/[0.06]">
        <h2 className="tnum text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {jobs.length === 1 ? '1 file' : `${jobs.length} files`}
        </h2>
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
