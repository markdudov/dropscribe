/**
 * OpenRouter — one key, many vendors' speech-to-text models.
 *
 * This adapter was written against the live API on 2026-08-29, because the
 * shape of OpenRouter's audio support has moved more than once and guessing it
 * from memory would have produced a plausible-looking adapter that never works.
 * What was actually verified, and what each fact costs us:
 *
 * 1. **There is a real transcription endpoint.** `POST /api/v1/audio/transcriptions`
 *    answers the auth middleware's `{"error":{"message":"…","code":401}}` when
 *    called without a key, exactly as `/chat/completions` and `/embeddings` do,
 *    while a route that does not exist (`/audio/translations`, `/totallyfake`)
 *    falls through to the marketing site's Next.js 404 HTML. So this is not the
 *    chat-completions `input_audio` fallback the task anticipated — OpenRouter
 *    has a first-class STT route, and it is documented at
 *    https://openrouter.ai/docs/guides/overview/multimodal/stt.
 *
 * 2. **It returns timestamps.** With `response_format: 'verbose_json'` the
 *    response carries `segments[]` (`start`/`end` in fractional seconds) and,
 *    with `timestamp_granularities: ['word']`, a `words[]` array of the same
 *    shape. That is the difference between real subtitle cues and one
 *    interpolated blob, so this adapter always asks for `verbose_json` — see
 *    `transcribe` for the catch, which is real.
 *
 * 3. **Audio goes up as base64 JSON**, not multipart: `input_audio: { data, format }`
 *    where `data` is raw base64 with no `data:` URI prefix. The multipart path
 *    exists for OpenAI-SDK compatibility and is capped at 25 MB; the JSON path
 *    is the documented one for larger files.
 *
 * The one thing that could not be established is per-minute pricing, and this
 * file deliberately reports nothing rather than a number that would be wrong
 * for most models. See `priceIsNotConvertible` below.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { formatBytes } from '../shared/models';
import type { KeyTestResult, ProviderModel } from '../shared/providers';
import { findProvider } from '../shared/providers';
import type { Segment, Transcript, Word } from '../shared/transcript';
import { normalizeTranscript } from '../shared/transcript';
import type { CloudContext, CloudRequest, ProviderAdapter } from './types';

const API_BASE = 'https://openrouter.ai/api/v1';

/**
 * Verified: `GET /api/v1/models` ignores the `Authorization` header entirely —
 * a syntactically valid but nonexistent key still gets a 200 and the full list.
 * So the model list is fetched *without* the key. That is not laziness; it
 * removes the only way this call could fail for an auth reason, which matters
 * because `listModels` runs on every settings refresh and a spurious 401 there
 * would look to the user like their key had been revoked.
 */
const MODELS_PATH = '/models?output_modalities=transcription';

/**
 * How long to wait on each kind of call.
 *
 * The transcription budget is generous because the request covers the upload of
 * up to ~23 MB *and* the model's own inference. OpenRouter's docs warn that the
 * upstream provider times out after 60 s of processing and surfaces that as a
 * 524; that is a server-side limit this timeout cannot influence, and it is
 * reported to the user as its own message rather than as a network failure.
 */
const KEY_TIMEOUT_MS = 20_000;
const MODELS_TIMEOUT_MS = 20_000;
const TRANSCRIBE_TIMEOUT_MS = 15 * 60_000;

/**
 * The largest audio file this route will be handed, measured *before* base64.
 *
 * OpenRouter documents exactly one number — 25 MB — and attaches it to the
 * multipart path, saying only that the base64 JSON path is where "larger files"
 * go without ever saying how much larger. Rather than trust an undocumented
 * ceiling, this caps the raw bytes low enough that the encoded body clears the
 * one published figure whichever side of the encoding OpenRouter measures:
 * 17 MiB of audio becomes ~23.8 MB of base64, under 25 MB by either reckoning.
 *
 * **This does bite, and the queue now encodes to fit it.** It used to be true
 * that the queue handed over 16 kHz mono Opus at about 12 kbps, which put 17 MiB
 * at roughly three and a half hours. Since bug 0002 the encoder is whatever the
 * vendored ffmpeg turns out to have, and on macOS that is AAC — a two-hour film
 * at the table's 32 kbps measures 30 MB, well over this line. The number is
 * therefore declared on the provider descriptor in `shared/providers.ts` and
 * read by `compressForUpload`, which lowers the bitrate to fit rather than
 * letting the job die here. This check stays as the backstop for what fitting
 * cannot save: audio too long for even the minimum bitrate, and anything
 * upstream that hands over an uncompressed WAV.
 */
