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

const BUTTON =
  'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ' +
  'focus:outline-none focus:ring-2 focus:ring-brand/50 disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY = `${BUTTON} bg-brand text-white hover:bg-brand-hover`;
const QUIET =
  `${BUTTON} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 ` +
  'dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';

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
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  function close(): void {
    if (onClose !== undefined) onClose();
    else closeTranscript();
  }

  useEffect(() => {
    if (jobId === null || jobId === undefined) return;
    /*
     * `cancelled` rather than an AbortController: `renderTranscript` is an IPC
     * round trip with no cancellation on the other end, so the only thing worth
     * preventing is a late answer for format A overwriting the answer for
     * format B after the user has already switched.
     */
    let cancelled = false;
    setText(null);
    setError(null);
    void (async () => {
      try {
        const rendered = await renderTranscript(jobId, format);
        if (!cancelled) setText(rendered);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'The transcript could not be rendered.');
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, format, renderTranscript]);

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="transcript-title"
        tabIndex={-1}
        className="flex h-[min(88vh,48rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl focus:outline-none dark:bg-slate-950"
      >
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <div className="min-w-0">
            <h2 id="transcript-title" className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
              {title}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">Transcript</p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close the transcript"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand/50 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </header>

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-2 dark:border-slate-800">
          <div role="radiogroup" aria-label="Format" className="flex flex-wrap gap-1">
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
                    'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-brand/50 ' +
                    (selected
                      ? 'bg-brand-subtle text-brand'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800')
                  }
                >
                  {FORMAT_LABELS[entry]}
                </button>
              );
            })}
          </div>

          <div className="flex gap-2">
            <button type="button" className={QUIET} onClick={() => { void onCopy(); }} disabled={busy || text === null}>
              <Copy aria-hidden className="h-4 w-4" />
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className={PRIMARY} onClick={() => { void onExport(); }} disabled={busy || text === null}>
              <Download aria-hidden className="h-4 w-4" />
              Export
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden px-5 py-4">
          {error !== null ? (
            <p className="rounded-lg bg-red-50 p-3 text-sm text-red-900 dark:bg-red-950/50 dark:text-red-200">{error}</p>
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
              className="h-full overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand/50 dark:bg-slate-900 dark:text-slate-200"
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
