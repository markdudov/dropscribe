/**
 * Everything about what comes out and where it lands.
 *
 * Two groups of controls that look alike and behave very differently. The top
 * half — formats, folder, language, threads — takes effect on the next job. The
 * subtitle rules at the bottom take effect on the next *export*, because cues
 * are derived from the stored transcript every time it is rendered, never baked
 * into it. That is why changing `maxCharsPerLine` does not require re-running
 * anything, and why the reset button is safe to press.
 */

import { useEffect, useState } from 'react';
import { FolderOpen, RotateCcw } from 'lucide-react';

import type { ExportFormat } from '../../../electron/api-types';
import { EXPORT_FORMATS } from '../../../electron/api-types';
import { LANGUAGES } from '../../../electron/shared/languages';
import type { SegmentationOptions } from '../../../electron/shared/subtitles';
import { DEFAULT_SEGMENTATION } from '../../../electron/shared/subtitles';
import { useStore } from '../store';

const BUTTON =
  'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ' +
  'focus:outline-none focus:ring-2 focus:ring-brand/50 disabled:cursor-not-allowed disabled:opacity-50';
const QUIET =
  `${BUTTON} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 ` +
  'dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';

const FIELD =
  'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 ' +
  'focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/40 ' +
  'dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';

const FORMAT_LABELS: Readonly<Record<ExportFormat, string>> = {
  txt: 'Plain text',
  md: 'Markdown',
  srt: 'SubRip subtitles',
  vtt: 'WebVTT subtitles',
  json: 'JSON',
  csv: 'CSV',
};

