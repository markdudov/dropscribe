/**
 * Every language code this app knows, in one table.
 *
 * Five things speak language codes here and none of them spells them the same
 * way: whisper.cpp's `-l` flag, DeepInfra's `language` field, Deepgram's
 * `language` query parameter, ElevenLabs' `language_code` field, and the
 * selector in the UI. The obvious shape — a small map beside each adapter —
 * was rejected because the failure it produces is silent. A code one adapter
 * spells `jw` and another spells `jv` does not throw: it decodes an hour of
 * Javanese as Japanese and hands back a plausible-looking transcript that
 * nobody notices until a customer reads it. One table, one spelling, and every
 * adapter converts at its own edge — the same discipline `transcript.ts`
 * applies to time.
 *
 * PURE by contract: the renderer compiles this file, so nothing in it may
 * touch `node:` or `electron`.
 */

export interface Language {
  /** The code this app uses everywhere. ISO-639-1 wherever one exists. */
  code: string;
  /** English name. Also the string DeepInfra answers with, lowercased. */
  name: string;
  /**
   * The name as its own speakers write it, shown beside `name` in the picker.
   *
   * Worth getting right rather than approximating: the only people who read
   * this column are the ones who would spot a wrong one instantly, and a
   * mangled endonym is the fastest way to tell a speaker that their language
   * was an afterthought here.
   */
  nativeName: string;
}

/**
 * The languages Whisper accepts, in the order Whisper's own tokenizer lists
 * their codes (alphabetical), so this table can be diffed against upstream by
 * eye. The picker sorts by `name` at render time; sorting here would make that
 * comparison impossible.
 *
 * Two codes are deliberately not the modern ISO-639-1 ones, because the flag
 * value the binary accepts wins over correctness in the abstract:
 *   - `jw` for Javanese, where ISO-639-1 says `jv`.
 *   - `yue` for Cantonese, which has no two-letter code at all; Whisper added
 *     it with large-v3 and it is the one three-letter code in the set besides
 *     `haw`.
 * Both of the "correct" spellings are accepted by `normalizeLanguageCode`.
 *
 * The count is 100, not the 99 every Whisper README says: `yue` was added with
 * large-v3 and the docs were never updated. Do not "fix" this list down to 99 —
 * `whisper-cli -l yue` works, and dropping it would take Cantonese out of the
 * picker for a model that transcribes it.
 */
