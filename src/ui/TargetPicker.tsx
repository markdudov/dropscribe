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
import { Check, ChevronDown, Cloud, Cpu } from 'lucide-react';

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
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Transcribe with ${currentLabel}`}
        className="flex max-w-[19rem] items-center gap-2 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:bg-slate-800"
      >
        {target?.kind === 'cloud' ? (
          <Cloud className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
        ) : (
          <Cpu className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
        )}
        <span className="truncate">{currentLabel}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="Transcribe with"
          className="absolute right-0 z-30 mt-1.5 max-h-[26rem] w-[24rem] overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl shadow-slate-900/10 dark:border-slate-700 dark:bg-slate-900 dark:shadow-black/40"
        >
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
                    className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition enabled:hover:bg-brand-subtle disabled:cursor-not-allowed disabled:opacity-55"
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

          {!anyChoice ? (
            // The honest empty state. A picker with six greyed-out rows and no
            // way forward is a dead end; this is the way out of it.
            <div className="border-t border-slate-200 px-2 py-3 dark:border-slate-700">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Nothing is ready yet. Download a local model, or add a provider key.
              </p>
              <button
                type="button"
                onClick={() => {
                  close();
                  openSettings('models');
                }}
                className="mt-2 rounded-lg bg-brand px-2.5 py-1.5 text-sm font-medium text-white transition hover:bg-brand-hover"
              >
                Open settings
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