const MAX_AUDIO_BYTES = findProvider('openrouter')?.maxUploadBytes ?? 17 * 1024 * 1024;

// ── Small narrowing helpers ────────────────────────────────────────────────
// `any` is banned, and every one of these values crossed a network boundary,
// so nothing below is trusted until it has been checked.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// ── HTTP ───────────────────────────────────────────────────────────────────

interface HttpResult {
  status: number;
  ok: boolean;
  /** Parsed JSON where the body was JSON, the raw text where it was not. */
  body: unknown;
}

/**
 * OpenRouter's app-attribution headers.
 *
 * They are optional, carry no user data, and only put DropScribe on the public
 * per-app usage leaderboard. They are included because omitting them makes
 * every DropScribe request indistinguishable from a scripted one, which is how
 * traffic ends up rate-limited more aggressively.
 */
function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://github.com/markdudov/dropscribe',
    'X-Title': 'DropScribe',
    Accept: 'application/json',
  };
}

/**
 * One request, with the caller's cancellation and a hard timeout folded together.
 *
 * `AbortSignal.any` would express this in a line, but it is missing from the
 * DOM lib this project typechecks against, so the two sources are wired by hand.
 * The `timedOut` flag exists because an `AbortError` alone cannot tell "the user
 * pressed cancel" from "the socket hung" — and those two want very different
 * things said to the user.
 */
