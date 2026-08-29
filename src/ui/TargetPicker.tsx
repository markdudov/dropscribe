/**
 * The one control that answers "what will this run through?".
 *
 * It is a custom popover rather than a `<select>` with `<optgroup>`s, which
 * would have been fewer lines. Two things made that trade a bad one. A native
 * `<option>` cannot carry a second line, and "Whisper large-v3 (quantized)"
 * without "1.0 GB, not downloaded" beside it is not a choice anyone can make.
 * And on Windows a native dropdown is rendered by the OS outside the web
 * contents, so it ignores the app's dark theme entirely — the picker would be a
 * white rectangle in the middle of a dark window.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Check, ChevronDown, Cloud, Cpu, Settings2 } from 'lucide-react';

import type { ProviderState } from '../../electron/api-types';
import type { TranscribeTarget } from '../../electron/shared/jobs';
import { targetLabel } from '../../electron/shared/jobs';
import { findLocalModel, formatBytes } from '../../electron/shared/models';
import { findProvider } from '../../electron/shared/providers';
import { useStore } from './store';

/**
 * The human name of a target, resolved against what this machine knows.
 *
 * Exported because `JobRow` needs exactly the same string, and a job carries
 * only ids. Two call sites formatting a target independently is how "Whisper
 * large-v3-turbo (local)" in the picker becomes "whisper-large-v3-turbo" in the
 * row, which looks like a bug even though both are technically correct.
 */
export function describeTarget(
  target: TranscribeTarget,
  providers: readonly ProviderState[],
): string {
  if (target.kind === 'local') {
    // The catalogue is compiled in, so a local model always has a label even
    // when it is not installed — which matters, because a job can outlive the
    // model file it was queued against.
    return targetLabel(target, findLocalModel(target.modelId)?.label ?? target.modelId);
  }

  const provider = providers.find((p) => p.id === target.providerId);
  const model = provider?.models.find((m) => m.id === target.modelId);
  return targetLabel(
    target,
    model?.label ?? target.modelId,
    findProvider(target.providerId)?.label,
  );
}

