/**
 * The front door.
 *
 * It has two shapes and one behaviour. With an empty queue it is the whole
 * window, because at that moment "drop a file here" is the only thing the app
 * has to say. Once there are jobs it shrinks to a bar at the top, because the
 * user's attention belongs on the list and the drop target still has to be
 * there — a queue you cannot add to is a queue you have to clear first.
 *
 * What this file decides, and what it hands off: it decides which of the
 * dropped files are worth sending on, and it says so in the one place the user
 * is looking. Everything after that — no target picked, main refusing the
 * enqueue — belongs to the store, which already has an answer for each and a
 * notice line to say it in.
 */

import { useCallback, useState } from 'react';
import type { DragEvent, ReactElement } from 'react';
import { Ban, FolderOpen, Settings as SettingsIcon, UploadCloud, X } from 'lucide-react';

import { isMediaFile } from '../../electron/shared/media-extensions';
import { useStore } from './store';

interface DropReport {
  accepted: number;
  /** Names of files whose extension is not audio or video. */
  notMedia: string[];
  /** Names that looked like media but could not be resolved to a readable path. */
  unreadable: string[];
}

const EMPTY_REPORT: DropReport = { accepted: 0, notMedia: [], unreadable: [] };

/** "a.mp4, b.mov and 3 more" — a list the user can act on without a scrollbar. */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, 2).join(', ');
  const rest = names.length - 2;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

export interface DropZoneProps {
  /** `full` fills the window when the queue is empty; `bar` is the slim header strip. */
  variant: 'full' | 'bar';
}

