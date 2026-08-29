/**
 * DeepInfra, through its OpenAI-compatible transcription endpoint.
 *
 * DeepInfra offers two ways in: a native `/v1/inference/{model}` route and an
 * OpenAI-shaped `/v1/openai/audio/transcriptions` route. The native one is
 * richer — it exposes `task=translate`, `initial_prompt`, `chunk_level` and a
 * per-request billed `cost` — and it is still the wrong choice here. The
 * OpenAI-shaped route is the one DeepInfra's own model docs use, the one every
 * client library targets, and the one whose response shape is documented in the
 * published OpenAPI spec. Being boring is worth more than `initial_prompt`.
 *
 * Three DeepInfra-specific traps are load-bearing in this file, each commented
 * where it bites:
 *   1. An `Authorization` header WITHOUT the literal `Bearer ` prefix is
 *      treated as no auth at all, and the model endpoint happily answers 200.
 *   2. `GET /v1/openai/models` answers 200 with no header whatsoever, so it
 *      cannot validate a key unless the header is provably well formed.
 *   3. Without `response_format=verbose_json` the transcription route returns
 *      `{ text }` and nothing else — no timings, no language, no segments.
 */

import { basename } from 'node:path';

import type { KeyTestResult, ProviderModel } from '../shared/providers';
import type { Segment, Transcript, Word } from '../shared/transcript';
import { normalizeTranscript } from '../shared/transcript';
import { abortableFetch, assertOk, fileToBlob, ProviderError, readErrorMessage } from './types';
import type { CloudContext, CloudRequest, ProviderAdapter } from './types';

const LABEL = 'DeepInfra';

const API = 'https://api.deepinfra.com';
/**
 * Key validation. Cheap, free, and unauthenticated-readable — see `testKey`
 * for why that last property makes it dangerous rather than convenient.
 */
const OPENAI_MODELS_URL = `${API}/v1/openai/models`;
/**
 * The native catalogue. Richer than `/v1/openai/models`: it carries `type`,
 * `deprecated` and a `pricing` block with a real per-second rate, which the
 * OpenAI-shaped listing does not expose in a documented form.
 */
const MODELS_LIST_URL = `${API}/models/list`;
const TRANSCRIBE_URL = `${API}/v1/openai/audio/transcriptions`;

/** DeepInfra's own task-type tag for speech recognition. Filtered client-side. */
const ASR_TYPE = 'automatic-speech-recognition';

/**
 * Models pinned to the top of the picker, best first.
 *
 * turbo leads because it is the one a user should reach for by default: it is
 * the cheapest Whisper on the platform and the fastest, at an accuracy loss
 * most people cannot hear. Everything not listed here sorts by price.
 */
const PREFERRED_MODEL_IDS: readonly string[] = [
  'openai/whisper-large-v3-turbo',
  'openai/whisper-large-v3',
];

// ── Auth ──────────────────────────────────────────────────────────────────

/**
 * THE DEEPINFRA TRAP, AND IT IS A SILENT ONE.
 *
 * `Authorization: <key>` — the header without the literal `Bearer ` prefix —
 * is not rejected by DeepInfra. It is treated as if no `Authorization` header
 * had been sent at all. On `GET /v1/openai/models` that means HTTP 200 and the
 * full catalogue, which is exactly what a valid key returns. A key-checking
 * function that builds the header wrong therefore reports EVERY key as valid,
 * including an empty string, and the user only finds out when their first real
 * transcription 401s ten minutes later.
 *
 * So the header is built in exactly one place, it is asserted before it is
 * used, and no caller in this file is allowed to hand-roll the string.
 *
 * The same care covers two paste accidents that produce a header that looks
 * fine and fails obscurely: a key copied together with the word "Bearer" (which
 * would send `Bearer Bearer xyz`), and a key copied with a trailing newline
 * (which makes `fetch` throw a bare `TypeError` about an invalid header value).
 */
