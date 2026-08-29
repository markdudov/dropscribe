/**
 * Version, engines, links, licences.
 *
 * The engine report is the part that earns its place. A missing vendored binary
 * is invisible until the first job fails with something that reads like a bug
 * in the user's file, so it is stated here, in red, before anyone drops
 * anything — and the per-binary paths are shown, because "ffprobe is missing"
 * is a support question and "ffprobe is missing from *this* directory" is an
 * answer.
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, Heart, Loader2, XCircle } from 'lucide-react';

import { api, useStore } from '../store';

const GHOST = 'btn-ghost inline-flex items-center gap-2';

const PLATFORM_NAMES: Readonly<Record<'darwin' | 'win32' | 'linux', string>> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

export function AboutTab(): JSX.Element {
  const appInfo = useStore((s) => s.appInfo);
  const openExternal = useStore((s) => s.openExternal);

  const [licenses, setLicenses] = useState<string | null>(null);
  const [licenseError, setLicenseError] = useState<string | null>(null);

  useEffect(() => {
    /*
     * Fetched here rather than in `init()`: the notice is tens of kilobytes of
     * text that nobody reads on ninety-nine launches out of a hundred, and
     * carrying it in the store from startup would mean every component that
     * subscribes to the store holds a reference to it.
     */
    let cancelled = false;
    void (async () => {
      try {
        const text = await api().getLicenses();
        if (!cancelled) setLicenses(text);
      } catch (error) {
        if (!cancelled) setLicenseError(error instanceof Error ? error.message : 'The notices could not be read.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const report = appInfo?.engineReport ?? [];
  const missing = report.filter((entry) => !entry.present);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-100">
          About DropScribe
        </h2>
        <p className="mt-1 max-w-prose text-[0.8125rem] leading-relaxed text-slate-600 dark:text-slate-400">
          A local model never sends your audio anywhere. A cloud provider does — that is the whole trade.
        </p>
      </div>

      <div className="space-y-3">
        {/* The build, on its own card. It is the first line of every bug report
            and the one thing on this tab a user is asked to read out loud. */}
        <div className="surface p-4">
          {appInfo !== null ? (
            <p className="tnum selectable text-sm text-slate-700 dark:text-slate-300">
              Version {appInfo.version} · {PLATFORM_NAMES[appInfo.platform]} · {appInfo.arch}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              Reading the app details…
            </p>
          )}
        </div>

        <section className="surface p-4" aria-labelledby="about-engines">
          <h3
            id="about-engines"
            className="text-sm font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-100"
          >
            Bundled engines
          </h3>
          <p
            className={
              missing.length === 0
                ? 'mt-1 flex items-center gap-2 text-[0.8125rem] text-emerald-700 dark:text-emerald-400'
                : 'mt-1 flex items-center gap-2 text-[0.8125rem] font-medium text-red-700 dark:text-red-400'
            }
          >
            {missing.length === 0
              ? <CheckCircle2 aria-hidden className="h-4 w-4" />
              : <XCircle aria-hidden className="h-4 w-4" />}
            {missing.length === 0
              ? 'Every engine is in place.'
              : 'An engine is missing from this build. Transcription will fail until that is fixed.'}
          </p>

          {/*
            A present binary is a fact, not an achievement: its tick is the same
            muted grey as the rest of the line, and only the missing ones are
            allowed to take colour. Six green ticks would drown the one red
            cross this list exists to show.
          */}
          <ul className="mt-3 space-y-1">
            {report.map((entry) => (
              <li
                key={entry.name}
                className={
                  'flex items-start gap-2 rounded-xl px-2 py-1.5 text-[0.8125rem] ' +
                  (entry.present
                    ? 'text-slate-700 dark:text-slate-300'
                    : 'border border-red-300 bg-red-50 text-red-900 dark:border-red-500/25 dark:bg-red-500/[0.08] dark:text-red-200')
                }
              >
                {entry.present
                  ? <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500" />
                  : <XCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />}
                <span className="min-w-0">
                  <span className="font-medium">{entry.name}</span>
                  <span className="ml-2 text-[0.75rem] opacity-80">{entry.present ? 'found' : 'missing'}</span>
                  <span className="selectable block truncate font-mono text-xs opacity-70" title={entry.path}>
                    {entry.path}
                  </span>
                </span>
              </li>
            ))}
            {report.length === 0 ? (
              <li className="text-[0.8125rem] text-slate-500 dark:text-slate-400">No engine report yet.</li>
            ) : null}
          </ul>
        </section>

        <section className="flex flex-wrap gap-2" aria-label="Links">
          <button type="button" className={GHOST} onClick={() => { void openExternal('repo'); }}>
            <ExternalLink aria-hidden className="h-4 w-4" />
            Source code on GitHub
          </button>
          <button type="button" className={GHOST} onClick={() => { void openExternal('issues'); }}>
            <ExternalLink aria-hidden className="h-4 w-4" />
            Report a problem
          </button>
        </section>

        {/*
          * Below the links and above the licences, which is where it belongs:
          * someone reading this far is already curious about the project. It is
          * a sentence and two buttons, not a banner — nothing in the app is
          * withheld behind it, and a nag would be the wrong thing to put in a
          * tool people run on their own files.
          */}
        <section className="surface p-4" aria-labelledby="about-support">
          <h3
            id="about-support"
            className="flex items-center gap-2 text-sm font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-100"
          >
            <Heart aria-hidden className="h-4 w-4 text-slate-400 dark:text-slate-500" />
            Supporting DropScribe
          </h3>
          <p className="mt-1 max-w-prose text-[0.8125rem] leading-relaxed text-slate-500 dark:text-slate-400">
            The app is free and MIT licensed, and it stays that way — there is no paid tier and nothing is held back.
            Keeping it signed and notarized costs money, though. If it saves you work and you would like to chip in,
            it is entirely optional and a good bug report is worth as much.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={GHOST} onClick={() => { void openExternal('support:paypal'); }}>
              <ExternalLink aria-hidden className="h-4 w-4" />
              PayPal
            </button>
            <button type="button" className={GHOST} onClick={() => { void openExternal('support:revolut'); }}>
              <ExternalLink aria-hidden className="h-4 w-4" />
              Revolut
            </button>
          </div>
        </section>

        <section className="surface p-4" aria-labelledby="about-licenses">
          <h3
            id="about-licenses"
            className="text-sm font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-100"
          >
            Third-party notices
          </h3>
          <p className="mt-1 max-w-prose text-[0.8125rem] leading-relaxed text-slate-500 dark:text-slate-400">
            DropScribe is free software under the MIT licence. It is built on whisper.cpp and ffmpeg, which do the hard
            part, and the model weights carry licences of their own.
          </p>
          {licenseError !== null ? (
            <p className="mt-3 animate-fade-up rounded-xl border border-red-300 bg-red-50 p-2 text-[0.75rem] text-red-900 dark:border-red-500/25 dark:bg-red-500/[0.08] dark:text-red-200">
              {licenseError}
            </p>
          ) : licenses === null ? (
            <p className="mt-3 flex items-center gap-2 text-[0.8125rem] text-slate-500 dark:text-slate-400">
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              Reading the notices…
            </p>
          ) : (
            <pre
              // `tabIndex` on a scroll container, not decoration: without it the
              // only way to scroll this box is a pointer, and the notice is the
              // one panel in the app a keyboard user might genuinely have to read
              // end to end.
              tabIndex={0}
              aria-label="Third-party licence notices"
              className="surface-raised selectable mt-3 max-h-72 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed text-slate-700 dark:text-slate-300"
            >
              {licenses}
            </pre>
          )}
        </section>
      </div>
    </div>
  );
}

export default AboutTab;
