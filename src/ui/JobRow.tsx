/**
 * One file's row.
 *
 * The row is deliberately the same height and the same shape in every state.
 * Progress, errors and the finished actions all live in the block under the
 * name, so a queue of eight files does not reflow every time one of them
 * finishes — a list that jumps is a list where you click the wrong Remove.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Ban,
  ChevronDown,
  Copy,
  Download,
  Eye,
  FolderSearch,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';

import type { ExportFormat } from '../../electron/api-types';
import { EXPORT_FORMATS } from '../../electron/api-types';
import type { Job, JobStatus } from '../../electron/shared/jobs';
import { isTerminal } from '../../electron/shared/jobs';
import { describeTarget } from './TargetPicker';
import { useStore } from './store';

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Waiting',
  preparing: 'Preparing',
  running: 'Transcribing',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * `h:mm:ss` past an hour, `m:ss` below it.
 *
 * Always-`0:04:12` is what a machine writes; `4:12` is what a person reads. The
 * same function formats both the media duration and the elapsed time on purpose,
 * so "12:30 long · 4:12 elapsed" compares at a glance.
 */
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}

/** Green for done and red for failed, and nothing else in the app may use them. */
function statusClasses(status: JobStatus): string {
  if (status === 'done') return 'text-emerald-600 dark:text-emerald-400';
  if (status === 'failed') return 'text-red-600 dark:text-red-400';
  if (status === 'cancelled') return 'text-slate-500 dark:text-slate-400';
  return 'text-brand';
}

interface ActionButtonProps {
  onClick: () => void;
  label: string;
  icon: ReactElement;
  /** `danger` is reserved for Remove; nothing else in a row is destructive. */
  tone?: 'default' | 'danger' | 'primary';
  disabled?: boolean;
  title?: string;
}

