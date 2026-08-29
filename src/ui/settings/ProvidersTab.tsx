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
import type { KeyTestResult, ProviderDescriptor, ProviderModel } from '../../../electron/shared/providers';
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

const FIELD =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 ' +
  'focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/40 ' +
  'dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500';

const BUTTON =
  'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ' +
  'focus:outline-none focus:ring-2 focus:ring-brand/50 disabled:cursor-not-allowed disabled:opacity-50';

const PRIMARY = `${BUTTON} bg-brand text-white hover:bg-brand-hover`;
const QUIET =
  `${BUTTON} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 ` +
  'dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';
const DANGER =
  `${BUTTON} border border-red-300 bg-white text-red-700 hover:bg-red-50 ` +
  'dark:border-red-900 dark:bg-slate-900 dark:text-red-300 dark:hover:bg-red-950';

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

  const fieldId = `provider-key-${descriptor.id}`;
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
    <section
      className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60"
      aria-labelledby={`provider-${descriptor.id}-heading`}
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <h3
            id={`provider-${descriptor.id}-heading`}
            className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100"
          >
            {descriptor.label}
            {stored ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                <ShieldCheck aria-hidden className="h-3 w-3" />
                Key saved
              </span>
            ) : (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                No key yet
              </span>
            )}
          </h3>
          <p className="mt-1 max-w-prose text-sm text-slate-600 dark:text-slate-400">{descriptor.blurb}</p>
        </div>
        <button
          type="button"
          className={QUIET}
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
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
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
              className="absolute inset-y-0 right-0 flex items-center rounded-r-lg px-3 text-slate-500 hover:text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand/50 dark:text-slate-400 dark:hover:text-slate-100"
              aria-label={visible ? 'Hide the key' : 'Show the key'}
              aria-pressed={visible}
            >
              {visible ? <EyeOff aria-hidden className="h-4 w-4" /> : <Eye aria-hidden className="h-4 w-4" />}
            </button>
          </div>

          <button type="button" className={QUIET} onClick={() => { void onTest(); }} disabled={typed.length === 0 || phase.kind === 'testing'}>
            {phase.kind === 'testing'
              ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              : <KeyRound aria-hidden className="h-4 w-4" />}
            {phase.kind === 'testing' ? 'Testing…' : 'Test connection'}
          </button>

          {/* The save button is gated on the test, not merely encouraged by it. */}
          {phase.kind === 'passed' && typed.length > 0 ? (
            <button type="button" className={PRIMARY} onClick={() => { void onSave(); }} disabled={saving}>
              {saving ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <ShieldCheck aria-hidden className="h-4 w-4" />}
              Save the key
            </button>
          ) : null}
        </div>
        <p id={`${fieldId}-hint`} className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          The key is checked against {descriptor.label} before it is stored. Nothing is saved by a failed test.
        </p>
      </div>

      {/* ── The verdict ───────────────────────────────────────────────── */}
      <div aria-live="polite" className="mt-3">
        {phase.kind === 'testing' ? (
          <p className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            Testing…
          </p>
        ) : verdict !== null ? (
          <div
            className={
              verdict.ok
                ? 'flex items-start gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200'
                : 'flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-900 dark:bg-red-950/50 dark:text-red-200'
            }
          >
            {verdict.ok
              ? <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              : <XCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />}
            <span>
              {verdict.ok ? (
                <strong className="font-semibold">
                  {verdict.account !== undefined ? `Connected as ${verdict.account}` : 'The key works'}
                </strong>
              ) : (
                <strong className="font-semibold">The key did not work</strong>
              )}
              {/* Shown verbatim. The adapters guarantee this string carries no
                  key, no URL and no stack trace, so there is nothing to strip. */}
              <span className="block opacity-90">{verdict.message}</span>
            </span>
          </div>
        ) : null}
      </div>

      {/* ── The stored key ────────────────────────────────────────────── */}
      {stored ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
          <p className="text-sm text-slate-700 dark:text-slate-300">
            Saved key, ending <span className="font-mono">{state.keyPreview ?? '····'}</span>
          </p>
          <button type="button" className={DANGER} onClick={() => { void clearProviderKey(descriptor.id); setPhase({ kind: 'idle' }); }}>
            <Trash2 aria-hidden className="h-4 w-4" />
            Remove the key
          </button>
        </div>
      ) : null}

      {/* ── The model picker, only once a test has passed ─────────────── */}
      {passed ? (
        <fieldset className="mt-4">
          <div className="flex items-center justify-between gap-3">
            <legend className="text-sm font-medium text-slate-800 dark:text-slate-200">Model</legend>
            <button type="button" className={QUIET} onClick={() => { void onRefresh(); }} disabled={loadingModels || !stored}>
              {loadingModels
                ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                : <RefreshCw aria-hidden className="h-4 w-4" />}
              {loadingModels ? 'Loading the models…' : 'Refresh the list'}
            </button>
          </div>

          {models.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              {stored ? 'No models came back. Refresh the list.' : 'Save the key and the models appear here.'}
            </p>
          ) : (
            <div className="mt-2 max-h-64 space-y-1 overflow-y-auto pr-1">
              {models.map((model) => {
                const price = priceLabel(model, descriptor.priceUnit);
                const selected = state.selectedModelId === model.id;
                return (
                  <label
                    key={model.id}
                    className={
                      'flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors ' +
                      (selected
                        ? 'border-brand bg-brand-subtle'
                        : 'border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50')
                    }
                  >
                    <input
                      type="radio"
                      name={`provider-model-${descriptor.id}`}
                      value={model.id}
                      checked={selected}
                      onChange={() => { void selectProviderModel(descriptor.id, model.id); }}
                      className="mt-1 h-4 w-4 accent-brand focus:outline-none focus:ring-2 focus:ring-brand/50"
                    />
                    <span className="min-w-0">
                      <span className="block font-medium text-slate-900 dark:text-slate-100">{model.label}</span>
                      {model.description !== undefined ? (
                        <span className="block text-xs text-slate-500 dark:text-slate-400">{model.description}</span>
                      ) : null}
                      <span className="mt-1 block text-xs text-slate-600 dark:text-slate-400">
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
        </fieldset>
      ) : null}
    </section>
  );
}

export function ProvidersTab(): JSX.Element {
  const providers = useStore((s) => s.providers);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Cloud providers</h2>
        <p className="mt-1 max-w-prose text-sm text-slate-600 dark:text-slate-400">
          Your key, your account, your bill. The audio is uploaded to whichever provider you pick.
        </p>
      </div>

      {PROVIDERS.map((descriptor) => {
        // The catalogue is the authority on which providers exist; main's list
        // only says what this machine has configured. A provider main has never
        // heard of still gets a card, empty.
        const state: ProviderState =
          providers.find((entry) => entry.id === descriptor.id) ?? { id: descriptor.id, hasKey: false, models: [] };
        return <ProviderCard key={descriptor.id} descriptor={descriptor} state={state} />;
      })}
    </div>
  );
}

export default ProvidersTab;