function checkKey(rawKey: string): { ok: true; header: string } | { ok: false; message: string } {
  let key = rawKey.trim();

  // A dashboard "copy" button often takes the whole curl snippet's header value
  // with it. Stripping the scheme is friendlier than a 401 the user cannot read.
  const prefix = /^bearer\s+/i.exec(key);
  if (prefix !== null) key = key.slice(prefix[0].length).trim();

  if (key.length === 0) {
    return { ok: false, message: 'Enter your DeepInfra API key first.' };
  }
  if (/\s/.test(key)) {
    return { ok: false, message: 'That key contains a space or a line break. Copy it again without surrounding text.' };
  }
  // Header values must be printable ASCII. Smart quotes and non-breaking spaces
  // arrive routinely from a key pasted out of a chat app or a PDF.
  if (!/^[\x21-\x7e]+$/.test(key)) {
    return { ok: false, message: 'That key contains characters an HTTP header cannot carry. Copy it again as plain text.' };
  }

  const header = `Bearer ${key}`;
  // The assertion the whole comment above exists for. It can only fail if
  // someone edits the line above it, which is precisely when it should fail.
  if (!header.startsWith('Bearer ') || header.length <= 'Bearer '.length) {
    return { ok: false, message: 'Internal error building the DeepInfra authorization header.' };
  }
  return { ok: true, header };
}

/** The transcribe path wants an exception, not a result object. */
function authorizationOrThrow(rawKey: string): string {
  const checked = checkKey(rawKey);
  if (!checked.ok) throw new Error(checked.message);
  return checked.header;
}

// ── testKey ───────────────────────────────────────────────────────────────

async function testKey(apiKey: string, signal: AbortSignal): Promise<KeyTestResult> {
  const checked = checkKey(apiKey);
  // Rejected BEFORE any request. `GET /v1/openai/models` answers 200 to an
  // anonymous caller, so an empty or malformed key that reached the network
  // would come back looking valid. There is no server-side check to fall back
  // on here — this branch is the check.
  if (!checked.ok) return { ok: false, message: checked.message };

  try {
    const response = await abortableFetch(
      OPENAI_MODELS_URL,
      { method: 'GET', headers: { Authorization: checked.header, Accept: 'application/json' } },
      signal,
    );

    if (response.status === 401 || response.status === 403) {
      const detail = readErrorMessage(await jsonBody(response));
      return {
        ok: false,
        message: detail !== null
          ? `DeepInfra rejected this key: ${detail}`
          : 'DeepInfra rejected this key. Check that it was copied in full and has not been revoked.',
      };
    }

    if (!response.ok) {
      const detail = readErrorMessage(await jsonBody(response));
      return {
        ok: false,
        message: detail !== null
          ? `DeepInfra returned HTTP ${response.status}: ${detail}`
          : `DeepInfra returned HTTP ${response.status}. Try again in a moment.`,
      };
    }

    // A 200 is necessary but not sufficient. A hotel captive portal answers 200
    // to everything with a login page, and "your key works" is the last thing
    // that should be said in that situation — so the body has to look like the
    // catalogue before the key is called good.
    const body = await jsonBody(response);
    if (!isRecord(body) || !Array.isArray(body['data'])) {
      return {
        ok: false,
        message: 'The response did not come from DeepInfra. Check whether a network login page is intercepting requests.',
      };
    }

    // Second round trip, and worth it: the picker is populated the instant the
    // key checks out instead of after a separate refresh. It is unauthenticated
    // and free, and a failure here says nothing about the key — hence the
    // swallowed error and the still-successful result.
    let models: ProviderModel[] = [];
    try {
      models = await listModels(apiKey, signal);
    } catch {
      models = [];
    }

    return {
      ok: true,
      message: models.length > 0
        ? `Key accepted. ${models.length} speech-to-text ${models.length === 1 ? 'model' : 'models'} available.`
        : 'Key accepted.',
      ...(models.length > 0 ? { models } : {}),
    };
  } catch (error) {
    // `testKey` is wired to a button, so it never throws: cancellation and a
    // dead network are both just a sentence under the key field.
    if (signal.aborted) return { ok: false, message: 'The connection test was cancelled.' };
    return { ok: false, message: messageOf(error, 'Could not reach DeepInfra.') };
  }
}

// ── listModels ────────────────────────────────────────────────────────────

/**
 * The catalogue, filtered down to usable speech models.
 *
 * The key is deliberately NOT sent. `/models/list` is public and returns the
 * identical catalogue with or without it, and rule 6 is easier to keep when a
 * secret simply never enters a code path. It also means the model picker works
 * before the user has pasted anything, which is when they most want to look at
 * the prices.
 *
 * All filtering is client-side because DeepInfra's query parameters silently do
 * nothing: `?type=automatic-speech-recognition` returns all ~368 models, not
 * the 7 speech ones. Sending it would look like it worked and quietly offer the
 * user an image model to transcribe with.
 */