function sameTarget(a: TranscribeTarget | null, b: TranscribeTarget): boolean {
  if (a === null || a.kind !== b.kind) return false;
  if (a.kind === 'local' || b.kind === 'local') return a.modelId === b.modelId;
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

interface Choice {
  key: string;
  target: TranscribeTarget;
  label: string;
  detail: string;
  /** Present when the row cannot be picked; shown in place of the detail. */
  blocker?: string;
}

interface Group {
  key: string;
  heading: string;
  icon: 'local' | 'cloud';
  choices: Choice[];
}

export function TargetPicker(): ReactElement {
  const models = useStore((s) => s.models);
  const providers = useStore((s) => s.providers);
  const target = useStore((s) => s.target);
  const setTarget = useStore((s) => s.setTarget);
  const openSettings = useStore((s) => s.openSettings);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const groups = useMemo<Group[]>(() => {
    const local: Group = {
      key: 'local',
      heading: 'On this computer',
      icon: 'local',
      // Not-installed models are listed rather than hidden. Hiding them makes
      // the picker look empty on a fresh install and gives the user nothing to
      // react to; showing them disabled is what tells them the app can do this
      // offline at all, and where to go next.
      choices: models.map((model) => ({
        key: `local:${model.id}`,
        target: { kind: 'local', modelId: model.id },
        label: model.label,
        detail: model.blurb,
        ...(model.installed
          ? {}
          : {
              blocker: model.downloading
                ? `Downloading… ${model.downloadPercent ?? 0}%`
                : `Download first · ${formatBytes(model.bytes)}`,
            }),
      })),
    };

    const cloud = providers.flatMap<Group>((provider) => {
      // A provider earns a group only once it can actually run something: a key
      // that passed its test, and a model chosen for it. Anything less would be
      // a row that fails the instant it is picked, and the place to fix it is
      // settings, not here.
      const selectedModelId = provider.selectedModelId;
      if (!provider.hasKey || provider.lastTest?.ok !== true || selectedModelId === undefined) {
        return [];
      }
      const descriptor = findProvider(provider.id);
      const model = provider.models.find((m) => m.id === selectedModelId);
      return [
        {
          key: `cloud:${provider.id}`,
          heading: descriptor?.label ?? provider.id,
          icon: 'cloud',
          choices: [
            {
              key: `cloud:${provider.id}:${selectedModelId}`,
              target: { kind: 'cloud', providerId: provider.id, modelId: selectedModelId },
              label: model?.label ?? selectedModelId,
              detail: model?.description ?? 'Audio is uploaded to this provider.',
            },
          ],
        },
      ];
    });

    return [local, ...cloud];
  }, [models, providers]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const node = rootRef.current;
      if (node !== null && event.target instanceof Node && !node.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    // `pointerdown`, not `click`: closing on click would let the very click that
    // dismisses the menu also activate whatever was behind it.
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  const currentLabel = target === null ? 'Pick a model' : describeTarget(target, providers);
  const anyChoice = groups.some((group) => group.choices.some((c) => c.blocker === undefined));

  return (
    <div className="relative" ref={rootRef}>
      {/*
        Header chrome, not a form field. It is the same material and the same
        height as the gear beside it — `.btn-ghost` — so the two read as one
        toolbar rather than as a control dropped into a title bar. While the
        popover is open the trigger holds its hover state, because a menu whose
        button has gone quiet looks detached from it.
      */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Transcribe with ${currentLabel}`}
        className={`btn-ghost flex max-w-[19rem] items-center gap-2 ${
          open ? 'border-slate-400 bg-slate-50 dark:border-white/20 dark:bg-white/[0.08]' : ''
        }`}
      >
        {target?.kind === 'cloud' ? (
          <Cloud className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
        ) : (
          <Cpu className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
        )}
        <span className="truncate">{currentLabel}</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-150 ease-crisp dark:text-slate-500 ${
            open ? 'rotate-180' : ''
          }`}
          aria-hidden="true"
        />
      </button>

      {open ? (
        /*
          A panel above the window, not a rectangle painted on it: the raised
          ink step plus `shadow-modal` is what separates it from the header it
          overlaps, and the 4px rise gives the eye somewhere to follow.
        */
        <div
          role="listbox"
          aria-label="Transcribe with"
          /*
            A column, not a scrolling box.

            The whole panel used to scroll, which meant the empty-state footer —
            the only way out of a picker where nothing is installed — scrolled
            with the list and was clipped by the panel's own max height. The list
            is now the only thing that scrolls; the footer is pinned under it and
            is always whole.

            `overflow-hidden` on the panel is what makes the rounded corners clip
            the scrolling child, and `min-h-0` on that child is what lets it
            shrink inside a flex column instead of forcing the panel taller than
            its max.
          */
          className="popover-anchor animate-fade-up absolute z-30 mt-2 flex max-h-[32rem] w-[24rem] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-modal dark:border-white/[0.07] dark:bg-ink-850"
        >
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {groups.map((group) => (
            <div key={group.key} role="group" aria-labelledby={`target-group-${group.key}`}>
              <p
                id={`target-group-${group.key}`}
                className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
              >
                {group.icon === 'cloud' ? (
                  <Cloud className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {group.heading}
              </p>
              {group.choices.map((choice) => {
                const selected = sameTarget(target, choice.target);
                const disabled = choice.blocker !== undefined;
                return (
                  <button
                    key={choice.key}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={disabled}
                    onClick={() => {
                      setTarget(choice.target);
                      close();
                    }}
                    /*
                      The selected row is a brand wash rather than a filled bar.
                      A heavy background in a list of two-line rows reads as a
                      focus ring that has got stuck; a 12% tint says "this one"
                      and still lets the hover state be visible on top of it.
                    */
                    className={`flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left transition duration-150 ease-crisp disabled:cursor-not-allowed disabled:opacity-55 ${
                      selected
                        ? 'bg-brand-subtle'
                        : 'enabled:hover:bg-slate-100 dark:enabled:hover:bg-white/[0.06]'
                    }`}
                  >
                    <Check
                      className={`mt-0.5 h-4 w-4 shrink-0 text-brand ${selected ? '' : 'invisible'}`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                        {choice.label}
                      </span>
                      <span
                        className={`block text-xs ${
                          disabled
                            ? 'font-medium text-amber-600 dark:text-amber-400'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {choice.blocker ?? choice.detail}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          </div>

          {!anyChoice ? (
            // The honest empty state. A picker with six greyed-out rows and no
            // way forward is a dead end; this is the way out of it.
            <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-3.5 py-3.5 dark:border-white/[0.06] dark:bg-white/[0.03]">
              <p className="text-[0.8125rem] leading-relaxed text-slate-600 dark:text-slate-300">
                Nothing is ready yet. Download a local model, or add a provider key.
              </p>
              {/*
                Full width and centred, because it is the only action in the
                panel and a button that shares a row with nothing should not look
                as though it does. The tinted strip behind it separates the way
                out from the list of things that are not yet choices.
              */}
              <button
                type="button"
                onClick={() => {
                  close();
                  openSettings('models');
                }}
                /*
                  The quiet primary, not the glowing one. This button sits inside
                  a panel that already carries `shadow-modal`, and a halo on top
                  of that is shadow over shadow — it makes the button look like
                  it is floating off the surface it belongs to. The flat brand
                  fill is the more confident answer at full width.
                */
                className="btn-primary-quiet mt-3 flex w-full items-center justify-center gap-2"
              >
                <Settings2 className="h-4 w-4" aria-hidden="true" />
                Open settings
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
