/**
 * Bring your own key.
 *
 * The shape of this panel is an argument about trust. A key is the one thing
 * the user hands this app that costs them money if it is wrong, so nothing here
 * stores one on the strength of it merely having been typed: **Test connection
 * runs first, against the provider's own API, and the Save button does not
 * exist until that test has come back green.** `testProviderKey` on the main
 * side deliberately does not persist, which is what makes that promise real
 * rather than a claim in the UI.
 *
 * The other half of the same argument is what this component never sees. A
 * stored key is never sent back to the renderer — only `keyPreview`, its last
 * four characters — so there is no state in this file that a compromised
 * renderer could read a key out of, and the field goes empty the moment a key
 * is saved.
 */

import { useState } from 'react';
import {
  Check,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';

import type { ProviderState } from '../../../electron/api-types';
import type { ProviderId, KeyTestResult, ProviderDescriptor, ProviderModel } from '../../../electron/shared/providers';
import { PROVIDERS } from '../../../electron/shared/providers';
import { useStore } from '../store';

/**
 * Where a provider card is in the test-then-store dance.
 *
 * A discriminated union rather than three booleans, because the states are
 * genuinely exclusive and `testing && passed` should not be expressible — that
 * pair is exactly how a spinner ends up sitting next to a green tick.
 */
type Phase =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'passed'; result: KeyTestResult }
  | { kind: 'failed'; result: KeyTestResult };

/* One treatment for every field in settings, so a key input and a language
   picker are visibly the same kind of thing. The focus ring is the app's, from
   `index.css`; nothing here redeclares it. */
const FIELD =
  'w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 ' +
  'transition duration-150 ease-crisp focus:border-brand ' +
  'dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100 dark:placeholder:text-slate-500';

const GHOST = 'btn-ghost inline-flex items-center gap-2';
/*
  Quiet, not glowing. Four provider cards are on screen at once and each has its
  own primary action; four haloes read as four alarms. See `.btn-primary-quiet`.
*/
const PRIMARY = 'btn-primary-quiet inline-flex items-center gap-2';
const DANGER =
  'btn-ghost inline-flex items-center gap-2 text-red-600 hover:text-red-700 ' +
  'dark:text-red-400 dark:hover:text-red-300';

const PILL = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium';

/** A price the vendor quotes by the hour reads wrong scaled to the minute, and vice versa. */
function priceLabel(model: ProviderModel, unit: ProviderDescriptor['priceUnit']): string | null {
  const perMinute = model.pricePerMinuteUsd;
  if (perMinute === undefined) return null;
  if (unit === 'per-hour') return `$${(perMinute * 60).toFixed(2)} per hour of audio`;
  // Four decimals, not two: these prices are fractions of a cent and $0.01 for
  // every model in the list tells the user nothing about which is cheaper.
  return `$${perMinute.toFixed(4)} per minute of audio`;
}

function languageLabel(model: ProviderModel): string {
  const languages = model.languages;
  if (languages === undefined || languages === null) return 'Any language';
  if (languages.length === 1) return '1 language';
  return `${languages.length} languages`;
}

/**
 * A real model id from each provider, shown as the placeholder for the
 * type-it-yourself field.
 *
 * These are taken from the adapters, not invented: a placeholder that shows a
 * plausible-but-wrong shape is worse than none, because the user copies its
 * punctuation. DeepInfra and OpenRouter both namespace with a slash; Deepgram
 * wants the `canonical_name`, which is why `nova-3-general` appears here rather
 * than the `nova-3` alias; ElevenLabs uses a bare id.
 */
const CUSTOM_PLACEHOLDERS: Record<ProviderId, string> = {
  deepinfra: 'openai/whisper-large-v3-turbo',
  deepgram: 'nova-3-general',
  elevenlabs: 'scribe_v2',
  openrouter: 'openai/gpt-4o-transcribe',
};

function customPlaceholder(id: ProviderId): string {
  return CUSTOM_PLACEHOLDERS[id];
}