function Section({ title, helper, children }: { title: string; helper?: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      {helper !== undefined ? (
        <p className="mt-1 max-w-prose text-xs text-slate-500 dark:text-slate-400">{helper}</p>
      ) : null}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function Toggle({
  id, label, helper, checked, disabled, onChange,
}: {
  id: string; label: string; helper?: string; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled === true}
        onChange={(event) => { onChange(event.target.checked); }}
        className="mt-0.5 h-4 w-4 shrink-0 accent-brand focus:outline-none focus:ring-2 focus:ring-brand/50 disabled:opacity-50"
        {...(helper !== undefined ? { 'aria-describedby': `${id}-helper` } : {})}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-slate-800 dark:text-slate-200">{label}</label>
        {helper !== undefined ? (
          <p id={`${id}-helper`} className="text-xs text-slate-500 dark:text-slate-400">{helper}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A number that is written when the user has finished typing it.
 *
 * Committing on every keystroke was the first version and it is unusable: on
 * the way from 8 to 42 the field passes through 4, which the main-side clamp
 * snaps up to the minimum of 10, which React then writes back into the input —
 * so the second digit lands in a field that has silently changed under it. The
 * draft is local, the clamp happens once on blur, and Enter is a blur.
 */
function NumberField({
  id, label, helper, value, min, max, suffix, onCommit,
}: {
  id: string; label: string; helper?: string; value: number; min: number; max: number;
  suffix?: string; onCommit: (next: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);

  function commit(): void {
    const parsed = Number.parseInt(draft, 10);
    if (Number.isNaN(parsed)) { setDraft(String(value)); return; }
    const clamped = Math.min(max, Math.max(min, parsed));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-slate-800 dark:text-slate-200">{label}</label>
        {helper !== undefined ? (
          <p id={`${id}-helper`} className="max-w-prose text-xs text-slate-500 dark:text-slate-400">{helper}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={draft}
          onChange={(event) => { setDraft(event.target.value); }}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          className={`${FIELD} w-24 text-right`}
          {...(helper !== undefined ? { 'aria-describedby': `${id}-helper` } : {})}
        />
        {suffix !== undefined ? (
          <span className="w-16 text-xs text-slate-500 dark:text-slate-400">{suffix}</span>
        ) : null}
      </div>
    </div>
  );
}

export function OutputTab(): JSX.Element {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const updateOutput = useStore((s) => s.updateOutput);
  const updateSegmentation = useStore((s) => s.updateSegmentation);
  const resetSegmentation = useStore((s) => s.resetSegmentation);
  const chooseOutputDir = useStore((s) => s.chooseOutputDir);

  const output = settings.output;
  const seg = settings.segmentation;

  // Sorted for reading, not stored sorted: `languages.ts` keeps its own order so
  // it can be diffed against Whisper's tokenizer by eye.
  const languages = [...LANGUAGES].sort((a, b) => a.name.localeCompare(b.name));

  const segmentationIsDefault = (Object.keys(DEFAULT_SEGMENTATION) as (keyof SegmentationOptions)[])
    .every((field) => seg[field] === DEFAULT_SEGMENTATION[field]);

  function toggleFormat(format: ExportFormat, on: boolean): void {
    // Rebuilt in catalogue order so the list never reshuffles as it is edited.
    const next = EXPORT_FORMATS.filter((entry) => (entry === format ? on : output.formats.includes(entry)));
    void updateOutput({ formats: [...next] });
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Files and transcription</h2>
        <p className="mt-1 max-w-prose text-sm text-slate-600 dark:text-slate-400">
          What gets written when a job finishes, and how the words are turned into subtitles.
        </p>
      </div>

      <Section
        title="Written when a job finishes"
        helper="Leave everything off to export by hand from the queue instead."
      >
        <div className="grid grid-cols-2 gap-2">
          {EXPORT_FORMATS.map((format) => (
            <Toggle
              key={format}
              id={`format-${format}`}
              label={FORMAT_LABELS[format]}
              checked={output.formats.includes(format)}
              onChange={(on) => { toggleFormat(format, on); }}
            />
          ))}
        </div>
      </Section>

      <Section title="Where they go">
        <fieldset className="space-y-3">
          <legend className="sr-only">Where finished files are written</legend>
          <div className="flex items-start gap-3">
            <input
              id="output-beside"
              type="radio"
              name="output-location"
              checked={output.besideSource}
              onChange={() => { void updateOutput({ besideSource: true }); }}
              className="mt-0.5 h-4 w-4 accent-brand focus:outline-none focus:ring-2 focus:ring-brand/50"
            />
            <label htmlFor="output-beside" className="text-sm font-medium text-slate-800 dark:text-slate-200">
              Beside the source file
            </label>
          </div>
          <div className="flex items-start gap-3">
            <input
              id="output-folder"
              type="radio"
              name="output-location"
              checked={!output.besideSource}
              onChange={() => { void updateOutput({ besideSource: false }); }}
              className="mt-0.5 h-4 w-4 accent-brand focus:outline-none focus:ring-2 focus:ring-brand/50"
            />
            <div className="min-w-0 flex-1">
              <label htmlFor="output-folder" className="text-sm font-medium text-slate-800 dark:text-slate-200">
                All into one folder
              </label>
              <div className="mt-1 flex items-center gap-2">
                <span className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                  {output.outputDir ?? 'No folder chosen yet'}
                </span>
                <button type="button" className={QUIET} onClick={() => { void chooseOutputDir(); }}>
                  <FolderOpen aria-hidden className="h-4 w-4" />
                  Choose a folder…
                </button>
              </div>
            </div>
          </div>
        </fieldset>

        <Toggle
          id="output-speakers"
          label="Put the speaker in front of each line"
          helper="Does something only when the transcript has speakers in it."
          checked={output.includeSpeakers}
          onChange={(on) => { void updateOutput({ includeSpeakers: on }); }}
        />
      </Section>

      <Section title="Transcription">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <label htmlFor="setting-language" className="text-sm font-medium text-slate-800 dark:text-slate-200">
              Spoken language
            </label>
            <p id="setting-language-helper" className="max-w-prose text-xs text-slate-500 dark:text-slate-400">
              Leave this on automatic unless the model keeps guessing wrong.
            </p>
          </div>
          <select
            id="setting-language"
            aria-describedby="setting-language-helper"
            className={`${FIELD} w-56`}
            value={settings.language ?? ''}
            onChange={(event) => {
              // The empty string is the only value a `<select>` can carry for
              // "no language", and `null` is what every layer below expects.
              const raw = event.target.value;
              void updateSettings({ language: raw === '' ? null : raw });
            }}
          >
            <option value="">Detect automatically</option>
            {languages.map((language) => (
              <option key={language.code} value={language.code}>
                {language.name} — {language.nativeName}
              </option>
            ))}
          </select>
        </div>

        <Toggle
          id="setting-translate"
          label="Translate to English"
          helper="Whisper can translate while it transcribes. Parakeet cannot."
          checked={settings.translate}
          onChange={(on) => { void updateSettings({ translate: on }); }}
        />
        <Toggle
          id="setting-diarize"
          label="Identify the speakers"
          helper="Cloud providers only — the local models do not separate speakers."
          checked={settings.diarize}
          onChange={(on) => { void updateSettings({ diarize: on }); }}
        />

        <NumberField
          id="setting-concurrency"
          label="Files at once"
          helper="Local inference is bound by memory, not by cores. More than one at a time rarely finishes sooner."
          value={settings.maxConcurrentJobs}
          min={1}
          max={8}
          suffix="files"
          onCommit={(next) => { void updateSettings({ maxConcurrentJobs: next }); }}
        />
        <NumberField
          id="setting-threads"
          label="CPU threads"
          helper="Zero lets the app choose from the core count."
          value={settings.threads}
          min={0}
          max={128}
          suffix={settings.threads === 0 ? 'automatic' : 'threads'}
          onCommit={(next) => { void updateSettings({ threads: next }); }}
        />
      </Section>

      <Section title="Appearance">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="setting-theme" className="text-sm font-medium text-slate-800 dark:text-slate-200">Theme</label>
          <select
            id="setting-theme"
            className={`${FIELD} w-56`}
            value={settings.theme}
            onChange={(event) => {
              const raw = event.target.value;
              const theme: typeof settings.theme = raw === 'light' || raw === 'dark' ? raw : 'system';
              void updateSettings({ theme });
            }}
          >
            <option value="system">Match the system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <label htmlFor="setting-ui-language" className="text-sm font-medium text-slate-800 dark:text-slate-200">
              Interface language
            </label>
            <p id="setting-ui-language-helper" className="text-xs text-slate-500 dark:text-slate-400">
              This changes the app, not the transcription.
            </p>
          </div>
          <select
            id="setting-ui-language"
            aria-describedby="setting-ui-language-helper"
            className={`${FIELD} w-56`}
            value={settings.uiLanguage}
            onChange={(event) => {
              const uiLanguage: typeof settings.uiLanguage = event.target.value === 'bg' ? 'bg' : 'en';
              void updateSettings({ uiLanguage });
            }}
          >
            <option value="en">English</option>
            <option value="bg">Български</option>
          </select>
        </div>
      </Section>

      <Section
        title="Subtitle shape"
        helper="These rules turn a transcript into cues. The defaults are where the BBC and Netflix guidelines agree."
      >
        <NumberField
          id="seg-chars-per-line"
          label="Characters per line"
          helper="42 is the width that stays safe inside a 16:9 frame."
          value={seg.maxCharsPerLine}
          min={10}
          max={200}
          suffix="characters"
          onCommit={(next) => { void updateSegmentation({ maxCharsPerLine: next }); }}
        />
        <NumberField
          id="seg-max-lines"
          label="Lines per subtitle"
          helper="Two is the professional ceiling. Three cover the picture."
          value={seg.maxLines}
          min={1}
          max={6}
          suffix="lines"
          onCommit={(next) => { void updateSegmentation({ maxLines: next }); }}
        />
        <NumberField
          id="seg-max-duration"
          label="Longest on screen"
          helper="Past this the eye goes back and reads the line a second time."
          value={seg.maxDurationMs}
          min={500}
          max={30000}
          suffix="ms"
          onCommit={(next) => { void updateSegmentation({ maxDurationMs: next }); }}
        />
        <NumberField
          id="seg-min-duration"
          label="Shortest on screen"
          helper="A flash under a second is unreadable, even for a single word."
          value={seg.minDurationMs}
          min={100}
          max={10000}
          suffix="ms"
          onCommit={(next) => { void updateSegmentation({ minDurationMs: next }); }}
        />
        <NumberField
          id="seg-cps"
          label="Reading speed"
          helper="Characters per second. Above 17 most viewers fall behind."
          value={seg.maxCharsPerSecond}
          min={1}
          max={100}
          suffix="chars/s"
          onCommit={(next) => { void updateSegmentation({ maxCharsPerSecond: next }); }}
        />
        <NumberField
          id="seg-gap-split"
          label="Split on a pause"
          helper="A silence at least this long ends the subtitle, so no cue spans a pause you can hear."
          value={seg.gapSplitMs}
          min={0}
          max={10000}
          suffix="ms"
          onCommit={(next) => { void updateSegmentation({ gapSplitMs: next }); }}
        />
        <NumberField
          id="seg-min-gap"
          label="Gap between subtitles"
          helper="Blank frames, so two subtitles do not read as one."
          value={seg.minGapMs}
          min={0}
          max={2000}
          suffix="ms"
          onCommit={(next) => { void updateSegmentation({ minGapMs: next }); }}
        />

        <div className="pt-1">
          <button
            type="button"
            className={QUIET}
            disabled={segmentationIsDefault}
            onClick={() => { void resetSegmentation(); }}
          >
            <RotateCcw aria-hidden className="h-4 w-4" />
            Restore the standard values
          </button>
        </div>
      </Section>
    </div>
  );
}

export default OutputTab;