async function httpJson(
  path: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  signal: AbortSignal,
  timeoutMs: number,
): Promise<HttpResult> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        // A non-JSON body here means we hit the marketing site's HTML 404
        // rather than the API. Keeping the text lets `errorMessageFrom` fall
        // back to the status code instead of splashing markup at the user.
        body = text;
      }
    }
    return { status: response.status, ok: response.ok, body };
  } catch (cause) {
    if (signal.aborted) throw cause instanceof Error ? cause : new Error('Cancelled.');
    if (timedOut) {
      throw new Error(`OpenRouter did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, { cause });
    }
    throw new Error('Could not reach OpenRouter. Check your internet connection.', { cause });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Every error body seen from this API is `{ error: { message, code } }`. The
 * other shapes are guarded anyway because the 400s raised by OpenRouter's own
 * request validation come back as a Zod report under `success`/`error` instead.
 */
function errorMessageFrom(body: unknown, status: number): string {
  if (isRecord(body)) {
    const error = body['error'];
    if (isRecord(error)) {
      const message = asString(error['message']);
      if (message !== undefined) return message;
      const name = asString(error['name']);
      if (name !== undefined) return name;
    }
    const message = asString(body['message']);
    if (message !== undefined) return message;
  }
  return `HTTP ${status}`;
}

// ── Key validation ─────────────────────────────────────────────────────────

/**
 * `GET /api/v1/key` is the right endpoint, and the only one that works with an
 * ordinary inference key. `GET /api/v1/credits` looks like the better source of
 * a balance but requires a *management* key, which is a different credential
 * the user has no reason to own — it answers 401 for the key they pasted, and
 * testing with it would reject perfectly good keys.
 *
 * Verified status codes: no header at all gives 401 "No cookie auth credentials
 * found"; a well-formed but unknown key gives 401 "User not found."; both as
 * JSON. There is no 403 path for a merely invalid key.
 */
async function fetchKeyInfo(apiKey: string, signal: AbortSignal): Promise<HttpResult> {
  return httpJson('/key', { method: 'GET', headers: authHeaders(apiKey) }, signal, KEY_TIMEOUT_MS);
}

/**
 * The key endpoint's `label` is whatever the user named the key, and
 * OpenRouter's own default for it is a *truncated* key like `sk-or-v1-au7...890`.
 * The truncated form is safe and useful — it is the same "which key is this"
 * hint `keyPreview()` gives. A label containing a whole key is not, and this
 * string gets persisted into settings inside `lastTest`, so anything that looks
 * like intact key material is dropped rather than shown.
 */
function safeLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  if (/sk-or-[a-z0-9]*-?[A-Za-z0-9]{24,}/i.test(label)) return undefined;
  return label;
}

/**
 * Build the one line the settings panel shows next to a working key.
 *
 * `limit` is null for keys with no cap, which is the common case for an account
 * paying from a credit balance, so the "of $X" half is dropped rather than
 * printed as "of $null". `usage` is lifetime spend on that key.
 */
function describeAccount(data: Record<string, unknown>): string | undefined {
  const parts: string[] = [];

  const label = safeLabel(asString(data['label']));
  if (label !== undefined) parts.push(label);

  const limit = asFiniteNumber(data['limit']);
  const remaining = asFiniteNumber(data['limit_remaining']);
  const usage = asFiniteNumber(data['usage']);
  if (remaining !== undefined && limit !== undefined) {
    parts.push(`${usd(remaining)} left of ${usd(limit)}`);
  } else if (remaining !== undefined) {
    parts.push(`${usd(remaining)} left`);
  } else if (usage !== undefined) {
    parts.push(`${usd(usage)} used, no key limit`);
  }

  const reset = asString(data['limit_reset']);
  if (reset !== undefined && limit !== undefined) parts.push(`resets ${reset}`);

  if (data['is_free_tier'] === true) parts.push('free tier');

  return parts.length > 0 ? parts.join(' · ') : undefined;
}

// ── Model list ─────────────────────────────────────────────────────────────

/**
 * The models this app should offer first.
 *
 * The ordering is not taste. `verbose_json` — the only way to get any timestamp
 * at all out of this route — is documented as supported by exactly three
 * upstream providers: OpenAI, Groq and Together. The Whisper family is what
 * those three serve, so those slugs are the ones that can actually produce
 * subtitle cues rather than a wall of text. Turbo leads because it is the
 * cheapest of them per minute at effectively the same word error rate; the
 * `gpt-*-transcribe` models follow because OpenAI serves them and they are
 * therefore also `verbose_json`-capable, just dearer.
 *
 * Everything else in the catalogue — Deepgram Nova-3, Chirp 3, Voxtral, the
 * Qwen and Parakeet ASR models — is real and often better and cheaper, but is
 * served by providers that reject `verbose_json` with a 400. They still work
 * here; they just come back without timestamps. They are kept, ranked below,
 * and the fallback in `transcribe` is what makes them usable at all.
 */
const PREFERRED_MODEL_ORDER: readonly string[] = [
  'openai/whisper-large-v3-turbo',
  'openai/whisper-large-v3',
  'openai/whisper-1',
  'openai/gpt-4o-transcribe',
  'openai/gpt-4o-mini-transcribe',
  'openai/gpt-transcribe',
];

/**
 * Display names, so a finished transcript can say "Whisper Large V3 Turbo"
 * rather than a slug. Filled by every `listModels`, which the app runs on key
 * test and on refresh, and topped up opportunistically by `transcribe` when the
 * process has been restarted since.
 */
const MODEL_NAMES = new Map<string, string>();

function rankOf(id: string, apiIndex: number): number {
  const preferred = PREFERRED_MODEL_ORDER.indexOf(id);
  if (preferred >= 0) return preferred;
  // Any other `openai/`-prefixed STT model is served by OpenAI itself, so it
  // speaks `verbose_json` too even if it postdates this list.
  if (id.startsWith('openai/')) return 100 + apiIndex;
  return 1000 + apiIndex;
}

/**
 * Descriptions in the catalogue run to several hundred words. The settings list
 * has room for a line, and cutting at a word boundary beats an ellipsis landing
 * mid-word.
 */
function shortDescription(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return undefined;
  if (flat.length <= 200) return flat;
  const cut = flat.slice(0, 200);
  const space = cut.lastIndexOf(' ');
  return `${(space > 120 ? cut.slice(0, space) : cut).replace(/[,;:.]$/, '')}…`;
}

/**
 * Why every model here reports no price.
 *
 * `ProviderModel.pricePerMinuteUsd` is documented as "USD, normalized to per
 * minute of audio regardless of how the vendor quotes it". For OpenRouter that
 * normalization cannot be done, and the reason is worth stating so nobody
 * "fixes" this later by multiplying `pricing.prompt` by sixty.
 *
 * STT models carry exactly two pricing keys, `prompt` and `completion`, and the
 * unit of `prompt` is not in the response. It is whatever the upstream provider
 * bills in. Three endpoints of the *same* model, `openai/whisper-large-v3`,
 * make this unmistakable — the values are 0.0000075, 0.0015 and 0.111, and
 * OpenRouter's own model page renders them as "$0.000008/second" (DeepInfra),
 * "$0.0015/minute" (Together) and "$0.111/hour" (Groq). Read as one unit they
 * would differ by a factor of fifteen thousand; read with the units the page
 * supplies they all land between $0.0005 and $0.002 a minute. OpenRouter's own
 * docs confirm the split: "STT models use different pricing strategies
 * depending on the provider" — duration-based for some, token-based for others.
 *
 * The unit lives in the web UI and nowhere in the JSON, and which endpoint a
 * request lands on is decided at routing time, so there is no per-model answer
 * to give even if the unit were known. The field is therefore omitted. The
 * response's own `usage.cost` is the truthful figure, and it is only knowable
 * after the fact.
 */
const priceIsNotConvertible = true;

async function fetchSttModels(signal: AbortSignal): Promise<ProviderModel[]> {
  const result = await httpJson(
    MODELS_PATH,
    { method: 'GET', headers: { Accept: 'application/json' } },
    signal,
    MODELS_TIMEOUT_MS,
  );
  if (!result.ok) {
    throw new Error(`OpenRouter's model list is unavailable (${errorMessageFrom(result.body, result.status)}).`);
  }
  const data = isRecord(result.body) ? result.body['data'] : undefined;
  if (!Array.isArray(data)) {
    throw new Error('OpenRouter returned a model list this version of DropScribe does not understand.');
  }

  const ranked: { model: ProviderModel; rank: number }[] = [];
  data.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const id = asString(entry['id']);
    if (id === undefined) return;

    const name = asString(entry['name']) ?? id;
    MODEL_NAMES.set(id, name);

    const description = shortDescription(asString(entry['description']));

    // `wordTimestamps: true` claims the model *can* return them, which for this
    // route means "OpenRouter may route it to a provider that accepts
    // verbose_json". It cannot be a promise: the STT endpoint's `provider`
    // object accepts only `options` passthrough — there is no `only` or `order`
    // to pin an upstream with, unlike chat completions. So a turbo request can
    // land on Groq and come back timestamped, or on DeepInfra and not.
    // Models whose providers are unknown get no claim at all rather than a
    // `false` this adapter cannot stand behind.
    const wordTimestamps = id.startsWith('openai/');

    ranked.push({
      rank: rankOf(id, index),
      model: {
        id,
        label: name,
        ...(description !== undefined ? { description } : {}),
        // Every model here does its own language identification, and the
        // catalogue does not enumerate per-model language support.
        languages: null,
        capabilities: {
          ...(wordTimestamps ? { wordTimestamps: true } : {}),
          // There is no `task` parameter on this route — unlike Whisper's own
          // API, OpenRouter's STT endpoint exposes transcription only. Nothing
          // here can translate, so the UI should not offer to.
          translate: false,
        },
        // pricePerMinuteUsd omitted on purpose — see `priceIsNotConvertible`.
      },
    });
  });

  void priceIsNotConvertible;
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.map((entry) => entry.model);
}

