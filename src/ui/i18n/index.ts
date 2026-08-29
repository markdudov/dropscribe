/**
 * Lookup and interpolation for the two interface languages.
 *
 * The whole of i18n in this app is this file plus two catalogues. There is no
 * react-i18next, no ICU MessageFormat and no loader: 260 strings across two
 * languages do not need a plural-rule engine, a namespace resolver or a
 * suspense boundary, and every one of those would have to be configured,
 * upgraded and explained. What they would add on top of the code below is a
 * second home for the current locale — a React context — which is exactly the
 * thing that then disagrees with the store.
 *
 * Two shapes, deliberately:
 *
 *  - `t(key, locale, params)` takes the locale as an argument, so it is a pure
 *    function usable outside React — where an error string is assembled in a
 *    plain module, and in tests. The tempting alternative is a module-level
 *    `let currentLocale` kept in sync by a store subscription; that works until
 *    one test renders both languages in one process and the second one leaks
 *    into the first's assertions.
 *  - `useT()` is the component-facing wrapper that reads the locale from the
 *    store, so no component has to thread it down.
 */

import { useCallback } from 'react';

// Another module owns the store; this import is against its published shape.
import { useStore } from '@/ui/store';

import { bg } from './bg';
import { en } from './en';

export type Locale = 'en' | 'bg';

/**
 * Every string the app can say, as a closed union. `en.ts` ends in `as const`
 * precisely so this is a union of literals and not `string` — see the comment
 * there, and `bg.ts`, which is checked against this union.
 */
export type TranslationKey = keyof typeof en;

/** What an unhydrated store falls back to, and what `bg` is translated from. */
const DEFAULT_LOCALE: Locale = 'en';

/**
 * The value type is widened to `string | undefined` on purpose.
 *
 * Both catalogues are complete by construction — `bg.ts` cannot compile with a
 * hole in it — so TypeScript would type every lookup as `string` and the
 * missing-key branch below would look like dead code. It is not: a key can
 * arrive from a runtime cast, when the UI builds one out of data that crossed
 * IPC (`job.status.${status}`) and the value is not one of the statuses this
 * build knows. Widening here is what keeps that branch honest.
 */
const CATALOGUES: Readonly<Record<Locale, Readonly<Record<string, string | undefined>>>> = {
  en,
  bg,
};

/**
 * `{name}`, and nothing cleverer. No formats, no nested selects, no escaping —
 * a literal brace has never had to appear in a UI string here, and the day one
 * does the fix is to reword the string rather than to grow a parser.
 *
 * Shared at module scope despite the `g` flag because `String.replace` resets
 * `lastIndex` itself. `RegExp.test` does not, which is why it is not used.
 */
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * The string for `key` in `locale`, with `{placeholders}` filled in.
 *
 * An unknown key returns the key itself, and a placeholder with no value is
 * left standing as `{name}`. Both are ugly on screen, and that is the point:
 * the alternatives are an empty gap or the word "undefined", and an empty gap
 * is a bug that ships because nobody notices a label that was never there.
 * A visible `jobs.empty.title` in the middle of the window gets reported, and
 * it names the exact key to go and fix.
 */
export function t(
  key: TranslationKey,
  locale: Locale,
  params?: Record<string, string | number>,
): string {
  const template = CATALOGUES[locale][key];
  if (template === undefined) return key;
  if (params === undefined) return template;

  return template.replace(PLACEHOLDER, (match: string, name: string): string => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * The slice of the store this module reads, and not a byte more.
 *
 * Declaring it here rather than importing the store's state type keeps the
 * dependency one-directional — i18n is imported by nearly every component, and
 * a type import back into the store would close a loop through the whole UI.
 * Because the selector is contravariant in its argument, the compiler still
 * checks the real state against this shape at the call site: rename
 * `settings.uiLanguage` in the store and this stops compiling.
 *
 * Both levels are optional because the settings arrive over IPC. The first
 * render happens before that answer does, and a translator that throws on an
 * unhydrated store takes the entire window with it.
 */
interface UiLanguageState {
  readonly settings?: { readonly uiLanguage?: Locale } | null;
}

/**
 * The translator for the current interface language.
 *
 * The selector returns a single string rather than the settings object, so
 * zustand's default `Object.is` comparison is enough and a component that only
 * shows text does not re-render when an unrelated setting changes. The result
 * is memoised on the locale, so `t` stays referentially stable and can be
 * passed to a memoised child without defeating it.
 */
export function useT(): (key: TranslationKey, params?: Record<string, string | number>) => string {
  const stored: Locale | undefined = useStore(
    (state: UiLanguageState) => state.settings?.uiLanguage,
  );
  const locale: Locale = stored ?? DEFAULT_LOCALE;

  return useCallback(
    (key: TranslationKey, params?: Record<string, string | number>): string =>
      t(key, locale, params),
    [locale],
  );
}