function ActionButton({
  onClick,
  label,
  icon,
  tone,
  disabled,
  title,
}: ActionButtonProps): ReactElement {
  const toneClasses =
    tone === 'primary'
      ? 'border-brand bg-brand text-white hover:bg-brand-hover'
      : tone === 'danger'
        ? 'border-slate-300 bg-white text-slate-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-red-500/50 dark:hover:bg-red-500/10 dark:hover:text-red-400'
        : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled === true}
      {...(title !== undefined ? { title } : {})}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${toneClasses}`}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * Six formats behind one button.
 *
 * `exportTranscript` opens a save dialog, and a save dialog cannot ask which
 * *format* the caller meant — the extension it offers is decided before it
 * opens. So the choice has to happen here, before the dialog, rather than in it.
 */
function FormatMenu({
  onPick,
  label,
  icon,
}: {
  onPick: (format: ExportFormat) => void;
  label: string;
  icon: ReactElement;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const node = rootRef.current;
      if (node !== null && event.target instanceof Node && !node.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    // `pointerdown`, not `click`: closing on click would let the very click
    // that dismisses the menu also activate whatever was behind it.
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <span className="relative inline-block" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
      >
        {icon}
        {label}
        <ChevronDown className="h-3 w-3 text-slate-400" aria-hidden="true" />
      </button>
      {open ? (
        <span
          role="menu"
          className="absolute left-0 z-30 mt-1 flex w-28 flex-col rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {EXPORT_FORMATS.map((format) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(format);
              }}
              className="rounded-md px-2 py-1 text-left text-xs font-medium uppercase tracking-wide text-slate-700 transition hover:bg-brand-subtle dark:text-slate-200"
            >
              {format}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

export interface JobRowProps {
  job: Job;
}

export function JobRow({ job }: JobRowProps): ReactElement {
  const providers = useStore((s) => s.providers);
  const cancelJob = useStore((s) => s.cancelJob);
  const retryJob = useStore((s) => s.retryJob);
  const removeJob = useStore((s) => s.removeJob);
  const revealFile = useStore((s) => s.revealFile);
  const openTranscript = useStore((s) => s.openTranscript);
  const exportTranscript = useStore((s) => s.exportTranscript);
  const copyTranscript = useStore((s) => s.copyTranscript);

  const running = !isTerminal(job.status);

  /**
   * A clock that ticks only while something is actually running.
   *
   * A single interval in `JobList` re-rendering every row once a second would
   * be cheaper in timers and much more expensive in renders; a queue of twenty
   * finished files would repaint every second forever for the sake of the one
   * that is still going.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || job.startedAt === undefined) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running, job.startedAt]);

  const label = useMemo(() => describeTarget(job.target, providers), [job.target, providers]);

  const elapsedMs =
    job.startedAt === undefined
      ? null
      : (job.finishedAt ?? (running ? now : job.startedAt)) - job.startedAt;

  const percent = job.progress.percent;
  const showBar = job.status === 'queued' || job.status === 'preparing' || job.status === 'running';

  return (
    <li className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 dark:border-slate-800 dark:bg-slate-900/60">
      <div className="flex items-baseline gap-2">
        {/*
          The full path is a `title` rather than a second line. Two files called
          `interview.mp4` from different folders look identical in a list, and
          the path is the only thing that separates them — but it is also long
          enough to wreck the layout of every row for the sake of the rare
          collision. Hover answers it; `.selectable` lets it be copied.
        */}
        <span
          className="selectable min-w-0 flex-1 truncate text-sm font-medium text-slate-800 dark:text-slate-100"
          title={job.filePath}
        >
          {job.fileName}
        </span>
        <span
          aria-live="polite"
          className={`shrink-0 text-xs font-semibold ${statusClasses(job.status)}`}
        >
          {STATUS_LABEL[job.status]}
        </span>
      </div>

      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
        {job.durationMs !== null ? <span>{clock(job.durationMs)} long</span> : null}
        {job.durationMs !== null ? <span aria-hidden="true">·</span> : null}
        <span className="truncate">{label}</span>
        {elapsedMs !== null ? <span aria-hidden="true">·</span> : null}
        {elapsedMs !== null ? (
          <span>
            {isTerminal(job.status) ? 'took' : 'elapsed'} {clock(elapsedMs)}
          </span>
        ) : null}
      </p>

      {showBar ? (
        <div className="mt-2">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
            role="progressbar"
            aria-label={`${job.fileName}: ${job.progress.stage}`}
            {...(percent !== null
              ? { 'aria-valuenow': Math.round(percent), 'aria-valuemin': 0, 'aria-valuemax': 100 }
              : {})}
          >
            {percent !== null ? (
              <div
                className="h-full rounded-full bg-brand transition-[width] duration-300 ease-out"
                style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
              />
            ) : (
              <div className="bar-indeterminate h-full rounded-full bg-brand" />
            )}
          </div>
          <p aria-live="polite" className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {job.progress.stage}
            {percent !== null ? ` · ${Math.round(percent)}%` : ''}
          </p>
        </div>
      ) : null}

      {job.status === 'failed' && job.error !== undefined ? (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
          <p className="selectable font-medium">{job.error.message}</p>
          {job.error.retryable ? null : (
            <p className="mt-0.5 opacity-80">Trying again will not help until something changes.</p>
          )}
          {job.error.detail !== undefined ? (
            /*
              The engine's own words, folded away. They are what makes a bug
              report useful and what makes the row unreadable, so they are one
              click from either. `<details>` rather than a state flag because the
              browser already owns the open/closed semantics, the keyboard
              handling and the accessible name.
            */
            <details className="mt-1.5">
              <summary className="cursor-pointer select-none font-medium opacity-80 hover:opacity-100">
                Show the detail
              </summary>
              <pre className="selectable mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-red-100/70 p-2 font-mono text-[0.6875rem] leading-relaxed dark:bg-red-950/40">
                {job.error.detail}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {running ? (
          <ActionButton
            onClick={() => void cancelJob(job.id)}
            label="Cancel"
            icon={<X className="h-3.5 w-3.5" aria-hidden="true" />}
          />
        ) : null}

        {job.status === 'done' ? (
          <>
            <ActionButton
              onClick={() => openTranscript(job.id)}
              label="View"
              tone="primary"
              icon={<Eye className="h-3.5 w-3.5" aria-hidden="true" />}
            />
            {/* Both menus report through the store's notice line, which is why
                neither keeps a local "Copied"/"Saved" flag of its own. */}
            <FormatMenu
              label="Copy"
              onPick={(format) => void copyTranscript(job.id, format)}
              icon={<Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            />
            <FormatMenu
              label="Export"
              onPick={(format) => void exportTranscript(job.id, format)}
              icon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}
            />
            <ActionButton
              onClick={() => void revealFile(job.filePath)}
              label="Reveal"
              title="Show the source file"
              icon={<FolderSearch className="h-3.5 w-3.5" aria-hidden="true" />}
            />
          </>
        ) : null}

        {job.status === 'failed' ? (
          <ActionButton
            onClick={() => void retryJob(job.id)}
            label="Try again"
            tone="primary"
            disabled={job.error?.retryable === false}
            icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
          />
        ) : null}

        {job.status === 'cancelled' ? (
          <ActionButton
            onClick={() => void retryJob(job.id)}
            label="Try again"
            icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
          />
        ) : null}

        {/* Remove is always available, including mid-run: main cancels first. */}
        <ActionButton
          onClick={() => void removeJob(job.id)}
          label="Remove"
          tone="danger"
          icon={
            running ? (
              <Ban className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            )
          }
        />
      </div>
    </li>
  );
}