async function modelDisplayName(modelId: string, signal: AbortSignal): Promise<string> {
  const cached = MODEL_NAMES.get(modelId);
  if (cached !== undefined) return cached;
  try {
    await fetchSttModels(signal);
  } catch {
    // A pretty label is never worth failing a transcription the user has
    // already paid for. Fall through to the slug.
  }
  return MODEL_NAMES.get(modelId) ?? modelId;
}

// ── Audio format ───────────────────────────────────────────────────────────

/**
 * `input_audio.format` is a bare token, not a MIME type, and OpenRouter's
 * documented set is exactly this. Opus is not in it: an Opus stream in an Ogg
 * container is declared as `ogg`.
 *
 * Which container arrives is NOT fixed. `compressForUpload` picks its encoder
 * from what the vendored ffmpeg actually has, so this map has to cover every
 * one of them — see docs/bugs/0002 for the release where assuming otherwise
 * broke every cloud job on macOS.
 */
const EXTENSION_FORMATS: Readonly<Record<string, string>> = {
  '.wav': 'wav',
  '.mp3': 'mp3',
  '.flac': 'flac',
  '.m4a': 'm4a',
  '.mp4': 'm4a',
  '.ogg': 'ogg',
  '.oga': 'ogg',
  '.opus': 'ogg',
  '.webm': 'webm',
  '.aac': 'aac',
};

