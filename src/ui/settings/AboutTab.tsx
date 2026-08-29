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
import { CheckCircle2, ExternalLink, Loader2, XCircle } from 'lucide-react';

import { api, useStore } from '../store';

const BUTTON =
  'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ' +
  'focus:outline-none focus:ring-2 focus:ring-brand/50 disabled:cursor-not-allowed disabled:opacity-50';
const QUIET =
  `${BUTTON} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 ` +
  'dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';

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
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">About DropScribe</h2>
        {appInfo !== null ? (
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Version {appInfo.version} · {PLATFORM_NAMES[appInfo.platform]} · {appInfo.arch}
          </p>
        ) : (
          <p className="mt-1 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            Reading the app details…
          </p>
        )}
        <p className="mt-2 max-w-prose text-sm text-slate-600 dark:text-slate-400">
          A local model never sends your audio anywhere. A cloud provider does — that is the whole trade.
        </p>
      </div>

      <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800" aria-labelledby="about-engines">
        <h3 id="about-engines" className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Bundled engines
        </h3>
        <p
          className={
            missing.length === 0
              ? 'mt-1 flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400'
              : 'mt-1 flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-400'
          }
        >
          {missing.length === 0
            ? <CheckCircle2 aria-hidden className="h-4 w-4" />
            : <XCircle aria-hidden className="h-4 w-4" />}
          {missing.length === 0
            ? 'Every engine is in place.'
            : 'An engine is missing from this build. Transcription will fail until that is fixed.'}
        </p>

        <ul className="mt-3 space-y-1">
          {report.map((entry) => (
            <li
              key={entry.name}
              className={
                'flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm ' +
                (entry.present
                  ? 'text-slate-700 dark:text-slate-300'
                  : 'bg-red-50 text-red-900 dark:bg-red-950/50 dark:text-red-200')
              }
            >
              {entry.present
                ? <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                : <XCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />}
              <span className="min-w-0">
                <span className="font-medium">{entry.name}</span>
                <span className="ml-2 text-xs opacity-80">{entry.present ? 'found' : 'missing'}</span>
                <span className="block truncate font-mono text-xs opacity-70" title={entry.path}>{entry.path}</span>
              </span>
            </li>
          ))}
          {report.length === 0 ? (
            <li className="text-sm text-slate-500 dark:text-slate-400">No engine report yet.</li>
          ) : null}
        </ul>
      </section>

      <section className="flex flex-wrap gap-2" aria-label="Links">
        <button type="button" className={QUIET} onClick={() => { void openExternal('repo'); }}>
          <ExternalLink aria-hidden className="h-4 w-4" />
          Source code on GitHub
        </button>
        <button type="button" className={QUIET} onClick={() => { void openExternal('issues'); }}>
          <ExternalLink aria-hidden className="h-4 w-4" />
          Report a problem
        </button>
      </section>

      <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800" aria-labelledby="about-licenses">
        <h3 id="about-licenses" className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Third-party notices
        </h3>
        <p className="mt-1 max-w-prose text-xs text-slate-500 dark:text-slate-400">
          DropScribe is free software under the MIT licence. It is built on whisper.cpp and ffmpeg, which do the hard
          part, and the model weights carry licences of their own.
        </p>
        {licenseError !== null ? (
          <p className="mt-3 rounded-lg bg-red-50 p-2 text-xs text-red-900 dark:bg-red-950/50 dark:text-red-200">
            {licenseError}
          </p>
        ) : licenses === null ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
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
            className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand/50 dark:bg-slate-950 dark:text-slate-300"
          >
            {licenses}
          </pre>
        )}
      </section>
    </div>
  );
}

export default AboutTab;
