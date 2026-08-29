/**
 * Settings, as a modal over the queue rather than a second window.
 *
 * A separate BrowserWindow was the first plan and it is worse in every way that
 * matters here: a second window needs its own preload, its own store instance
 * subscribed to the same IPC events, and its own answer to "what happens when
 * the user closes the main window while this is open". A modal shares all of
 * that with the shell for free, and the only thing it costs is that settings
 * cannot sit beside the queue — which, for a panel the user visits to download
 * a model and then leaves, is not a cost.
 *
 * Every prop is optional. The component drives itself from the store, so the
 * shell can render `<SettingsModal />` and never think about it again; the
 * props exist so a caller that wants to own the open state can.
 */

import { useCallback, useEffect, useRef } from 'react';
import { FileText, Info, KeyRound, Package, X } from 'lucide-react';

import type { SettingsTab } from './store';
import { SETTINGS_TABS, useStore } from './store';
import AboutTab from './settings/AboutTab';
import ModelsTab from './settings/ModelsTab';
import OutputTab from './settings/OutputTab';
import ProvidersTab from './settings/ProvidersTab';

export interface SettingsModalProps {
  /** Overrides the store's `settingsOpen`. */
  open?: boolean;
  /** Overrides the store's `settingsTab`. */
  tab?: SettingsTab;
  onTabChange?: (tab: SettingsTab) => void;
  onClose?: () => void;
}

const TAB_META: Readonly<Record<SettingsTab, { label: string; Icon: typeof Package }>> = {
  models: { label: 'Models', Icon: Package },
  providers: { label: 'Providers', Icon: KeyRound },
  output: { label: 'Files', Icon: FileText },
  about: { label: 'About', Icon: Info },
};

export function SettingsModal({ open: openProp, tab: tabProp, onTabChange, onClose }: SettingsModalProps = {}): JSX.Element | null {
  const storeOpen = useStore((s) => s.settingsOpen);
  const storeTab = useStore((s) => s.settingsTab);
  const setSettingsTab = useStore((s) => s.setSettingsTab);
  const closeSettings = useStore((s) => s.closeSettings);

  const open = openProp ?? storeOpen;
  const tab = tabProp ?? storeTab;

  const panelRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);

  // Destructured rather than read off a `props` object, because a default of
  // `{}` is a fresh object on every render and would make these callbacks —
  // and therefore the Escape listener that depends on them — churn every frame.
  const close = useCallback((): void => {
    if (onClose !== undefined) onClose();
    else closeSettings();
  }, [onClose, closeSettings]);

  const selectTab = useCallback((next: SettingsTab): void => {
    if (onTabChange !== undefined) onTabChange(next);
    else setSettingsTab(next);
  }, [onTabChange, setSettingsTab]);

  useEffect(() => {
    if (!open) return;
    // Escape is listened for on the document rather than on the panel: the
    // panel only has focus until the user clicks inside an input, and a modal
    // that stops answering Escape once you have typed something is a trap.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
    };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();
    return () => { document.removeEventListener('keydown', onKeyDown); };
  }, [open, close]);

  if (!open) return null;

  /** Arrow keys move between tabs, which is what a `tablist` promises. */
  function onTabKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = SETTINGS_TABS.indexOf(tab);
    const next = SETTINGS_TABS[(index + delta + SETTINGS_TABS.length) % SETTINGS_TABS.length];
    if (next === undefined) return;
    selectTab(next);
    // The newly selected tab has to take focus or the roving tabindex leaves
    // the keyboard user on a button that is no longer selected.
    const buttons = tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[SETTINGS_TABS.indexOf(next)]?.focus();
  }

  return (
    /*
      The backdrop dims and blurs the window rather than blanking it. A flat
      opaque scrim turns the app behind into a grey rectangle and the modal
      stops reading as *above* something; a 60% ink wash plus a small blur keeps
      the queue legible as depth, which is the whole reason settings is a modal
      and not a second window.
    */
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm dark:bg-ink-950/60"
      // The backdrop closes on click, but only when the click started AND ended
      // on it. Without the target check, a drag that begins inside a text field
      // and releases over the backdrop dismisses the panel and loses the edit.
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        className="flex h-[min(88vh,44rem)] w-full max-w-3xl animate-fade-up flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-modal focus:outline-none dark:border-white/[0.07] dark:bg-ink-900"
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 px-5 py-3.5 dark:border-white/[0.06]">
          <h2 id="settings-title" className="text-base font-semibold tracking-[-0.01em] text-slate-900 dark:text-white">Settings</h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close settings"
            className="btn-icon"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </header>

        {/*
          A segmented control, not an underline.

          Four sections that swap the whole body are a mode switch, and a mode
          switch reads best as one physical object with one raised cell: the
          track says "these four are the same kind of thing", the lifted pill
          says "you are in this one". An underline row would have to draw a
          second horizontal rule directly under the header's, which is two lines
          of chrome saying the same thing.
        */}
        <div className="shrink-0 border-b border-slate-200 px-5 py-3 dark:border-white/[0.06]">
          <div
            ref={tabsRef}
            role="tablist"
            aria-label="Settings sections"
            onKeyDown={onTabKeyDown}
            className="inline-flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-white/[0.04]"
          >
            {SETTINGS_TABS.map((id) => {
              const meta = TAB_META[id];
              const selected = id === tab;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`settings-tab-${id}`}
                  aria-selected={selected}
                  aria-controls={`settings-panel-${id}`}
                  // Roving tabindex: one Tab press reaches the tab strip, arrows
                  // move within it. Every tab being tabbable would put four stops
                  // between the close button and the panel's first field.
                  tabIndex={selected ? 0 : -1}
                  onClick={() => { selectTab(id); }}
                  className={
                    'inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-medium transition duration-150 ease-crisp ' +
                    (selected
                      ? 'bg-white text-slate-900 shadow-panel dark:bg-ink-750 dark:text-white'
                      : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200')
                  }
                >
                  <meta.Icon aria-hidden className="h-4 w-4" />
                  {meta.label}
                </button>
              );
            })}
          </div>
        </div>

        {/*
          The body is the only thing that scrolls. `min-h-0` is what makes that
          true: without it a flex child refuses to shrink below its content, the
          panel grows past its own `h-[min(88vh,44rem)]`, and the header and tab
          strip scroll away with the content they are supposed to stay above.
        */}
        <div
          role="tabpanel"
          id={`settings-panel-${tab}`}
          aria-labelledby={`settings-tab-${tab}`}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
        >
          {tab === 'models' ? <ModelsTab /> : null}
          {tab === 'providers' ? <ProvidersTab /> : null}
          {tab === 'output' ? <OutputTab /> : null}
          {tab === 'about' ? <AboutTab /> : null}
        </div>
      </div>
    </div>
  );
}

export default SettingsModal;