/**
 * Identify the container from its first bytes, falling back to the extension.
 *
 * The extension alone would be enough for the file the queue produces, but
 * OpenRouter's troubleshooting guide lists a format/`format` mismatch as the
 * first cause of a silently empty transcript — the upstream provider trusts the
 * declared format over the bytes. Sniffing costs twelve bytes of comparison and
 * removes that whole class of failure.
 */
function sniffFormat(head: Uint8Array, filePath: string): string {
  const ascii = (offset: number, length: number): string =>
    String.fromCharCode(...head.subarray(offset, offset + length));

  if (head.length >= 12) {
    if (ascii(0, 4) === 'OggS') return 'ogg';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav';
    if (ascii(0, 4) === 'fLaC') return 'flac';
    if (ascii(4, 4) === 'ftyp') return 'm4a';
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
    if (ascii(0, 3) === 'ID3') return 'mp3';

    // Raw ADTS AAC and raw MPEG audio share the 0xFF sync byte. They are told
    // apart by the layer bits: ADTS sets them to 00, every MPEG layer does not.
    const first = head[0];
    const second = head[1];
    if (first === 0xff && second !== undefined) {
      if ((second & 0xf0) === 0xf0 && (second & 0x06) === 0x00) return 'aac';
      if ((second & 0xe0) === 0xe0) return 'mp3';
    }
  }

  return EXTENSION_FORMATS[extname(filePath).toLowerCase()] ?? 'ogg';
}

// ── Language ───────────────────────────────────────────────────────────────

/**
 * `verbose_json` reports the detected language as an English *name* —
 * "english", "bulgarian" — not as a code, because that is what Whisper's own
 * verbose response has always emitted.
 *
 * `Transcript.language` wants ISO-639-1 "where the engine gives one, otherwise
 * whatever tag it reported, lowercased". This map covers Whisper's own name
 * list so the common cases land on a real code; anything unrecognised falls
 * through lowercased rather than being guessed at or discarded.
 */
const WHISPER_LANGUAGE_CODES: Readonly<Record<string, string>> = {
  afrikaans: 'af', albanian: 'sq', amharic: 'am', arabic: 'ar', armenian: 'hy',
  azerbaijani: 'az', basque: 'eu', belarusian: 'be', bengali: 'bn', bosnian: 'bs',
  bulgarian: 'bg', burmese: 'my', catalan: 'ca', chinese: 'zh', croatian: 'hr',
  czech: 'cs', danish: 'da', dutch: 'nl', english: 'en', estonian: 'et',
  finnish: 'fi', french: 'fr', galician: 'gl', georgian: 'ka', german: 'de',
  greek: 'el', gujarati: 'gu', haitian: 'ht', hausa: 'ha', hebrew: 'he',
  hindi: 'hi', hungarian: 'hu', icelandic: 'is', indonesian: 'id', italian: 'it',
  japanese: 'ja', javanese: 'jv', kannada: 'kn', kazakh: 'kk', khmer: 'km',
  korean: 'ko', lao: 'lo', latin: 'la', latvian: 'lv', lithuanian: 'lt',
  macedonian: 'mk', malay: 'ms', malayalam: 'ml', maltese: 'mt', maori: 'mi',
  marathi: 'mr', mongolian: 'mn', nepali: 'ne', norwegian: 'no', nynorsk: 'nn',
  pashto: 'ps', persian: 'fa', polish: 'pl', portuguese: 'pt', punjabi: 'pa',
  romanian: 'ro', russian: 'ru', sanskrit: 'sa', serbian: 'sr', shona: 'sn',
  sindhi: 'sd', sinhala: 'si', slovak: 'sk', slovenian: 'sl', somali: 'so',
  spanish: 'es', sundanese: 'su', swahili: 'sw', swedish: 'sv', tagalog: 'tl',
  tajik: 'tg', tamil: 'ta', tatar: 'tt', telugu: 'te', thai: 'th',
  tibetan: 'bo', turkish: 'tr', turkmen: 'tk', ukrainian: 'uk', urdu: 'ur',
  uzbek: 'uz', vietnamese: 'vi', welsh: 'cy', yiddish: 'yi', yoruba: 'yo',
};