async function listModels(_apiKey: string, signal: AbortSignal): Promise<ProviderModel[]> {
  const response = await abortableFetch(
    MODELS_LIST_URL,
    { method: 'GET', headers: { Accept: 'application/json' } },
    signal,
  );
  await assertOk(response, LABEL);

  const body = await jsonBody(response);
  if (!Array.isArray(body)) {
    throw new Error('DeepInfra returned an unexpected model list.');
  }

  const models: ProviderModel[] = [];
  for (const entry of body) {
    if (!isRecord(entry)) continue;
    if (entry['type'] !== ASR_TYPE) continue;
    // `deprecated` is a timestamp when set and `null` otherwise — the seven
    // retired Whisper variants all carry one, and all of them now redirect to
    // whisper-large-v3, so offering them would bill a model the user did not
    // pick. Truthiness is the right test: any value here means retired.
    if (entry['deprecated'] !== undefined && entry['deprecated'] !== null && entry['deprecated'] !== false) continue;

    const id = entry['model_name'];
    if (typeof id !== 'string' || id.length === 0) continue;

    const price = pricePerMinute(entry['pricing']);
    const description = firstSentence(entry['description']);

    models.push({
      id,
      label: prettyModelLabel(id),
      ...(description !== null ? { description } : {}),
      // Every current DeepInfra speech model detects its own language; none of
      // them is restricted to a fixed set, so `null` is the honest answer.
      languages: null,
      ...(price !== null ? { pricePerMinuteUsd: price } : {}),
      capabilities: {
        // The OpenAI-compatible route accepts `timestamp_granularities[]=word`
        // for all of them at no extra cost beyond a little latency.
        wordTimestamps: true,
        // DeepInfra has no diarization on any speech model, and this endpoint
        // has no `task=translate` field. Stated as explicit `false` rather than
        // omitted so the UI greys the toggles instead of offering options that
        // would be silently dropped.
        diarization: false,
        translate: false,
      },
    });
  }

  models.sort(byPreferenceThenPrice);
  return models;
}

function byPreferenceThenPrice(a: ProviderModel, b: ProviderModel): number {
  const rankA = PREFERRED_MODEL_IDS.indexOf(a.id);
  const rankB = PREFERRED_MODEL_IDS.indexOf(b.id);
  const orderA = rankA === -1 ? PREFERRED_MODEL_IDS.length : rankA;
  const orderB = rankB === -1 ? PREFERRED_MODEL_IDS.length : rankB;
  if (orderA !== orderB) return orderA - orderB;
  const priceA = a.pricePerMinuteUsd ?? Number.POSITIVE_INFINITY;
  const priceB = b.pricePerMinuteUsd ?? Number.POSITIVE_INFINITY;
  if (priceA !== priceB) return priceA - priceB;
  return a.id.localeCompare(b.id);
}

/**
 * `pricing.cents_per_input_sec` → USD per minute.
 *
 * Two unit conversions in one expression, which is why it gets a function:
 * cents to dollars and seconds to minutes. `0.000333 cents/s` is
 * `0.000333 × 60 ÷ 100 = $0.0002/min`. The rounding to six decimals exists only
 * to stop float noise from printing `$0.00019980000000000002` in the picker.
 */
function pricePerMinute(pricing: unknown): number | null {
  if (!isRecord(pricing)) return null;
  const centsPerSecond = pricing['cents_per_input_sec'];
  if (typeof centsPerSecond !== 'number' || !Number.isFinite(centsPerSecond) || centsPerSecond < 0) return null;
  return Math.round((centsPerSecond * 60) / 100 * 1e6) / 1e6;
}

/** `openai/whisper-large-v3-turbo` → `Whisper large-v3-turbo`. */
function prettyModelLabel(modelId: string): string {
  const slash = modelId.lastIndexOf('/');
  const tail = slash === -1 ? modelId : modelId.slice(slash + 1);
  if (tail.startsWith('whisper-')) return `Whisper ${tail.slice('whisper-'.length)}`;
  return tail;
}

// ── transcribe ────────────────────────────────────────────────────────────