export function DropZone({ variant }: DropZoneProps): ReactElement {
  const addFiles = useStore((s) => s.addFiles);
  const openFiles = useStore((s) => s.openFiles);
  const openSettings = useStore((s) => s.openSettings);
  const hasTarget = useStore((s) => s.target !== null);

  const [dragging, setDragging] = useState(false);
  const [report, setReport] = useState<DropReport>(EMPTY_REPORT);
  const [busy, setBusy] = useState(false);

  /**
   * How many files the pointer is carrying, when the platform will say.
   *
   * During a drag the browser hides file *contents* — `dataTransfer.files` is
   * empty until the drop — but it does expose `items`, which is enough to
   * promise "3 files" instead of a vague "release to transcribe".
   */
  const [carrying, setCarrying] = useState(0);

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    // Without this the cursor shows the "move" badge and, on Windows, some
    // sources refuse to complete the drop at all.
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
    setCarrying(Array.from(event.dataTransfer.items).filter((i) => i.kind === 'file').length);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    // `dragleave` fires every time the pointer crosses into a child element, so
    // clearing unconditionally makes the highlight strobe as the user moves over
    // the icon and the text. Ignoring the ones that land on a descendant is what
    // makes the state track the actual boundary.
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setDragging(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      setDragging(false);

      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;

      const accepted: string[] = [];
      const notMedia: string[] = [];
      const unreadable: string[] = [];

      for (const file of files) {
        // The extension check runs first so the two failures stay distinct. A
        // JPEG and an unreadable MP4 both come back "no" from `authorizePath`,
        // and telling the user "that is not a media file" about a video they can
        // watch would be a lie they cannot debug.
        if (!isMediaFile(file.name)) {
          notMedia.push(file.name);
          continue;
        }

        // `pathForFile` is `webUtils.getPathForFile` behind the bridge — the
        // only way back to a path since Electron 32 stopped augmenting `File`.
        // It answers `''` when there is no real file behind the drag, which is
        // not hypothetical: text dragged out of a browser, an item from a
        // virtual folder and a `File` built in JavaScript all land here. That
        // is an unreadable file, not a rejected one, and the button below is
        // the way out of it.
        const path = window.dropscribe.pathForFile(file);
        if (path.length === 0) {
          unreadable.push(file.name);
          continue;
        }

        // Authorization is synchronous by design: main records the path as one
        // the renderer is allowed to name, and it has to happen before anything
        // else touches it. A rejection here means main could not read it.
        if (!window.dropscribe.authorizePath(path)) {
          unreadable.push(file.name);
          continue;
        }

        accepted.push(path);
      }

      setReport({ accepted: accepted.length, notMedia, unreadable });
      if (accepted.length > 0) {
        void addFiles(accepted);
      }
    },
    [addFiles],
  );

  /**
   * The reliable affordance.
   *
   * Drag-and-drop is the app's name and its whole idea, and it is also the part
   * that can be taken away by things outside this window: Electron 32 removed
   * `File.path`, a Wayland session can hand over a portal handle instead of a
   * path, a file dragged out of a browser tab has no file behind it at all.
   * `store.openFiles()` goes through the native picker, whose paths main has
   * already authorized on the way back, and it is therefore the one route that
   * cannot stop working. It is always visible for exactly that reason — never
   * hidden behind a "drag not working?" hint that only appears once the user is
   * already stuck.
   */
  const chooseFiles = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setReport(EMPTY_REPORT);
    void openFiles().finally(() => setBusy(false));
  }, [busy, openFiles]);

  const rejectedCount = report.notMedia.length + report.unreadable.length;
  const dropHandlers = {
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  };

  const notice =
    rejectedCount > 0 ? (
      <div
        role="status"
        className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-left text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
      >
        <Ban className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-0.5">
          {report.notMedia.length > 0 ? (
            <p>
              <span className="selectable font-medium">{nameList(report.notMedia)}</span>
              {report.notMedia.length === 1 ? ' is ' : ' are '}
              neither audio nor video, so there is nothing to transcribe.
            </p>
          ) : null}
          {report.unreadable.length > 0 ? (
            <p>
              DropScribe could not read{' '}
              <span className="selectable font-medium">{nameList(report.unreadable)}</span>. Use
              Choose files… instead.
            </p>
          ) : null}
          {report.accepted > 0 ? (
            <p className="text-amber-800/80 dark:text-amber-300/80">
              The other {report.accepted === 1 ? 'file' : `${report.accepted} files`} started.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setReport(EMPTY_REPORT)}
          aria-label="Dismiss"
          className="shrink-0 rounded-md p-1 text-amber-700 transition hover:bg-amber-200/60 dark:text-amber-300 dark:hover:bg-amber-400/20"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    ) : null;

  if (variant === 'bar') {
    return (
      <div className="shrink-0 space-y-2 px-5 pb-2 pt-4">
        <div
          {...dropHandlers}
          className={`flex items-center gap-3 rounded-xl border px-3.5 py-2.5 transition-all duration-200 ease-crisp ${
            dragging
              ? 'border-dashed border-brand bg-brand-subtle shadow-glow'
              : 'border-slate-200 bg-slate-50/70 shadow-panel dark:border-white/[0.07] dark:bg-white/[0.025]'
          }`}
        >
          <UploadCloud
            className={`h-[1.125rem] w-[1.125rem] shrink-0 transition-colors ${dragging ? 'text-brand' : 'text-slate-400 dark:text-slate-500'}`}
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 truncate text-[0.8125rem] text-slate-600 dark:text-slate-300">
            {dragging
              ? carrying === 1
                ? 'Release to transcribe 1 file'
                : `Release to transcribe ${carrying} files`
              : 'Drop more audio or video here'}
          </p>
          <button
            type="button"
            onClick={chooseFiles}
            disabled={busy}
            className="btn-ghost shrink-0"
          >
            <FolderOpen className="mr-1.5 inline h-4 w-4" aria-hidden="true" />
            Choose files…
          </button>
        </div>
        {notice}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
      {/*
        The border is dashed only while something is being dragged over it.

        A permanent dashed rectangle filling the window is the visual language
        of an unfinished form: it shouts "empty slot" at a user who has not asked
        for one yet. At rest this is a quiet surface with a soft ring; the dashed
        edge and the glow appear at the moment they mean something, which is also
        the moment the user needs to know the window will accept the drop.
      */}
      <div
        {...dropHandlers}
        className={`group relative flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-hidden rounded-2xl border p-8 text-center transition-all duration-200 ease-crisp ${
          dragging
            ? 'border-dashed border-brand bg-brand-subtle shadow-glow-lg dark:bg-brand-subtle'
            : 'border-slate-200 bg-slate-50/70 shadow-panel dark:border-white/[0.07] dark:bg-white/[0.015]'
        }`}
      >
        {/* A pool of light behind the icon, so the centre of an otherwise empty
            surface has somewhere for the eye to rest. */}
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute left-1/2 top-1/2 h-[26rem] w-[26rem] -translate-x-1/2 -translate-y-[58%] rounded-full blur-3xl transition-opacity duration-300 ${
            dragging ? 'bg-brand/20 opacity-100' : 'bg-brand/[0.07] opacity-70 dark:bg-brand/[0.09]'
          }`}
        />
        <div className="relative">
          {dragging ? (
            <span
              aria-hidden="true"
              className="absolute inset-0 -m-3 animate-pulse-ring rounded-2xl bg-brand/20"
            />
          ) : null}
          <span
            className={`relative flex h-20 w-20 items-center justify-center rounded-2xl border transition-all duration-200 ease-crisp ${
              dragging
                ? 'scale-105 border-brand/40 bg-brand/15'
                : 'border-slate-200 bg-white shadow-panel dark:border-white/[0.08] dark:bg-white/[0.04]'
            }`}
          >
            <UploadCloud
              className={`h-9 w-9 transition-colors ${dragging ? 'text-brand' : 'text-slate-400 dark:text-slate-500'}`}
              aria-hidden="true"
            />
          </span>
        </div>
        <div className="relative space-y-2">
          <p className="text-[1.375rem] font-semibold tracking-[-0.02em] text-slate-900 dark:text-white">
            {dragging ? 'Release to transcribe' : 'Drop audio or video here'}
          </p>
          <p className="mx-auto max-w-sm text-[0.8125rem] leading-relaxed text-slate-500 dark:text-slate-400">
            {dragging
              ? carrying === 1
                ? '1 file ready'
                : `${carrying} files ready`
              : 'Anything ffmpeg can open, whole video files included. Nothing is uploaded unless you pick a cloud provider.'}
          </p>
        </div>
        <button
          type="button"
          onClick={chooseFiles}
          disabled={busy}
          className="btn-primary relative"
        >
          <FolderOpen className="mr-1.5 inline h-4 w-4" aria-hidden="true" />
          Choose files…
        </button>

        {!hasTarget ? (
          // Said before the first drop rather than after it. The store does
          // catch this case — it refuses the files and opens settings — but
          // "you cannot do the thing yet" is much better news on the way in
          // than as a rejection of something you have already done.
          <p className="flex flex-wrap items-center justify-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            Nothing can transcribe yet.
            <button
              type="button"
              onClick={() => openSettings('models')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <SettingsIcon className="h-3.5 w-3.5" aria-hidden="true" />
              Download a model or add a key
            </button>
          </p>
        ) : null}
      </div>
      {notice}
    </div>
  );
}