function normalizeLanguage(reported: string | undefined): string | null {
  if (reported === undefined) return null;
  const value = reported.trim().toLowerCase();
  if (value.length === 0) return null;
  if (/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/.test(value)) return value;
  return WHISPER_LANGUAGE_CODES[value] ?? value;
}

// ── Transcript assembly ────────────────────────────────────────────────────

/**
 * Diarization arrives as `speaker`, an integer index on both segments and
 * words, "present when the provider returns diarization data". There is no
 * request switch for it on this route — `CloudOptions.diarize` cannot be
 * honoured — so whatever labels turn up are passed through and none are
 * invented.
 */
function speakerLabel(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return asString(value);
}

/** Index of the last entry at or before `value`; 0 when `value` precedes them all. */
function lastIndexAtOrBefore(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length - 1;
  let best = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const at = sorted[mid];
    if (at === undefined) break;
    if (at <= value) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function buildTranscript(body: unknown, request: CloudRequest, modelName: string): Transcript {
  const root = isRecord(body) ? body : {};
  const fullText = (asString(root['text']) ?? '').trim();

  // `start`/`end` are fractional seconds on both segments and words. This is
  // the one place they become integer milliseconds, per the transcript contract.
  const rawWords = Array.isArray(root['words']) ? root['words'] : [];
  const words: Word[] = [];
  for (const entry of rawWords) {
    if (!isRecord(entry)) continue;
    const text = asString(entry['word']);
    const start = asFiniteNumber(entry['start']);
    const end = asFiniteNumber(entry['end']);
    if (text === undefined || start === undefined || end === undefined) continue;
    const speaker = speakerLabel(entry['speaker']);
    words.push({
      text,
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
      ...(speaker !== undefined ? { speaker } : {}),
    });
  }
  words.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const rawSegments = Array.isArray(root['segments']) ? root['segments'] : [];
  const segments: Segment[] = [];
  for (const entry of rawSegments) {
    if (!isRecord(entry)) continue;
    const start = asFiniteNumber(entry['start']);
    const end = asFiniteNumber(entry['end']);
    if (start === undefined || end === undefined) continue;
    const speaker = speakerLabel(entry['speaker']);
    segments.push({
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
      text: (asString(entry['text']) ?? '').trim(),
      words: [],
      ...(speaker !== undefined ? { speaker } : {}),
    });
  }
  segments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  if (segments.length > 0) {
    // Words and segments arrive as two flat, independent arrays; nothing in the
    // response says which word belongs to which segment. They are matched on
    // the word's midpoint rather than its start, so a word straddling a segment
    // boundary lands with the segment it mostly occupies.
    const starts = segments.map((segment) => segment.startMs);
    for (const word of words) {
      const midpoint = word.startMs + Math.round((word.endMs - word.startMs) / 2);
      const target = segments[lastIndexAtOrBefore(starts, midpoint)];
      if (target !== undefined) target.words.push(word);
    }
  } else if (words.length > 0) {
    // Word timings but no segment list. One segment holding every word is
    // correct rather than lossy: `resegment()` builds cues from word timings
    // when it has them and ignores segment boundaries entirely.
    const first = words[0];
    const last = words[words.length - 1];
    segments.push({
      startMs: first?.startMs ?? 0,
      endMs: last?.endMs ?? Math.round(request.durationMs),
      text: fullText,
      words,
    });
  } else {
    // ── No timestamps at all ────────────────────────────────────────────────
    // This is the fallback path: either the model was routed to a provider that
    // rejects `verbose_json`, or it answered plain `json`. All that came back
    // is one string of text.
    //
    // Say plainly what that costs: there is NO timing information here of any
    // kind. The single segment below spans the whole file, so every subtitle
    // cue for this transcript is produced by `resegment()` interpolating cue
    // boundaries across the duration from reading speed and line length alone.
    // The words are in the right order and the cues are evenly paced, but no
    // cue boundary corresponds to anything that was actually heard. For
    // subtitling, prefer a model from `PREFERRED_MODEL_ORDER`.
    segments.push({
      startMs: 0,
      endMs: Math.round(request.durationMs),
      text: fullText,
      words: [],
    });
  }

  const language = normalizeLanguage(asString(root['language'])) ?? request.options.language ?? null;

  return normalizeTranscript({
    language,
    // Deliberately ffprobe's measurement, not the response's own `duration`
    // field, which reports what the upstream provider decoded.
    durationMs: Math.round(request.durationMs),
    segments,
    source: {
      kind: 'cloud',
      engineId: 'openrouter',
      modelId: request.modelId,
      label: `${modelName} · OpenRouter`,
    },
    createdAt: new Date().toISOString(),
  });
}

// ── Errors the user can act on ─────────────────────────────────────────────

function transcriptionError(status: number, body: unknown): Error {
  const detail = errorMessageFrom(body, status);
  switch (status) {
    case 401:
      return new Error('OpenRouter rejected the saved key. Re-enter it in Settings.');
    case 402:
      return new Error('This OpenRouter account is out of credit. Top it up at openrouter.ai/credits.');
    case 403:
      return new Error(`OpenRouter refused this request: ${detail}`);
    case 404:
      return new Error('That model is no longer offered by OpenRouter. Pick another one in Settings.');
    case 413:
      return new Error('OpenRouter rejected the audio as too large. Split the recording and try again.');
    case 429:
      return new Error('OpenRouter is rate-limiting this key. Wait a moment and retry.');
    case 502:
    case 503:
    case 529:
      return new Error(`The provider behind this model is unavailable right now (${detail}). Retry, or pick another model.`);
    case 504:
    case 524:
      // OpenRouter's documented upstream cap: providers abandon a transcription
      // after 60 seconds of processing. Nothing on this side can raise it.
      return new Error(
        'The provider gave up on this file — OpenRouter allows upstream models 60 seconds per request. Split the recording, or pick a faster model.',
      );
    default:
      return new Error(`OpenRouter could not transcribe this file: ${detail}`);
  }
}

// ── The adapter ────────────────────────────────────────────────────────────

export const openrouterAdapter: ProviderAdapter = {
  id: 'openrouter',

  async testKey(apiKey: string, signal: AbortSignal): Promise<KeyTestResult> {
    const result = await fetchKeyInfo(apiKey, signal);

    if (!result.ok) {
      if (result.status === 401) {
        return {
          ok: false,
          message: 'OpenRouter did not recognise this key. Check it was copied whole from openrouter.ai/keys.',
        };
      }
      return {
        ok: false,
        message: `OpenRouter could not verify this key: ${errorMessageFrom(result.body, result.status)}`,
      };
    }

    const data = isRecord(result.body) ? result.body['data'] : undefined;
    const account = isRecord(data) ? describeAccount(data) : undefined;

    // A management key authenticates but cannot run inference, so it would pass
    // this test and then fail on the first job. Catch it here instead.
    if (isRecord(data) && data['is_management_key'] === true) {
      return {
        ok: false,
        message: 'That is an OpenRouter management key. DropScribe needs an ordinary inference key from openrouter.ai/keys.',
        ...(account !== undefined ? { account } : {}),
      };
    }

    // The model list needs no key, so it is fetched in the same round trip to
    // populate the picker the instant the key checks out. A failure here is not
    // a failure of the key and must not be reported as one.
    let models: ProviderModel[] | undefined;
    try {
      models = await fetchSttModels(signal);
    } catch {
      models = undefined;
    }

    const count = models?.length ?? 0;
    return {
      ok: true,
      message: count > 0 ? `Key accepted. ${count} transcription models available.` : 'Key accepted.',
      ...(account !== undefined ? { account } : {}),
      ...(models !== undefined ? { models } : {}),
    };
  },

  async listModels(_apiKey: string, signal: AbortSignal): Promise<ProviderModel[]> {
    // The key is intentionally unused — see MODELS_PATH.
    return fetchSttModels(signal);
  },

  async transcribe(request: CloudRequest, ctx: CloudContext): Promise<Transcript> {
    ctx.onProgress(null, 'Reading audio');

    let audio: Buffer;
    try {
      audio = await readFile(request.filePath);
    } catch (cause) {
      const code = isRecord(cause) ? asString(cause['code']) : undefined;
      throw new Error(
        `Could not read the prepared audio for upload${code !== undefined ? ` (${code})` : ''}.`,
        { cause },
      );
    }

    if (audio.byteLength === 0) {
      throw new Error('The prepared audio is empty — there may be no audio track in this file.');
    }
    if (audio.byteLength > MAX_AUDIO_BYTES) {
      // Checked before encoding, because base64 inflates by 4/3 and the whole
      // point is to never build the oversized string in the first place.
      throw new Error(
        `This recording is too long for OpenRouter's transcription endpoint: ${formatBytes(audio.byteLength)} of compressed audio, and the limit is ${formatBytes(MAX_AUDIO_BYTES)} before base64 encoding. Split it into shorter files, or transcribe it with a local model.`,
      );
    }

    const format = sniffFormat(audio.subarray(0, 16), request.filePath);

    // Started here and awaited after the transcription so it costs no latency;
    // it only fills in a display name when this process has not listed models
    // yet. It cannot reject.
    const namePromise = modelDisplayName(request.modelId, ctx.signal);

    ctx.onProgress(null, 'Encoding audio');
    const base64 = audio.toString('base64');

    const headers = { ...authHeaders(request.apiKey), 'Content-Type': 'application/json' };
    const language = request.options.language;

    interface SttRequestBody {
      model: string;
      input_audio: { data: string; format: string };
      language?: string;
      response_format?: 'verbose_json';
      timestamp_granularities?: ('word' | 'segment')[];
    }

    const base: SttRequestBody = {
      model: request.modelId,
      input_audio: { data: base64, format },
      ...(language !== null ? { language } : {}),
      // `temperature` is deliberately not sent. Several models in this
      // catalogue — Deepgram Nova-3 and Fish Audio among them — advertise an
      // empty `supported_parameters`, and an unsupported parameter is a 400,
      // not a warning. The provider default is right for transcription anyway.
      //
      // `CloudOptions.translate` is also unhonoured: this route has no `task`
      // parameter, so translation is impossible here rather than merely
      // unrequested. `listModels` reports `translate: false` to match.
    };

    // `verbose_json` is requested even when the user has word timestamps
    // switched off, because the alternative is a response with no timing
    // information whatsoever. The toggle controls word granularity only;
    // segment timestamps are what make subtitles a subtitle file.
    const granularities: ('word' | 'segment')[] = request.options.wordTimestamps
      ? ['segment', 'word']
      : ['segment'];

    ctx.onProgress(null, 'Transcribing');
    let result = await httpJson(
      '/audio/transcriptions',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...base, response_format: 'verbose_json', timestamp_granularities: granularities }),
      },
      ctx.signal,
      TRANSCRIBE_TIMEOUT_MS,
    );

    if (!result.ok && result.status === 400) {
      // Documented behaviour, not a guess: `verbose_json` is supported only by
      // OpenAI, Groq and Together, and every other upstream "rejects it with a
      // 400". Which upstream a model routes to is decided per request and
      // cannot be pinned from here — the STT endpoint's `provider` object takes
      // only `options`, with none of the `only`/`order` routing controls chat
      // completions has. So the shape of the request has to be discovered by
      // trying it. A 400 means nothing was transcribed and nothing was billed,
      // so the retry costs one round trip and no money.
      ctx.onProgress(null, 'Retrying without timestamps');
      result = await httpJson(
        '/audio/transcriptions',
        { method: 'POST', headers, body: JSON.stringify(base) },
        ctx.signal,
        TRANSCRIBE_TIMEOUT_MS,
      );
    }

    if (!result.ok) throw transcriptionError(result.status, result.body);

    const text = isRecord(result.body) ? asString(result.body['text']) : undefined;
    if (text === undefined) {
      throw new Error('OpenRouter returned no transcript for this file. The audio may be silent, or the model may not support this format.');
    }

    const modelName = await namePromise;
    return buildTranscript(result.body, request, modelName);
  },
};

export default openrouterAdapter;