async function transcribe(request: CloudRequest, ctx: CloudContext): Promise<Transcript> {
  const authorization = authorizationOrThrow(request.apiKey);

  // Reported before the file is read, not after: on a large upload the read and
  // the POST are one continuous wait from the user's side, and leaving the
  // previous stage's caption on screen through it looks like a stall.
  ctx.onProgress(null, 'Uploading audio');

  const form = new FormData();
  // The queue has already turned whatever was dropped into a small Opus file;
  // the real basename goes along so DeepInfra sees a `.ogg` extension matching
  // the blob's MIME type. Several of these APIs sniff the name before the bytes.
  form.append('file', await fileToBlob(request.filePath), basename(request.filePath));
  form.append('model', request.modelId);
  // Without this the response is `{ "text": "..." }` and nothing else — no
  // segments, no language, no duration. Everything below depends on it.
  form.append('response_format', 'verbose_json');
  // The literal square brackets are not a typo and not PHP-style array syntax
  // this client invented. DeepInfra's own examples send
  // `-F "timestamp_granularities[]=segment"`, and the bare name is ignored,
  // which costs you every timestamp in the response.
  form.append('timestamp_granularities[]', 'segment');
  if (request.options.wordTimestamps) form.append('timestamp_granularities[]', 'word');
  // Sent only when the user pinned a language. An empty or null `language`
  // field is not the same as an absent one: absent means "detect", and
  // detection is what makes a mixed-language drop folder work at all.
  const language = request.options.language;
  if (language !== null && language.trim().length > 0) form.append('language', language.trim());

  // `options.diarize` and `options.translate` are honoured by other providers
  // and cannot be honoured here — this endpoint has neither. `listModels`
  // reports both capabilities as false so the UI can say so; dropping them
  // silently at this point is the least-bad remaining behaviour, and it is
  // better than failing a job over a global toggle the user set for Deepgram.

  const response = await abortableFetch(
    TRANSCRIBE_URL,
    {
      method: 'POST',
      // No `Content-Type`. `fetch` derives `multipart/form-data` AND the
      // boundary from the FormData body; setting it by hand omits the boundary
      // and the server rejects every field as missing.
      headers: { Authorization: authorization, Accept: 'application/json' },
      body: form,
    },
    ctx.signal,
  );

  // DeepInfra documents no maximum upload size anywhere — not in the OpenAPI
  // spec, not in the model docs. Since the limit cannot be checked before
  // sending, the only honest handling is to catch the rejection and say
  // something the user can act on. The file was already compressed to ~12 kbps
  // Opus on the way here, so "compress it" is not available as advice.
  if (response.status === 413) {
    throw new ProviderError(
      'DeepInfra refused the upload as too large. Split the recording into shorter parts, or transcribe it with a local model instead.',
      413,
      false,
    );
  }
  await assertOk(response, LABEL);

  ctx.onProgress(null, 'Reading transcript');
  const body = await jsonBody(response);
  if (!isRecord(body)) throw new Error('DeepInfra returned a transcript this app could not read.');

  return normalizeTranscript(buildTranscript(body, request));
}

function buildTranscript(body: Record<string, unknown>, request: CloudRequest): Transcript {
  const fullText = typeof body['text'] === 'string' ? body['text'] : '';

  // ONE conversion from float seconds to integer milliseconds, here, for both
  // segments and words. Everything downstream of this function is integer ms.
  const segments: Segment[] = [];
  const rawSegments = body['segments'];
  if (Array.isArray(rawSegments)) {
    for (const raw of rawSegments) {
      if (!isRecord(raw)) continue;
      const text = typeof raw['text'] === 'string' ? raw['text'] : '';
      const startMs = toMs(raw['start']);
      const endMs = toMs(raw['end']);
      if (startMs === null || endMs === null) continue;
      segments.push({ startMs, endMs, text, words: [] });
    }
  }

  const words: Word[] = [];
  const rawWords = body['words'];
  if (Array.isArray(rawWords)) {
    for (const raw of rawWords) {
      if (!isRecord(raw)) continue;
      // The OpenAI-compatible variant calls the field `word`; DeepInfra's
      // native variant calls it `text`. Reading both costs one `??` and makes
      // this function survive a switch of endpoints.
      const value = raw['word'] ?? raw['text'];
      if (typeof value !== 'string' || value.trim().length === 0) continue;
      const startMs = toMs(raw['start']);
      const endMs = toMs(raw['end']);
      if (startMs === null || endMs === null) continue;
      words.push({ text: value, startMs, endMs });
    }
  }

  // A response with text but no segments is what you get when `verbose_json`
  // was refused or the model returned a single block. Keeping the text as one
  // whole-file segment loses the timings but never loses the transcript, and
  // the exporters all degrade gracefully to a single cue.
  const durationMs = resolveDurationMs(body, request, segments);
  if (segments.length === 0 && fullText.trim().length > 0) {
    segments.push({ startMs: 0, endMs: durationMs, text: fullText, words: [] });
  }

  attachWords(segments, words);

  const languageCode = toIsoCode(body['language']);
  const label = `${prettyModelLabel(request.modelId)} · ${LABEL}`;

  return {
    language: languageCode,
    durationMs,
    segments,
    source: { kind: 'cloud', engineId: 'deepinfra', modelId: request.modelId, label },
    createdAt: new Date().toISOString(),
  };
}

