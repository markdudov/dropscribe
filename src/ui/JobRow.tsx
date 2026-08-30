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
 * The secondary actions, revealed by the pointer and by the keyboard.
 *
 * Four buttons on every row of a long queue is a wall; two is a row you can
 * read. `opacity-0` rather than `hidden` is the whole trick — the buttons stay
 * in the layout and in the tab order, so nothing shifts when they appear and a
 * keyboard user reaches them exactly where a mouse user sees them. Tabbing into
 * one puts the row in `:focus-within`, which reveals it.
 */
const REVEALED =
  'inline-flex opacity-0 transition-opacity duration-150 ease-crisp group-hover:opacity-100 group-focus-within:opacity-100';

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

/**
 * The same six states as a 6px dot.
 *
 * The word is the accessible answer and the dot is the glanceable one: scanning
 * a queue for the red one is a colour task, not a reading task. It carries no
 * information the label does not, which is why it is `aria-hidden`.
 */
function statusDotClasses(status: JobStatus): string {
  if (status === 'done') return 'bg-emerald-500';
  if (status === 'failed') return 'bg-red-500';
  if (status === 'cancelled') return 'bg-slate-400 dark:bg-ink-500';
  return 'bg-brand';
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
  /*
    Every row action is a ghost button, including the `primary` one. A filled,
    glowing button repeated down twenty rows would spend the screen's one loud
    accent twenty times over; a brand-tinted ghost is enough to say "this is the
    one you came for" without competing with the drop zone's real primary.
  */
  const toneClasses =
    tone === 'primary'
      ? 'border-brand/40 bg-brand-subtle text-brand hover:border-brand/60 hover:bg-brand/20 hover:text-brand-hover dark:border-brand/40 dark:bg-brand-subtle dark:text-brand-hover dark:hover:border-brand/60 dark:hover:bg-brand/20'
      : tone === 'danger'
        ? 'hover:border-red-300 hover:bg-red-50 hover:text-red-700 dark:hover:border-red-500/40 dark:hover:bg-red-500/10 dark:hover:text-red-400'
        : '';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled === true}
      {...(title !== undefined ? { title } : {})}
      className={`btn-ghost inline-flex items-center gap-1.5 px-2 py-1 text-xs ${toneClasses}`}
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
        className={`btn-ghost inline-flex items-center gap-1.5 px-2 py-1 text-xs ${
          open ? 'border-slate-400 bg-slate-50 dark:border-white/20 dark:bg-white/[0.08]' : ''
        }`}
      >
        {icon}
        {label}
        <ChevronDown
          className={`h-3 w-3 text-slate-400 transition-transform duration-150 ease-crisp dark:text-slate-500 ${
            open ? 'rotate-180' : ''
          }`}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <span
          role="menu"
          className="animate-fade-up absolute left-0 z-30 mt-1.5 flex w-28 flex-col rounded-xl border border-slate-200 bg-white p-1 shadow-modal dark:border-white/[0.07] dark:bg-ink-850"
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
              className="rounded-md px-2 py-1 text-left text-xs font-medium uppercase tracking-wide text-slate-700 transition duration-150 ease-crisp hover:bg-brand-subtle dark:text-slate-200"
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
    /*
      A card on the window rather than a line in a table. `group` is what lets
      the secondary actions below stay out of the way until the pointer or the
      keyboard arrives at this particular row.
    */
    <li className="group surface px-3.5 py-3 transition-colors duration-200 ease-crisp hover:border-slate-300 dark:hover:border-white/[0.12]">
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
          className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold ${statusClasses(job.status)}`}
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClasses(job.status)}`}
          />
          {STATUS_LABEL[job.status]}
        </span>
      </div>

      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.75rem] text-slate-500 dark:text-slate-400">
        {job.durationMs !== null ? (
          <span>
            <span className="tnum">{clock(job.durationMs)}</span> long
          </span>
        ) : null}
        {job.durationMs !== null ? <span aria-hidden="true">·</span> : null}
        <span className="truncate">{label}</span>
        {elapsedMs !== null ? <span aria-hidden="true">·</span> : null}
        {elapsedMs !== null ? (
          <span>
            {isTerminal(job.status) ? 'took' : 'elapsed'}{' '}
            <span className="tnum">{clock(elapsedMs)}</span>
          </span>
        ) : null}
      </p>

      {showBar ? (
        <div className="mt-2.5">
          {/*
            The track is a low-alpha white rather than a grey fill, so on the
            dark card it reads as a groove cut into the surface instead of a
            second bar sitting on it. The fill is the brand gradient — the only
            place in a row that carries the accent at full strength.
          */}
          <div
            className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-white/[0.06]"
            role="progressbar"
            aria-label={`${job.fileName}: ${job.progress.stage}`}
            {...(percent !== null
              ? { 'aria-valuenow': Math.round(percent), 'aria-valuemin': 0, 'aria-valuemax': 100 }
              : {})}
          >
            {percent !== null ? (
              <div
                className="h-full rounded-full bg-brand-sheen transition-[width] duration-300 ease-crisp"
                style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
              />
            ) : (
              <div className="bar-indeterminate h-full rounded-full bg-brand-sheen" />
            )}
          </div>
          <p
            aria-live="polite"
            className="mt-1.5 text-[0.75rem] text-slate-500 dark:text-slate-400"
          >
            {job.progress.stage}
            {percent !== null ? (
              <>
                {' · '}
                <span className="tnum">{Math.round(percent)}%</span>
              </>
            ) : null}
          </p>
        </div>
      ) : null}

      {/*
        `job.error !== undefined`, not `status === 'failed'`. The queue writes an
        error onto a job that SUCCEEDED when the automatic export fails, and says
        why in a comment: "failing to write a file into a read-only folder must
        not throw away the expensive thing, so this failure is reported on an
        otherwise successful job rather than turning the whole job red". It was
        reported nowhere — this block only ever rendered for a failed job, so the
        transcript was safe, the file was not written, and nothing said so.

        Amber rather than red when the job is done: the transcription worked and
        is one click away in View. Only the file on disk is missing.
      */}
      {job.error !== undefined ? (
        <div
          className={
            job.status === 'done'
              ? 'mt-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/[0.08] dark:text-amber-200'
              : 'mt-2.5 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800 dark:border-red-500/25 dark:bg-red-500/[0.08] dark:text-red-300'
          }
        >
          <p className="selectable font-medium">{job.error.message}</p>
          {job.status === 'done' ? (
            <p className="mt-0.5 opacity-80">The transcript itself is fine — open it with View, or export it somewhere else.</p>
          ) : null}
          {job.status !== 'done' && job.error.retryable ? null : job.status !== 'done' ? (
            <p className="mt-0.5 opacity-80">Trying again will not help until something changes.</p>
          ) : null}
          {job.error.detail !== undefined ? (
            /*
              The engine's own words, folded away. They are what makes a bug
              report useful and what makes the row unreadable, so they are one
              click from either. `<details>` rather than a state flag because the
              browser already owns the open/closed semantics, the keyboard
              handling and the accessible name.
            */
            <details className="mt-1.5">
              <summary className="cursor-pointer select-none font-medium opacity-80 transition-opacity duration-150 ease-crisp hover:opacity-100">
                Show the detail
              </summary>
              {/*
                The detail is a panel on a panel, not more red: once it is open
                the user is reading machine output, and tinting it the colour of
                the alarm makes a stack trace harder to read for no gain.
              */}
              <pre className="surface-raised selectable mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words p-2.5 font-mono text-xs leading-relaxed text-slate-700 dark:text-slate-300">
                {job.error.detail}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
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
            <span className={REVEALED}>
              <ActionButton
                onClick={() => void revealFile(job.filePath)}
                label="Reveal"
                title="Show the source file"
                icon={<FolderSearch className="h-3.5 w-3.5" aria-hidden="true" />}
              />
            </span>
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
        <span className={REVEALED}>
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
        </span>
      </div>
    </li>
  );
}