export const LANGUAGES: readonly Language[] = [
  { code: 'af', name: 'Afrikaans', nativeName: 'Afrikaans' },
  { code: 'am', name: 'Amharic', nativeName: 'አማርኛ' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
  { code: 'as', name: 'Assamese', nativeName: 'অসমীয়া' },
  { code: 'az', name: 'Azerbaijani', nativeName: 'Azərbaycan dili' },
  { code: 'ba', name: 'Bashkir', nativeName: 'Башҡорт теле' },
  { code: 'be', name: 'Belarusian', nativeName: 'Беларуская' },
  { code: 'bg', name: 'Bulgarian', nativeName: 'Български' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা' },
  { code: 'bo', name: 'Tibetan', nativeName: 'བོད་སྐད་' },
  { code: 'br', name: 'Breton', nativeName: 'Brezhoneg' },
  { code: 'bs', name: 'Bosnian', nativeName: 'Bosanski' },
  { code: 'ca', name: 'Catalan', nativeName: 'Català' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština' },
  { code: 'cy', name: 'Welsh', nativeName: 'Cymraeg' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά' },
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'et', name: 'Estonian', nativeName: 'Eesti' },
  { code: 'eu', name: 'Basque', nativeName: 'Euskara' },
  { code: 'fa', name: 'Persian', nativeName: 'فارسی' },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi' },
  { code: 'fo', name: 'Faroese', nativeName: 'Føroyskt' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'gl', name: 'Galician', nativeName: 'Galego' },
  { code: 'gu', name: 'Gujarati', nativeName: 'ગુજરાતી' },
  { code: 'ha', name: 'Hausa', nativeName: 'Hausa' },
  { code: 'haw', name: 'Hawaiian', nativeName: 'ʻŌlelo Hawaiʻi' },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'hr', name: 'Croatian', nativeName: 'Hrvatski' },
  { code: 'ht', name: 'Haitian Creole', nativeName: 'Kreyòl ayisyen' },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar' },
  { code: 'hy', name: 'Armenian', nativeName: 'Հայերեն' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
  { code: 'is', name: 'Icelandic', nativeName: 'Íslenska' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'jw', name: 'Javanese', nativeName: 'Basa Jawa' },
  { code: 'ka', name: 'Georgian', nativeName: 'ქართული' },
  { code: 'kk', name: 'Kazakh', nativeName: 'Қазақ тілі' },
  { code: 'km', name: 'Khmer', nativeName: 'ខ្មែរ' },
  { code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'la', name: 'Latin', nativeName: 'Latina' },
  { code: 'lb', name: 'Luxembourgish', nativeName: 'Lëtzebuergesch' },
  { code: 'ln', name: 'Lingala', nativeName: 'Lingála' },
  { code: 'lo', name: 'Lao', nativeName: 'ລາວ' },
  { code: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių' },
  { code: 'lv', name: 'Latvian', nativeName: 'Latviešu' },
  { code: 'mg', name: 'Malagasy', nativeName: 'Malagasy' },
  { code: 'mi', name: 'Māori', nativeName: 'Te Reo Māori' },
  { code: 'mk', name: 'Macedonian', nativeName: 'Македонски' },
  { code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം' },
  { code: 'mn', name: 'Mongolian', nativeName: 'Монгол хэл' },
  { code: 'mr', name: 'Marathi', nativeName: 'मराठी' },
  { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu' },
  { code: 'mt', name: 'Maltese', nativeName: 'Malti' },
  { code: 'my', name: 'Burmese', nativeName: 'မြန်မာဘာသာ' },
  { code: 'ne', name: 'Nepali', nativeName: 'नेपाली' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
  { code: 'nn', name: 'Norwegian Nynorsk', nativeName: 'Nynorsk' },
  { code: 'no', name: 'Norwegian', nativeName: 'Norsk bokmål' },
  { code: 'oc', name: 'Occitan', nativeName: 'Occitan' },
  { code: 'pa', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski' },
  { code: 'ps', name: 'Pashto', nativeName: 'پښتو' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  { code: 'ro', name: 'Romanian', nativeName: 'Română' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'sa', name: 'Sanskrit', nativeName: 'संस्कृतम्' },
  { code: 'sd', name: 'Sindhi', nativeName: 'سنڌي' },
  { code: 'si', name: 'Sinhala', nativeName: 'සිංහල' },
  { code: 'sk', name: 'Slovak', nativeName: 'Slovenčina' },
  { code: 'sl', name: 'Slovenian', nativeName: 'Slovenščina' },
  { code: 'sn', name: 'Shona', nativeName: 'chiShona' },
  { code: 'so', name: 'Somali', nativeName: 'Soomaali' },
  { code: 'sq', name: 'Albanian', nativeName: 'Shqip' },
  { code: 'sr', name: 'Serbian', nativeName: 'Српски' },
  { code: 'su', name: 'Sundanese', nativeName: 'Basa Sunda' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska' },
  { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்' },
  { code: 'te', name: 'Telugu', nativeName: 'తెలుగు' },
  { code: 'tg', name: 'Tajik', nativeName: 'Тоҷикӣ' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย' },
  { code: 'tk', name: 'Turkmen', nativeName: 'Türkmen dili' },
  { code: 'tl', name: 'Tagalog', nativeName: 'Tagalog' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
  { code: 'tt', name: 'Tatar', nativeName: 'Татар теле' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو' },
  { code: 'uz', name: 'Uzbek', nativeName: 'Oʻzbekcha' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
  { code: 'yi', name: 'Yiddish', nativeName: 'ייִדיש' },
  { code: 'yo', name: 'Yoruba', nativeName: 'Yorùbá' },
  { code: 'yue', name: 'Cantonese', nativeName: '粵語' },
  { code: 'zh', name: 'Chinese', nativeName: '中文' },
];

/**
 * The codes Whisper accepts, derived rather than typed out a second time.
 *
 * A hand-maintained parallel list is exactly the kind of thing that drifts by
 * one entry and then silently rejects a language the picker still offers.
 */
export const WHISPER_LANGUAGES: readonly string[] = LANGUAGES.map((l) => l.code);

/**
 * The 25 languages NVIDIA trained Parakeet TDT 0.6B v3 on.
 *
 * `models.ts` carries its own copy on each Parakeet entry, because that field
 * is per-model and a v4 with a different set is a question of when, not if.
 * This constant is the v3 fact itself — what the picker warns against, and what
 * `scripts/` can assert the two model entries still agree with.
 */
export const PARAKEET_V3_LANGUAGES: readonly string[] = [
  'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu',
  'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk',
];

/**
 * Everything that is not a code in our table but arrives meaning one.
 *
 * The keys are already folded (lowercase, unaccented); `fold()` puts the input
 * into the same shape before looking anything up.
 */
const ALIASES: Readonly<Record<string, string>> = {
  // ISO-639-3 / 639-2/T, because ElevenLabs Scribe answers in three letters:
  // its `language_code` for an English file is `eng`, not `en`.
  afr: 'af', amh: 'am', ara: 'ar', asm: 'as', aze: 'az', bak: 'ba', bel: 'be',
  bul: 'bg', ben: 'bn', bod: 'bo', bre: 'br', bos: 'bs', cat: 'ca', ces: 'cs',
  cym: 'cy', dan: 'da', deu: 'de', ell: 'el', eng: 'en', spa: 'es', est: 'et',
  eus: 'eu', fas: 'fa', fin: 'fi', fao: 'fo', fra: 'fr', glg: 'gl', guj: 'gu',
  hau: 'ha', heb: 'he', hin: 'hi', hrv: 'hr', hat: 'ht', hun: 'hu', hye: 'hy',
  ind: 'id', isl: 'is', ita: 'it', jpn: 'ja', jav: 'jw', kat: 'ka', kaz: 'kk',
  khm: 'km', kan: 'kn', kor: 'ko', lat: 'la', ltz: 'lb', lin: 'ln', lao: 'lo',
  lit: 'lt', lav: 'lv', mlg: 'mg', mri: 'mi', mkd: 'mk', mal: 'ml', mon: 'mn',
  mar: 'mr', msa: 'ms', mlt: 'mt', mya: 'my', nep: 'ne', nld: 'nl', nno: 'nn',
  nor: 'no', oci: 'oc', pan: 'pa', pol: 'pl', pus: 'ps', por: 'pt', ron: 'ro',
  rus: 'ru', san: 'sa', snd: 'sd', sin: 'si', slk: 'sk', slv: 'sl', sna: 'sn',
  som: 'so', sqi: 'sq', srp: 'sr', sun: 'su', swe: 'sv', swa: 'sw', tam: 'ta',
  tel: 'te', tgk: 'tg', tha: 'th', tuk: 'tk', tgl: 'tl', tur: 'tr', tat: 'tt',
  ukr: 'uk', urd: 'ur', uzb: 'uz', vie: 'vi', yid: 'yi', yor: 'yo', zho: 'zh',

  // ISO-639-2/B, the bibliographic set, where it differs from /T. Nothing we
  // talk to is documented as using it, but it costs twenty entries to be right
  // about `ger` and `chi` instead of returning null on them.
  tib: 'bo', cze: 'cs', wel: 'cy', ger: 'de', gre: 'el', baq: 'eu', per: 'fa',
  fre: 'fr', arm: 'hy', ice: 'is', geo: 'ka', mao: 'mi', mac: 'mk', may: 'ms',
  bur: 'my', dut: 'nl', rum: 'ro', slo: 'sk', alb: 'sq', chi: 'zh',

  // Two-letter codes that are correct ISO and simply are not the spelling
  // Whisper's tokenizer settled on, plus the three codes ISO renamed in 1989
  // that Java and older tooling still emit (`iw`, `in`, `ji`).
  jv: 'jw', iw: 'he', in: 'id', ji: 'yi', nb: 'no', nob: 'no', bokmal: 'no',
  mo: 'ro', fil: 'tl',

  // Cantonese is the one tag stripping a subtag gets wrong: `zh-yue` would fall
  // back to `zh` and decode as Mandarin, which is a different transcript.
  'zh-yue': 'yue', 'yue-hant': 'yue', cantonese: 'yue',

  // Alternate English names. Whisper's own `TO_LANGUAGE_CODE` accepts these, so
  // anything that echoes a user-supplied language string back at us can too.
  myanmar: 'my', burmese: 'my', nynorsk: 'nn', farsi: 'fa', valencian: 'ca',
  flemish: 'nl', haitian: 'ht', letzeburgesch: 'lb', pushto: 'ps',
  panjabi: 'pa', moldavian: 'ro', moldovan: 'ro', sinhalese: 'si',
  castilian: 'es', mandarin: 'zh', 'modern greek': 'el', filipino: 'tl',
};

/**
 * The strings that mean "no language chosen".
 *
 * `null` is this app's own spelling of that (`Settings.language` is
 * `string | null`), but `auto` reaches us from two directions: it is the value
 * whisper.cpp's `-l` flag takes, and it is what a settings file written by an
 * earlier build of this app may still contain. `und` is ISO's undetermined tag,
 * which a provider is entitled to return when detection fails.
 */
const AUTO_TOKENS: ReadonlySet<string> = new Set(['', 'auto', 'detect', 'und', 'unknown', 'none']);

/**
 * Lowercase, strip Latin accents, collapse whitespace.
 *
 * The accent strip is what makes `maori` find `Māori` without a hand-written
 * alias for every name carrying a diacritic. The range is the combining
 * diacritical marks block only, so decomposing a Devanagari or Arabic string
 * leaves it untouched — those names are never lookup keys anyway, but a fold
 * that quietly mutilated them would be a trap for whoever extends this later.
 */
function fold(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

const BY_CODE: ReadonlyMap<string, Language> = new Map(LANGUAGES.map((l) => [l.code, l]));

/** Folded key -> code. Codes and names first, aliases only where they do not collide. */
const BY_KEY: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  // Codes win over names, and names over aliases, so no alias can ever shadow a
  // real code — `no` stays Norwegian even though it also reads as a word.
  //
  // `nativeName` is deliberately not a key. Nothing on the wire ever answers in
  // an endonym, so the entries could never be exercised, and keying them would
  // quietly make a display string load-bearing: renaming "Te Reo Māori" to
  // "Māori" in the picker would then change what `normalizeLanguageCode`
  // parses. Display text has to stay free to change.
  for (const language of LANGUAGES) map.set(fold(language.code), language.code);
  for (const language of LANGUAGES) {
    const key = fold(language.name);
    if (!map.has(key)) map.set(key, language.code);
  }
  for (const [alias, code] of Object.entries(ALIASES)) {
    const key = fold(alias);
    if (!map.has(key)) map.set(key, code);
  }
  return map;
})();

/**
 * Exact lookup by code, case-insensitive and nothing more.
 *
 * Deliberately unforgiving: this is the question a settings validator asks —
 * "is this one of ours" — and answering `en` for `eng` there would let a code
 * we never sent to any engine survive a round trip through disk.
 * `normalizeLanguageCode` is the forgiving one.
 */
export function findLanguage(code: string): Language | undefined {
  return BY_CODE.get(fold(code));
}

/**
 * What to put in front of a person.
 *
 * Falls through the forgiving path before giving up, because the code shown in
 * the job list is whatever the engine reported: Deepgram says `en-US`, and
 * "en-US" in the UI where every other row says "English" reads like a bug.
 * An unknown tag is echoed rather than replaced by "Unknown" — if some future
 * model reports `sah`, the tag itself is the only useful thing we can say.
 */
export function languageName(code: string | null): string {
  if (code === null) return 'Detect automatically';
  const direct = findLanguage(code);
  if (direct !== undefined) return direct.name;
  const normalized = normalizeLanguageCode(code);
  if (normalized === null) return code;
  return BY_CODE.get(normalized)?.name ?? code;
}

/**
 * Anything a provider or a config file might call a language, reduced to one of
 * our codes. `null` when it means "detect" or when we simply do not recognize it.
 *
 * This function exists because of DeepInfra. Its OpenAI-compatible endpoint
 * returns Whisper's *English name* in the `language` field — a Norwegian file
 * comes back as `"norwegian"`, an English one as `"english"` — where every
 * other provider returns a code. Storing that string in `Transcript.language`
 * would put `"english"` in the exported JSON header next to `"en"` from the
 * local engine, and the UI would show both. So every adapter normalizes what it
 * receives, here, once.
 *
 * The rest of the input space falls out of the same three steps: Deepgram's
 * `en-US` and `pt-BR` lose their region subtag (the app does not distinguish
 * variants — the picker stores a base code and every engine we drive accepts
 * one), ElevenLabs' `eng` resolves through the alias table, and a human-typed
 * "English" or "  ENGLISH " folds onto the same key.
 */
export function normalizeLanguageCode(input: string): string | null {
  const folded = fold(input.replace(/_/g, '-'));
  if (AUTO_TOKENS.has(folded)) return null;

  // Whole string first: multi-word names ("haitian creole") and the tags whose
  // meaning lives in the subtag ("zh-yue") only resolve before it is cut.
  const whole = BY_KEY.get(folded);
  if (whole !== undefined) return whole;

  // Then the primary subtag. Splitting on non-alphanumerics rather than on `-`
  // alone also handles the shapes a locale takes elsewhere: `en_US.UTF-8`,
  // `English (United States)`, `spanish; castilian`.
  const primary = folded.split(/[^a-z0-9]+/)[0];
  if (primary === undefined || primary.length === 0) return null;
  if (AUTO_TOKENS.has(primary)) return null;
  return BY_KEY.get(primary) ?? null;
}

/**
 * Whether a model with a fixed language list can be expected to handle a code.
 *
 * `modelLanguages` is `LocalModel.languages` straight out of `models.ts`, where
 * `null` means the model detects for itself across everything it knows — the
 * Whisper entries — and only Parakeet carries an actual list.
 *
 * A `null` code is auto-detect and always passes: a model with a fixed list
 * still detects within that list, and warning before we know what the audio is
 * would fire on every job. An unrecognizable code fails instead, because the
 * caller is a pre-flight warning and a code no engine accepts is precisely the
 * case worth warning about.
 */
export function supportsLanguage(modelLanguages: readonly string[] | null, code: string | null): boolean {
  if (modelLanguages === null) return true;
  if (code === null) return true;

  const wanted = normalizeLanguageCode(code);
  // `normalizeLanguageCode` flattens "auto" and junk to the same `null`, and
  // those two deserve opposite answers — so ask which one it was.
  if (wanted === null) return AUTO_TOKENS.has(fold(code));

  // The model list is normalized too rather than compared raw: it comes from a
  // catalogue a human edits, and `HR` or `nb` in it should still match.
  return modelLanguages.some((entry) => normalizeLanguageCode(entry) === wanted);
}