/**
 * ffprobe's duration wins over the provider's.
 *
 * `duration` in the response is what the model saw after DeepInfra decoded the
 * upload, and it drifts by a frame or two from the container's own length.
 * `Transcript.durationMs` is documented as the measured duration, and cue
 * clamping in `normalizeTranscript` uses it — so a provider's number is only a
 * fallback for the case where probing failed and the queue passed 0.
 */
function resolveDurationMs(body: Record<string, unknown>, request: CloudRequest, segments: Segment[]): number {
  if (request.durationMs > 0) return Math.round(request.durationMs);
  const reported = toMs(body['duration']);
  if (reported !== null && reported > 0) return reported;
  return segments.reduce((max, segment) => Math.max(max, segment.endMs), 0);
}

/**
 * Fold the flat `words` array into the segments it belongs to.
 *
 * DeepInfra returns words at the top level, not nested under their segment, so
 * the association has to be reconstructed. Both arrays are in time order, which
 * makes one forward pass enough. A word is placed by its MIDPOINT rather than
 * its start because Whisper routinely emits a first word starting a few tens of
 * milliseconds before its own segment's start — matching on the start would
 * push that word into the previous segment and read as an off-by-one error in
 * every subtitle file.
 */
function attachWords(segments: Segment[], words: Word[]): void {
  if (segments.length === 0 || words.length === 0) return;
  let index = 0;
  for (const word of words) {
    const midpoint = (word.startMs + word.endMs) / 2;
    while (index < segments.length - 1) {
      const current = segments[index];
      if (current === undefined || midpoint < current.endMs) break;
      index += 1;
    }
    const target = segments[index];
    if (target === undefined) return;
    target.words.push(word);
  }
}

// ── Language names ────────────────────────────────────────────────────────

/**
 * Whisper's own code → name table, verbatim.
 *
 * This exists because the OpenAI-compatible response reports `language` as a
 * full English NAME — `"english"`, `"bulgarian"` — while `Transcript.language`
 * is documented as ISO-639-1 and every exporter, and the `language` field of a
 * WebVTT file, expects a code. DeepInfra's native endpoint returns the code
 * directly; this one does not.
 *
 * The table is stored code → name and inverted below rather than written out as
 * name → code, because this direction is the one that can be checked against
 * whisper's `LANGUAGES` dict line by line when a new language appears.
 */
const WHISPER_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: 'english', zh: 'chinese', de: 'german', es: 'spanish', ru: 'russian',
  ko: 'korean', fr: 'french', ja: 'japanese', pt: 'portuguese', tr: 'turkish',
  pl: 'polish', ca: 'catalan', nl: 'dutch', ar: 'arabic', sv: 'swedish',
  it: 'italian', id: 'indonesian', hi: 'hindi', fi: 'finnish', vi: 'vietnamese',
  he: 'hebrew', uk: 'ukrainian', el: 'greek', ms: 'malay', cs: 'czech',
  ro: 'romanian', da: 'danish', hu: 'hungarian', ta: 'tamil', no: 'norwegian',
  th: 'thai', ur: 'urdu', hr: 'croatian', bg: 'bulgarian', lt: 'lithuanian',
  la: 'latin', mi: 'maori', ml: 'malayalam', cy: 'welsh', sk: 'slovak',
  te: 'telugu', fa: 'persian', lv: 'latvian', bn: 'bengali', sr: 'serbian',
  az: 'azerbaijani', sl: 'slovenian', kn: 'kannada', et: 'estonian',
  mk: 'macedonian', br: 'breton', eu: 'basque', is: 'icelandic', hy: 'armenian',
  ne: 'nepali', mn: 'mongolian', bs: 'bosnian', kk: 'kazakh', sq: 'albanian',
  sw: 'swahili', gl: 'galician', mr: 'marathi', pa: 'punjabi', si: 'sinhala',
  km: 'khmer', sn: 'shona', yo: 'yoruba', so: 'somali', af: 'afrikaans',
  oc: 'occitan', ka: 'georgian', be: 'belarusian', tg: 'tajik', sd: 'sindhi',
  gu: 'gujarati', am: 'amharic', yi: 'yiddish', lo: 'lao', uz: 'uzbek',
  fo: 'faroese', ht: 'haitian creole', ps: 'pashto', tk: 'turkmen',
  nn: 'nynorsk', mt: 'maltese', sa: 'sanskrit', lb: 'luxembourgish',
  my: 'myanmar', bo: 'tibetan', tl: 'tagalog', mg: 'malagasy', as: 'assamese',
  tt: 'tatar', haw: 'hawaiian', ln: 'lingala', ha: 'hausa', ba: 'bashkir',
  jw: 'javanese', su: 'sundanese', yue: 'cantonese',
};

