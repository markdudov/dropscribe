/// <reference types="vitest/globals" />
/**
 * `electron/shared/languages.ts` — one table, five dialects of language code.
 *
 * The failure this module exists to prevent is silent by construction: a wrong
 * code does not throw, it decodes an hour of Javanese as Japanese and hands back
 * a plausible transcript. So the assertions here are about the mappings that
 * have exactly one right answer — `en-US`, `English`, `eng`, `zh-yue` — and
 * about junk resolving to `null` rather than to something almost right.
 */

import {
  LANGUAGES,
  PARAKEET_V3_LANGUAGES,
  WHISPER_LANGUAGES,
  findLanguage,
  languageName,
  normalizeLanguageCode,
  supportsLanguage,
} from '../electron/shared/languages';

describe('the code sets', () => {
  it('derives the Whisper set from the table rather than repeating it', () => {
    expect([...WHISPER_LANGUAGES]).toEqual(LANGUAGES.map((language) => language.code));
    expect(new Set(WHISPER_LANGUAGES).size).toBe(WHISPER_LANGUAGES.length);
  });

  // 100, not the 99 every Whisper README says: `yue` arrived with large-v3 and
  // the docs were never updated. `whisper-cli -l yue` works.
  it('carries all 100 Whisper languages, Cantonese included', () => {
    expect(WHISPER_LANGUAGES).toHaveLength(100);
    expect(WHISPER_LANGUAGES).toContain('yue');
    expect(WHISPER_LANGUAGES).toContain('haw');
    // Whisper's tokenizer spelling wins over the modern ISO one.
    expect(WHISPER_LANGUAGES).toContain('jw');
    expect(WHISPER_LANGUAGES).not.toContain('jv');
  });

  it('carries exactly the 25 languages Parakeet v3 was trained on', () => {
    expect(PARAKEET_V3_LANGUAGES).toHaveLength(25);
    expect(new Set(PARAKEET_V3_LANGUAGES).size).toBe(PARAKEET_V3_LANGUAGES.length);
    expect(PARAKEET_V3_LANGUAGES).toContain('bg');
    expect(PARAKEET_V3_LANGUAGES).toContain('uk');
    expect(PARAKEET_V3_LANGUAGES).not.toContain('ja');
    expect(PARAKEET_V3_LANGUAGES).not.toContain('zh');
  });

  it('keeps the Parakeet set inside the Whisper set, so one picker serves both', () => {
    for (const code of PARAKEET_V3_LANGUAGES) expect(WHISPER_LANGUAGES).toContain(code);
  });

  it('gives every entry a code, an English name and a native name', () => {
    for (const language of LANGUAGES) {
      expect(language.code).toMatch(/^[a-z]{2,3}$/);
      expect(language.name.trim().length).toBeGreaterThan(0);
      // The endonym column is the one a speaker of that language reads first,
      // so an empty or whitespace-only entry is worse than a missing column.
      expect(language.nativeName.trim().length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate English names, which would shadow one another in lookup', () => {
    const names = LANGUAGES.map((language) => language.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('normalizeLanguageCode', () => {
  it('maps every spelling of English onto "en"', () => {
    expect(normalizeLanguageCode('en-US')).toBe('en');
    expect(normalizeLanguageCode('English')).toBe('en');
    expect(normalizeLanguageCode('english')).toBe('en');
    expect(normalizeLanguageCode('  ENGLISH  ')).toBe('en');
    expect(normalizeLanguageCode('en')).toBe('en');
    // ElevenLabs Scribe answers in ISO-639-3.
    expect(normalizeLanguageCode('eng')).toBe('en');
    // The shapes a locale takes outside a language header.
    expect(normalizeLanguageCode('en_US.UTF-8')).toBe('en');
    expect(normalizeLanguageCode('English (United States)')).toBe('en');
  });

  it('returns null for anything it does not recognize', () => {
    expect(normalizeLanguageCode('qqq')).toBeNull();
    expect(normalizeLanguageCode('not a language')).toBeNull();
    expect(normalizeLanguageCode('###')).toBeNull();
    expect(normalizeLanguageCode('klingon')).toBeNull();
    expect(normalizeLanguageCode('12345')).toBeNull();
  });

  it('returns null for the strings that mean "detect"', () => {
    expect(normalizeLanguageCode('')).toBeNull();
    expect(normalizeLanguageCode('auto')).toBeNull();
    expect(normalizeLanguageCode('AUTO')).toBeNull();
    expect(normalizeLanguageCode('und')).toBeNull();
    expect(normalizeLanguageCode('none')).toBeNull();
  });

  // Stripping the subtag is right everywhere except here: `zh-yue` would fall
  // back to `zh` and decode Cantonese as Mandarin, which is a different
  // transcript rather than a slightly wrong tag.
  it('keeps Cantonese out of Mandarin', () => {
    expect(normalizeLanguageCode('zh-yue')).toBe('yue');
    expect(normalizeLanguageCode('yue')).toBe('yue');
    expect(normalizeLanguageCode('cantonese')).toBe('yue');
    expect(normalizeLanguageCode('zh-CN')).toBe('zh');
  });

  it('accepts the correct ISO spellings Whisper does not use', () => {
    expect(normalizeLanguageCode('jv')).toBe('jw');
    expect(normalizeLanguageCode('jw')).toBe('jw');
    expect(normalizeLanguageCode('iw')).toBe('he');
    expect(normalizeLanguageCode('nb')).toBe('no');
    expect(normalizeLanguageCode('ger')).toBe('de');
    expect(normalizeLanguageCode('chi')).toBe('zh');
  });

  it('folds accents, so an endonym-shaped name still lands', () => {
    expect(normalizeLanguageCode('Māori')).toBe('mi');
    expect(normalizeLanguageCode('maori')).toBe('mi');
  });

  it('never lets an alias shadow a real code', () => {
    // "no" is Norwegian, not the word.
    expect(normalizeLanguageCode('no')).toBe('no');
    for (const language of LANGUAGES) {
      expect(normalizeLanguageCode(language.code)).toBe(language.code);
      expect(normalizeLanguageCode(language.code.toUpperCase())).toBe(language.code);
    }
  });

  it('resolves every English name in the table back to its own code', () => {
    for (const language of LANGUAGES) {
      expect(normalizeLanguageCode(language.name)).toBe(language.code);
    }
  });
});

describe('findLanguage and languageName', () => {
  it('looks up by code only, case-insensitively', () => {
    expect(findLanguage('en')?.name).toBe('English');
    expect(findLanguage('EN')?.name).toBe('English');
    // Deliberately unforgiving: this is the question a settings validator asks.
    expect(findLanguage('eng')).toBeUndefined();
    expect(findLanguage('English')).toBeUndefined();
  });

  it('puts a readable name in front of a person', () => {
    expect(languageName(null)).toBe('Detect automatically');
    expect(languageName('en')).toBe('English');
    expect(languageName('en-US')).toBe('English');
    expect(languageName('eng')).toBe('English');
  });

  it('echoes an unknown tag rather than replacing it with "Unknown"', () => {
    expect(languageName('sah')).toBe('sah');
  });
});

describe('supportsLanguage', () => {
  it('accepts anything when the model detects for itself', () => {
    expect(supportsLanguage(null, 'ja')).toBe(true);
    expect(supportsLanguage(null, null)).toBe(true);
    // Even junk: a null list means the pre-flight warning has nothing to say.
    expect(supportsLanguage(null, 'qqq')).toBe(true);
  });

  it('accepts a null code, because auto-detect happens inside the list too', () => {
    expect(supportsLanguage(PARAKEET_V3_LANGUAGES, null)).toBe(true);
    expect(supportsLanguage([], null)).toBe(true);
  });

  it('answers for a model with a fixed list', () => {
    expect(supportsLanguage(PARAKEET_V3_LANGUAGES, 'bg')).toBe(true);
    expect(supportsLanguage(PARAKEET_V3_LANGUAGES, 'Bulgarian')).toBe(true);
    expect(supportsLanguage(PARAKEET_V3_LANGUAGES, 'bg-BG')).toBe(true);
    expect(supportsLanguage(PARAKEET_V3_LANGUAGES, 'ja')).toBe(false);
    expect(supportsLanguage(PARAKEET_V3_LANGUAGES, 'Japanese')).toBe(false);
  });

  it('separates "detect" from "unrecognizable", which normalize flattens together', () => {
    expect(supportsLanguage(PARAKEET_V3_LANGUAGES, 'auto')).toBe(true);
    expect(supportsLanguage(PARAKEET_V3_LANGUAGES, 'und')).toBe(true);
    // A code no engine accepts is precisely the case worth warning about.
    expect(supportsLanguage(PARAKEET_V3_LANGUAGES, 'qqq')).toBe(false);
    expect(supportsLanguage(PARAKEET_V3_LANGUAGES, 'klingon')).toBe(false);
  });

  it('normalizes the catalogue side too, so a hand-edited entry still matches', () => {
    expect(supportsLanguage(['HR', 'nb'], 'hr')).toBe(true);
    expect(supportsLanguage(['HR', 'nb'], 'no')).toBe(true);
  });
});
