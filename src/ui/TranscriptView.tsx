/**
 * A finished transcript, in whichever shape the user asks for.
 *
 * The preview is rendered by **main**, through `renderTranscript(jobId, format)`,
 * even though `electron/shared/exports.ts` is pure and the renderer could import
 * it directly. That was the tempting shortcut and it is a trap: the renderer
 * would then need the whole `Transcript` in memory, and the preview would be
 * produced by a different code path from the file that gets exported — so the
 * one thing this panel exists to promise, that what you see is what lands on
 * disk, would be a coincidence rather than a guarantee.
 *
 * Every prop is optional; the panel drives itself from the store.
 */

import { useEffect, useRef, useState } from 'react';
import { Copy, Download, Loader2, X } from 'lucide-react';

import type { ExportFormat } from '../../electron/api-types';
import { EXPORT_FORMATS } from '../../electron/api-types';
import { useStore } from './store';

export interface TranscriptViewProps {
  /** Overrides the store's `transcriptJobId`. */
  jobId?: string;
  onClose?: () => void;
}

const FORMAT_LABELS: Readonly<Record<ExportFormat, string>> = {
  txt: 'Text',
  md: 'Markdown',
  srt: 'SRT',
  vtt: 'VTT',
  json: 'JSON',
  csv: 'CSV',
};

export function TranscriptView({ jobId: jobIdProp, onClose }: TranscriptViewProps = {}): JSX.Element | null {
  const storeJobId = useStore((s) => s.transcriptJobId);
  const closeTranscript = useStore((s) => s.closeTranscript);
  const jobs = useStore((s) => s.jobs);
  const renderTranscript = useStore((s) => s.renderTranscript);
  const exportTranscript = useStore((s) => s.exportTranscript);
  const copyTranscript = useStore((s) => s.copyTranscript);

  const jobId = jobIdProp ?? storeJobId;
  const job = jobId === null ? undefined : jobs.find((entry) => entry.id === jobId);

  const [format, setFormat] = useState<ExportFormat>('txt');
  /*
   * One piece of state, stamped with the request it answers, rather than a
   * `text`/`error` pair that an effect blanks on the way in. Switching format
   * makes the stamp stop matching, so the previous answer stops being current
   * in the same render that asks for the new one — no intermediate render
   * where the old text is still on screen under the new tab.
   */
  const [rendered, setRendered] = useState<{ key: string; text: string | null; error: string | null } | null>(null);
  const requestKey = jobId === null || jobId === undefined ? null : `${jobId}\u0000${format}`;
  const current = rendered !== null && rendered.key === requestKey ? rendered : null;
  const text = current?.text ?? null;
  const error = current?.error ?? null;

  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  function close(): void {
    if (onClose !== undefined) onClose();
    else closeTranscript();
  }

  useEffect(() => {
    if (jobId === null || jobId === undefined || requestKey === null) return;
    /*
     * `cancelled` rather than an AbortController: `renderTranscript` is an IPC
     * round trip with no cancellation on the other end, so the only thing worth
     * preventing is a late answer for format A overwriting the answer for
     * format B after the user has already switched.
     */
    let cancelled = false;
    void (async () => {
      try {
        const out = await renderTranscript(jobId, format);
        if (!cancelled) setRendered({ key: requestKey, text: out, error: null });
      } catch (caught) {
        if (!cancelled) {
          setRendered({
            key: requestKey,
            text: null,
            error: caught instanceof Error ? caught.message : 'The transcript could not be rendered.',
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, format, requestKey, renderTranscript]);

  useEffect(() => {
    if (jobId === null || jobId === undefined) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
    };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();
    return () => { document.removeEventListener('keydown', onKeyDown); };
    // `close` is deliberately not a dependency: it is stable in behaviour and
    // listing it would re-bind the listener on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  if (jobId === null || jobId === undefined) return null;

  const title = job?.fileName ?? 'Transcript';

  async function onCopy(): Promise<void> {
    if (jobId === null || jobId === undefined) return;
    setBusy(true);
    try {
      await copyTranscript(jobId, format);
      setCopied(true);
      window.setTimeout(() => { setCopied(false); }, 2000);
    } finally {
      setBusy(false);
    }
  }

  async function onExport(): Promise<void> {
    if (jobId === null || jobId === undefined) return;
    setBusy(true);
    try {
      await exportTranscript(jobId, format);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm dark:bg-ink-950/60"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="transcript-title"
        tabIndex={-1}
        className="flex h-[min(88vh,48rem)] w-full max-w-4xl animate-fade-up flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-modal focus:outline-none dark:border-white/[0.07] dark:bg-ink-900"
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 px-5 py-3.5 dark:border-white/[0.06]">
          <div className="min-w-0">
            <h2 id="transcript-title" className="truncate text-base font-semibold tracking-[-0.01em] text-slate-900 dark:text-white">
              {title}
            </h2>
            <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">Transcript</p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close the transcript"
            className="btn-icon"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </header>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3 dark:border-white/[0.06]">
          {/*
            The same segmented control as the settings tabs, because it is the
            same gesture: six mutually exclusive renderings of one transcript.
            Six loose pills would read as six things you could do; one track
            with a raised cell reads as one switch that is currently set to Text.
          */}
          <div role="radiogroup" aria-label="Format" className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1 dark:bg-white/[0.04]">
            {EXPORT_FORMATS.map((entry) => {
              const selected = entry === format;
              return (
                <button
                  key={entry}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => { setFormat(entry); }}
                  className={
                    'rounded-xl px-3 py-1.5 text-sm font-medium transition duration-150 ease-crisp ' +
                    (selected
                      ? 'bg-white text-slate-900 shadow-panel dark:bg-ink-750 dark:text-white'
                      : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200')
                  }
                >
                  {FORMAT_LABELS[entry]}
                </button>
              );
            })}
          </div>

          {/*
            Export is the reason the panel is open — Copy is the shortcut for
            when the destination is another window rather than a file — so
            Export takes the one primary treatment and Copy stays ghost beside
            it. Two filled buttons side by side is two of them asking to be
            pressed, which is one too many.
          */}
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-ghost inline-flex items-center gap-2 py-2"
              onClick={() => { void onCopy(); }}
              disabled={busy || text === null}
            >
              <Copy aria-hidden className="h-4 w-4" />
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              className="btn-primary inline-flex items-center gap-2"
              onClick={() => { void onExport(); }}
              disabled={busy || text === null}
            >
              <Download aria-hidden className="h-4 w-4" />
              Export
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden px-5 py-5">
          {error !== null ? (
            <p className="selectable rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-500/25 dark:bg-red-500/[0.08] dark:text-red-200">{error}</p>
          ) : text === null ? (
            <p className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              Rendering…
            </p>
          ) : (
            <pre
              // Focusable so the scroll area is reachable without a pointer, and
              // `whitespace-pre-wrap` rather than `pre`: an SRT wraps naturally
              // but a paragraph of plain text would otherwise scroll sideways
              // for the length of a sentence.
              tabIndex={0}
              aria-label={`Transcript as ${FORMAT_LABELS[format]}`}
              // The one place in the app that is genuinely a reading surface, so
              // it gets a raised panel of its own and the room to breathe that
              // goes with it: monospace at 13px, relaxed leading, and selectable
              // text, because copying a paragraph out of it is the point.
              className="surface-raised selectable h-full overflow-auto whitespace-pre-wrap p-5 font-mono text-[0.8125rem] leading-relaxed text-slate-800 focus:outline-none dark:text-slate-200"
            >
              {text}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export default TranscriptView;