/**
 * The alternate names whisper accepts for the same code.
 *
 * Whisper's `TO_LANGUAGE_CODE` carries these aliases, and which of the two
 * spellings a given model emits is not something we control — `burmese` and
 * `myanmar` are the same language and only one of them is in the table above.
 */
const LANGUAGE_NAME_ALIASES: Readonly<Record<string, string>> = {
  burmese: 'my', valencian: 'ca', flemish: 'nl', haitian: 'ht',
  letzeburgesch: 'lb', pushto: 'ps', panjabi: 'pa', moldavian: 'ro',
  moldovan: 'ro', sinhalese: 'si', castilian: 'es', mandarin: 'zh',
  'mandarin chinese': 'zh', 'modern greek': 'el', 'norwegian bokmal': 'no',
  'norwegian nynorsk': 'nn', bokmal: 'no', farsi: 'fa', filipino: 'tl',
};

const NAME_TO_CODE: Readonly<Record<string, string>> = (() => {
  const table: Record<string, string> = {};
  for (const [code, name] of Object.entries(WHISPER_LANGUAGE_NAMES)) table[name] = code;
  for (const [name, code] of Object.entries(LANGUAGE_NAME_ALIASES)) table[name] = code;
  return table;
})();

/**
 * `"English"` → `"en"`. `"en"` → `"en"`. Anything unrecognized → `null`.
 *
 * The `null` is deliberate and is the rule from `transcript.ts`: a language we
 * were not told is not `"und"` and is not a guess. A wrong `language` tag on an
 * exported VTT is worse than a missing one, because a player will act on it.
 */
function toIsoCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (raw.length === 0) return null;

  // Already a code — the native endpoint and some models answer this way, and
  // the same function has to cope with both.
  if (Object.prototype.hasOwnProperty.call(WHISPER_LANGUAGE_NAMES, raw)) return raw;

  const direct = NAME_TO_CODE[raw];
  if (direct !== undefined) return direct;

  // `"chinese (simplified)"` and friends: drop a parenthesized qualifier and
  // try the bare name once before giving up.
  const bare = raw.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  if (bare !== raw && bare.length > 0) {
    const viaBare = NAME_TO_CODE[bare];
    if (viaBare !== undefined) return viaBare;
  }
  return null;
}

// ── Small shared internals ────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Float seconds → integer ms, or `null` for anything that is not a number. */
function toMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 1000);
}

/**
 * Read a body once, as text, and parse it if it happens to be JSON.
 *
 * `response.json()` would throw on the HTML a proxy or a captive portal
 * returns, turning a diagnosable situation into a `SyntaxError` in the job list.
 */
async function jsonBody(response: Response): Promise<unknown> {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    return null;
  }
  if (raw.trim().length === 0) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** The catalogue's descriptions are paragraphs; the picker has one line. */
function firstSentence(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  const stop = /[.!?](\s|$)/.exec(text);
  const sentence = stop !== null ? text.slice(0, stop.index + 1) : text;
  return sentence.length <= 160 ? sentence : `${sentence.slice(0, 159)}…`;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

export const deepinfraAdapter: ProviderAdapter = {
  id: 'deepinfra',
  testKey,
  listModels,
  transcribe,
};

// Also the default export, so `providers/index.ts` can pull it in under either
// convention without a second edit to this file.
export default deepinfraAdapter;