function ProviderCard({ descriptor, state }: { descriptor: ProviderDescriptor; state: ProviderState }): JSX.Element {
  const testProviderKey = useStore((s) => s.testProviderKey);
  const saveProviderKey = useStore((s) => s.saveProviderKey);
  const clearProviderKey = useStore((s) => s.clearProviderKey);
  const refreshProviderModels = useStore((s) => s.refreshProviderModels);
  const selectProviderModel = useStore((s) => s.selectProviderModel);
  const openExternal = useStore((s) => s.openExternal);

  const [key, setKey] = useState('');
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  /** Models for the key in the field, which is not yet the stored key. */
  const [pending, setPending] = useState<ProviderModel[] | null>(null);
  /**
   * The model id typed by hand. Seeded from the stored selection so the field
   * shows what is actually in use rather than starting blank next to a caption
   * claiming a custom model is set.
   */
  const [customModel, setCustomModel] = useState(state.selectedModelId ?? '');

  const fieldId = `provider-key-${descriptor.id}`;

  /**
   * The models the picker is showing right now — the ones just fetched for the
   * key in the field, or the stored ones.
   *
   * Needed here as well as in the list so `usingCustomModel` can ask whether
   * the current selection is absent from it.
   */
  const shownModels: readonly ProviderModel[] = pending ?? state.models;
  const usingCustomModel =
    state.selectedModelId !== undefined &&
    state.selectedModelId.length > 0 &&
    !shownModels.some((model) => model.id === state.selectedModelId);

  const applyCustomModel = (): void => {
    const trimmed = customModel.trim();
    if (trimmed.length === 0) return;
    void selectProviderModel(descriptor.id, trimmed);
  };

  const typed = key.trim();
  const stored = state.hasKey;

  // A previously stored key that passed carries its verdict across relaunches,
  // so the picker is not hidden from a user who set this up last week.
  //
  // But the persisted verdict is only shown while the field is EMPTY. The
  // moment there are characters in it, the stored key's green tick would be
  // read as a verdict on what was just typed — which is the one lie this panel
  // must not tell, and the reason both of these fall back to nothing as soon as
  // `typed` is non-empty.
  const untouched = typed.length === 0;
  const storedPassed = stored && untouched && state.lastTest?.ok === true;
  const verdict: KeyTestResult | null =
    phase.kind === 'passed' || phase.kind === 'failed'
      ? phase.result
      : untouched
        ? (state.lastTest ?? null)
        : null;
  const passed = phase.kind === 'passed' || (phase.kind === 'idle' && storedPassed);

  const models: ProviderModel[] = pending ?? state.models;

  /*
    Which of the two buttons on the key row carries the weight.

    Before there is a key, Test connection is the only thing worth doing on the
    card, so it is the primary. The instant the test passes, Save is the action
    and Test has already done its job — two glowing buttons side by side would
    make the user pick between them.
  */
  const saveVisible = phase.kind === 'passed' && typed.length > 0;
  const testIsPrimary = !stored && !saveVisible;

  async function onTest(): Promise<void> {
    if (typed.length === 0) return;
    setPhase({ kind: 'testing' });
    setPending(null);
    try {
      const result = await testProviderKey(descriptor.id, typed);
      setPhase({ kind: result.ok ? 'passed' : 'failed', result });
      // Most providers answer both questions in one round trip, which is what
      // lets the picker populate the instant the key checks out.
      if (result.ok && result.models !== undefined && result.models.length > 0) setPending(result.models);
    } catch (error) {
      setPhase({
        kind: 'failed',
        result: { ok: false, message: error instanceof Error ? error.message : 'The key could not be checked.' },
      });
    }
  }

  async function onSave(): Promise<void> {
    if (typed.length === 0) return;
    setSaving(true);
    try {
      const result = await saveProviderKey(descriptor.id, typed);
      setPhase({ kind: result.ok ? 'passed' : 'failed', result });
      // Cleared on success only. Leaving a rejected key in the field lets the
      // user fix a typo instead of pasting the whole thing again.
      if (result.ok) {
        setKey('');
        setVisible(false);
        setPending(null);
      }
    } catch (error) {
      setPhase({
        kind: 'failed',
        result: { ok: false, message: error instanceof Error ? error.message : 'The key could not be saved.' },
      });
    } finally {
      setSaving(false);
    }
  }

  async function onRefresh(): Promise<void> {
    setLoadingModels(true);
    try {
      await refreshProviderModels(descriptor.id);
      setPending(null);
    } catch (error) {
      setPhase({
        kind: 'failed',
        result: { ok: false, message: error instanceof Error ? error.message : 'The models could not be listed.' },
      });
    } finally {
      setLoadingModels(false);
    }
  }

  return (
    <section className="surface p-4" aria-labelledby={`provider-${descriptor.id}-heading`}>
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3
            id={`provider-${descriptor.id}-heading`}
            className="flex flex-wrap items-center gap-2 text-sm font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-100"
          >
            {descriptor.label}
            {/*
              Three states, three meanings, and the palette says so: grey is the
              absence of a key, green is a key this app has watched work, red is
              one the provider itself refused. Nothing else on this tab is
              allowed either colour.
            */}
            {!stored ? (
              <span className={`${PILL} bg-slate-100 text-slate-600 dark:bg-white/[0.06] dark:text-slate-400`}>
                No key
              </span>
            ) : state.lastTest?.ok === false ? (
              <span className={`${PILL} bg-red-500/10 text-red-700 dark:text-red-400`}>
                <XCircle aria-hidden className="h-3 w-3" />
                Key rejected
              </span>
            ) : (
              <span className={`${PILL} bg-emerald-500/10 text-emerald-700 dark:text-emerald-400`}>
                <ShieldCheck aria-hidden className="h-3 w-3" />
                Connected
              </span>
            )}
          </h3>
          <p className="mt-1 max-w-prose text-[0.8125rem] leading-relaxed text-slate-600 dark:text-slate-400">
            {descriptor.blurb}
          </p>
        </div>
        {/* `whitespace-nowrap` is not cosmetic here: "Get a key" is three short
            words and the flex row will happily break it across two lines when
            the provider's blurb is long, which is what OpenRouter's does. */}
        <button
          type="button"
          className={`${GHOST} shrink-0 whitespace-nowrap`}
          onClick={() => { void openExternal(`provider-key:${descriptor.id}`); }}
        >
          <ExternalLink aria-hidden className="h-4 w-4" />
          Get a key
        </button>
      </header>

      {/* ── The key field ─────────────────────────────────────────────── */}
      <div className="mt-4">
        <label htmlFor={fieldId} className="block text-sm font-medium text-slate-800 dark:text-slate-200">
          API key
        </label>
        <p className="mt-0.5 text-[0.75rem] text-slate-500 dark:text-slate-400">
          Kept in the system credential store, never in a settings file.
        </p>
        <div className="mt-2 flex gap-2">
          <div className="relative flex-1">
            <input
              id={fieldId}
              // Password even though this is not a password: the value must not
              // land in a screen share, a screenshot or a bug report, and the
              // browser's own "reveal" affordance is the one users already know.
              type={visible ? 'text' : 'password'}
              value={key}
              onChange={(event) => {
                setKey(event.target.value);
                // Any edit invalidates the previous verdict. Leaving a green
                // tick beside a changed key is the one lie this panel must not
                // tell.
                setPhase({ kind: 'idle' });
                setPending(null);
              }}
              placeholder={descriptor.keyPlaceholder}
              autoComplete="off"
              spellCheck={false}
              className={`${FIELD} pr-10 font-mono`}
              aria-describedby={`${fieldId}-hint`}
            />
            <button
              type="button"
              onClick={() => { setVisible((v) => !v); }}
              className="absolute inset-y-0 right-0 flex items-center rounded-r-xl px-3 text-slate-500 transition duration-150 ease-crisp hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
              aria-label={visible ? 'Hide the key' : 'Show the key'}
              aria-pressed={visible}
            >
              {visible ? <EyeOff aria-hidden className="h-4 w-4" /> : <Eye aria-hidden className="h-4 w-4" />}
            </button>
          </div>

          <button
            type="button"
            className={`${testIsPrimary ? PRIMARY : GHOST} shrink-0`}
            onClick={() => { void onTest(); }}
            disabled={typed.length === 0 || phase.kind === 'testing'}
          >
            {phase.kind === 'testing'
              ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              : <KeyRound aria-hidden className="h-4 w-4" />}
            {phase.kind === 'testing' ? 'Testing…' : 'Test connection'}
          </button>

          {/* The save button is gated on the test, not merely encouraged by it. */}
          {saveVisible ? (
            <button type="button" className={`${PRIMARY} shrink-0`} onClick={() => { void onSave(); }} disabled={saving}>
              {saving ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <ShieldCheck aria-hidden className="h-4 w-4" />}
              Save the key
            </button>
          ) : null}
        </div>
        <p id={`${fieldId}-hint`} className="mt-2 text-[0.75rem] text-slate-500 dark:text-slate-400">
          The key is checked against {descriptor.label} before it is stored. Nothing is saved by a failed test.
        </p>
      </div>

      {/* ── The verdict ───────────────────────────────────────────────── */}
      <div aria-live="polite" className="mt-3 empty:mt-0">
        {phase.kind === 'testing' ? (
          <p className="flex items-center gap-2 text-[0.8125rem] text-slate-600 dark:text-slate-300">
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            Testing…
          </p>
        ) : verdict !== null ? (
          /*
            A bordered strip rather than a bare tinted block: on the dark ground
            a fill alone floats, and the border is what makes the result read as
            a thing the card is holding rather than a stain on it.
          */
          <div
            className={
              'flex animate-fade-up items-start gap-2 rounded-xl border p-3 text-[0.8125rem] ' +
              (verdict.ok
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-500/[0.08] dark:text-emerald-200'
                : 'border-red-300 bg-red-50 text-red-900 dark:border-red-500/25 dark:bg-red-500/[0.08] dark:text-red-200')
            }
          >
            {verdict.ok
              ? <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              : <XCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />}
            <span className="min-w-0">
              {verdict.ok ? (
                <strong className="font-semibold">
                  {verdict.account !== undefined ? `Connected as ${verdict.account}` : 'The key works'}
                </strong>
              ) : (
                <strong className="font-semibold">The key did not work</strong>
              )}
              {/* Shown verbatim. The adapters guarantee this string carries no
                  key, no URL and no stack trace, so there is nothing to strip. */}
              <span className="selectable block opacity-90">{verdict.message}</span>
            </span>
          </div>
        ) : null}
      </div>

      {/* ── The stored key ────────────────────────────────────────────── */}
      {stored ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 dark:border-white/[0.07] dark:bg-white/[0.03]">
          <p className="text-[0.8125rem] text-slate-700 dark:text-slate-300">
            Saved key, ending <span className="tnum selectable font-mono">{state.keyPreview ?? '····'}</span>
          </p>
          <button type="button" className={DANGER} onClick={() => { void clearProviderKey(descriptor.id); setPhase({ kind: 'idle' }); }}>
            <Trash2 aria-hidden className="h-4 w-4" />
            Remove the key
          </button>
        </div>
      ) : null}

      {/* ── The model picker, only once a test has passed ─────────────── */}
      {passed ? (
        /*
          Indented behind a hairline, because this is not a sixth peer control on
          the card: it exists only as a consequence of the key above it, and the
          rule is the cheapest way to say "this belongs to that".
        */
        <fieldset className="mt-4 animate-fade-up border-l border-slate-200 pl-4 dark:border-white/[0.07]">
          <div className="flex items-center justify-between gap-3">
            <legend className="text-sm font-medium text-slate-800 dark:text-slate-200">Model</legend>
            <button type="button" className={GHOST} onClick={() => { void onRefresh(); }} disabled={loadingModels || !stored}>
              {loadingModels
                ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                : <RefreshCw aria-hidden className="h-4 w-4" />}
              {loadingModels ? 'Loading the models…' : 'Refresh the list'}
            </button>
          </div>

          {models.length === 0 ? (
            <p className="mt-2 text-[0.8125rem] text-slate-500 dark:text-slate-400">
              {stored ? 'No models came back. Refresh the list.' : 'Save the key and the models appear here.'}
            </p>
          ) : (
            <div className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">
              {models.map((model) => {
                const price = priceLabel(model, descriptor.priceUnit);
                const selected = state.selectedModelId === model.id;
                return (
                  <label
                    key={model.id}
                    className={
                      'flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition duration-150 ease-crisp ' +
                      (selected
                        ? 'border-brand bg-brand-subtle'
                        : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-white/[0.07] dark:hover:border-white/20 dark:hover:bg-white/[0.04]')
                    }
                  >
                    <input
                      type="radio"
                      name={`provider-model-${descriptor.id}`}
                      value={model.id}
                      checked={selected}
                      onChange={() => { void selectProviderModel(descriptor.id, model.id); }}
                      className="mt-1 h-4 w-4 accent-brand"
                    />
                    <span className="min-w-0">
                      <span className="block font-medium text-slate-900 dark:text-slate-100">{model.label}</span>
                      {model.description !== undefined ? (
                        <span className="block text-[0.75rem] text-slate-500 dark:text-slate-400">{model.description}</span>
                      ) : null}
                      <span className="tnum mt-1 block text-[0.75rem] text-slate-500 dark:text-slate-400">
                        {languageLabel(model)}
                        {price !== null ? ` · ${price}` : ''}
                        {model.capabilities?.diarization === true ? ' · Speakers' : ''}
                        {model.capabilities?.wordTimestamps === true ? ' · Word timings' : ''}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {/* ── Any model id, typed by hand ──────────────────────────────────

              The discovered list is a convenience, not a boundary. OpenRouter
              alone routes hundreds of models and adds more weekly; DeepInfra's
              catalogue endpoint answers with whatever it answers with today.
              Whichever list this app shows will, sooner or later, be missing the
              one model somebody actually wants — and every one of these APIs
              takes the model as a plain string, so there is no technical reason
              to refuse it.

              `providers:selectModel` never validated against the fetched list,
              so this needed no change on the main side: what the user types is
              what gets sent. If it is wrong, the provider says so on the first
              job, with its own error text, which is a better teacher than a
              picker that silently omits the model.
          */}
          <div className="mt-4 border-t border-slate-200 pt-4 dark:border-white/[0.07]">
            <label
              htmlFor={`${fieldId}-custom-model`}
              className="block text-sm font-medium text-slate-800 dark:text-slate-200"
            >
              Or use a specific model
            </label>
            <p className="mt-1 text-[0.8125rem] text-slate-500 dark:text-slate-400">
              Paste any model id this provider accepts, exactly as they write it —
              {' '}
              <code className="selectable rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.75rem] text-slate-700 dark:bg-white/[0.06] dark:text-slate-300">
                {customPlaceholder(descriptor.id)}
              </code>
              . It does not have to appear in the list above.
            </p>
            <div className="mt-2 flex gap-2">
              <input
                id={`${fieldId}-custom-model`}
                type="text"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                value={customModel}
                onChange={(event) => { setCustomModel(event.target.value); }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    applyCustomModel();
                  }
                }}
                placeholder={customPlaceholder(descriptor.id)}
                className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-[0.8125rem] text-slate-900 placeholder:text-slate-400 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100 dark:placeholder:text-slate-500"
              />
              <button
                type="button"
                className={`${GHOST} shrink-0 whitespace-nowrap`}
                onClick={applyCustomModel}
                disabled={customModel.trim().length === 0 || customModel.trim() === state.selectedModelId}
              >
                Use this model
              </button>
            </div>
            {usingCustomModel ? (
              <p className="mt-2 flex items-center gap-1.5 text-[0.8125rem] text-brand">
                <Check aria-hidden className="h-3.5 w-3.5" />
                <span className="selectable font-mono">{state.selectedModelId}</span>
                <span className="text-slate-500 dark:text-slate-400">is set, and is not one of the listed models.</span>
              </p>
            ) : null}
          </div>
        </fieldset>
      ) : null}
    </section>
  );
}

export function ProvidersTab(): JSX.Element {
  const providers = useStore((s) => s.providers);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-100">
          Cloud providers
        </h2>
        <p className="mt-1 max-w-prose text-[0.8125rem] leading-relaxed text-slate-600 dark:text-slate-400">
          Your key, your account, your bill. The audio is uploaded to whichever provider you pick.
        </p>
      </div>

      <div className="space-y-3">
        {PROVIDERS.map((descriptor) => {
          // The catalogue is the authority on which providers exist; main's list
          // only says what this machine has configured. A provider main has never
          // heard of still gets a card, empty.
          const state: ProviderState =
            providers.find((entry) => entry.id === descriptor.id) ?? { id: descriptor.id, hasKey: false, models: [] };
          return <ProviderCard key={descriptor.id} descriptor={descriptor} state={state} />;
        })}
      </div>
    </div>
  );
}

export default ProvidersTab;
