/**
 * Deepgram — pre-recorded (batch) speech-to-text.
 *
 * Three endpoints are in play and they behave nothing like each other, which is
 * most of why this file is long:
 *
 *   GET  /v1/auth/token  validates a key and answers `text/plain` on failure.
 *   GET  /v1/models      is completely public — it validates nothing.
 *   POST /v1/listen      does the work, and fails in three different JSON dialects.
 *
 * The one rule that ties them together is the auth header: Deepgram uses the
 * `Token` scheme, not `Bearer`. `Bearer` is parsed (it is the scheme for the
 * short-lived JWTs from /v1/auth/grant) so a `Bearer <api key>` request fails
 * with a plain 401 rather than a helpful "wrong scheme" — which is exactly the
 * kind of error that costs an afternoon. Hence `authHeaders`, used everywhere,
 * and never a hand-written header literal.
 *
 * Nothing in this file puts the key anywhere but that header: not in a query
 * string, not in an error message, not in a `detail` blob. Deepgram's own error
 * bodies never echo it back either, so passing them through as `detail` is safe.
 */

import { extensionOf } from '../shared/media-extensions';
import type { KeyTestResult, ProviderModel } from '../shared/providers';
import type { Segment, Transcript, Word } from '../shared/transcript';
import { normalizeTranscript } from '../shared/transcript';
import type { CloudContext, CloudRequest, ProviderAdapter } from './types';
import { abortableFetch, assertOk, fileToBlob } from './types';

/**
 * Deepgram also serves api.eu.deepgram.com and api.au.deepgram.com on identical
 * paths. Only the North American host is wired up because Whisper Cloud is not
 * offered in the other two regions, and a region picker that silently removes
 * models from the list is worse than no region picker at all.
 */
const API_BASE = 'https://api.deepgram.com';

/** The `Token` scheme, deliberately. See the file header. */
function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Token ${apiKey}` };
}

/**
 * Every network call in this file goes through here.
 *
 * It exists so the shared helper is referenced from exactly one place: four
 * adapters are being written against `./types` at once, and if the helper's
 * shape moves, this file needs a one-line change rather than six.
 */
function request(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  return abortableFetch(url, init, signal);
}

// ── Narrowing ─────────────────────────────────────────────────────────────────
// `any` is banned, and Deepgram's published OpenAPI schema is provably wrong
// about the live payload in at least four places (it omits `punctuated_word` on
// channel words, types every timing as a string, and omits the top-level
// `languages` map). So nothing here trusts a declared type: every field is
// pulled out of `unknown` and checked, and a field that is missing or the wrong
// type degrades to a fallback instead of throwing.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstRecord(items: unknown[]): Record<string, unknown> | undefined {
  const first = items[0];
  return isRecord(first) ? first : undefined;
}

/**
 * Float seconds to integer milliseconds, rounded exactly once.
 *
 * Deepgram emits `"start": 14.3`, and `14.3 * 1000` is 14299.999999999998. This
 * is the single place in the adapter where that conversion happens, which is the
 * rule `shared/transcript.ts` sets out.
 */
function secondsToMs(value: unknown): number | undefined {
  const seconds = asNumber(value);
  return seconds === undefined ? undefined : Math.round(seconds * 1000);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, max = 400): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * An `Error` carrying the two extra fields `JobError` needs.
 *
 * `retryable` cannot be derived from the message downstream — "out of credits"
 * and "rate limited" both read like billing problems and only one of them is
 * worth retrying — so the adapter, which knows the status code, decides here.
 */
interface AdapterError extends Error {
  detail?: string;
  retryable: boolean;
}

function providerError(message: string, retryable: boolean, detail?: string): AdapterError {
  const error = new Error(message) as AdapterError;
  error.retryable = retryable;
  // Assigned rather than spread because `exactOptionalPropertyTypes` refuses an
  // explicit `undefined` for an optional property.
  if (detail !== undefined && detail.length > 0) error.detail = detail;
  return error;
}

/** What could be salvaged from a Deepgram error body, whatever shape it arrived in. */
interface DeepgramError {
  /** Deepgram's own sentence, e.g. "Invalid credentials." */
  message?: string;
  /** The machine code: `err_code` in the legacy shape, `category` in the modern one. */
  code?: string;
  /** Status, code, message and request id, for the UI's disclosure triangle. */
  detail?: string;
}

/**
 * Read a failed response body, coping with all three shapes Deepgram uses.
 *
 * They are, verified live against the API:
 *   - plain text            — `GET /v1/auth/token` answers `Invalid credentials.`
 *   - legacy JSON           — `POST /v1/listen` answers `{err_code, err_msg, request_id}`
 *   - modern JSON           — `GET /v1/projects` answers `{category, message, details, request_id}`
 *
 * A bare `response.json()` therefore throws on the first of those, which is the
 * single most common failure a user will hit (a mistyped key), so the body is
 * read as text first and parsed only if it actually looks like an object.
 *
 * The body can only be consumed once, which is why this returns everything a
 * caller might want rather than being called twice for different pieces.
 */
async function readDeepgramError(response: Response): Promise<DeepgramError> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    // A body that cannot even be read is not worth reporting on its own; the
    // status code below still produces a useful message.
    raw = '';
  }

  const trimmed = raw.trim();
  let message: string | undefined;
  let code: string | undefined;
  let requestId: string | undefined;

  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    if (isRecord(parsed)) {
      // Legacy first, modern second: a body carries one or the other, never both.
      message = asString(parsed.err_msg) ?? asString(parsed.message);
      code = asString(parsed.err_code) ?? asString(parsed.category);
      const details = asString(parsed.details);
      if (details !== undefined && details.length > 0) {
        message = message === undefined ? details : `${message} ${details}`;
      }
      requestId = asString(parsed.request_id);
    }
  } else if (trimmed.length > 0) {
    message = clip(trimmed);
  }

  // Deepgram repeats the message in `dg-error` and stamps every response with
  // `dg-request-id`, so even an empty body still identifies the request — which
  // is the only thing Deepgram support can act on.
  message ??= response.headers.get('dg-error') ?? undefined;
  requestId ??= response.headers.get('dg-request-id') ?? undefined;

  const parts: string[] = [`HTTP ${response.status}`];
  if (code !== undefined) parts.push(code);
  if (message !== undefined) parts.push(message);
  if (requestId !== undefined) parts.push(`request ${requestId}`);

  return {
    ...(message !== undefined ? { message } : {}),
    ...(code !== undefined ? { code } : {}),
    detail: parts.join(' · '),
  };
}

/**
 * Turn a failed `/v1/listen` response into something the user can act on.
 *
 * Deepgram's own text is appended where it adds information and dropped where it
 * does not — "Invalid credentials." tells a user nothing they can do, whereas
 * the 400 body usually names the offending parameter.
 */
function listenFailure(status: number, error: DeepgramError): AdapterError {
  const suffix = error.message !== undefined ? ` Deepgram said: ${error.message}` : '';
  const { detail } = error;

  switch (status) {
    case 400:
      return providerError(
        `Deepgram rejected the transcription request.${suffix}`,
        false,
        detail,
      );
    case 401:
      // Two very different problems share this status. INSUFFICIENT_PERMISSIONS
      // means the key is real but was created with too narrow a scope list, so
      // telling the user to re-enter it would send them in circles.
      return error.code === 'INSUFFICIENT_PERMISSIONS'
        ? providerError(
            'This Deepgram key is missing the permissions needed to transcribe. Create a new key with transcription access.',
            false,
            detail,
          )
        : providerError('Deepgram rejected the API key. Re-enter it in Settings.', false, detail);
    case 402:
      return providerError(
        'This Deepgram project has run out of credit. Top it up in the Deepgram console and try again.',
        false,
        detail,
      );
    case 403:
      return providerError(
        'This Deepgram project does not have access to the selected model. Choose a different model.',
        false,
        detail,
      );
    case 404:
      return providerError('Deepgram could not find that model or project.', false, detail);
    case 413:
      return providerError(
        'The file is larger than the 2 GB Deepgram accepts. Split it into shorter pieces.',
        false,
        detail,
      );
    case 422:
      // ASR_UNPROCESSABLE_ENTITY: Deepgram gave up waiting for the upload to
      // finish. On a slow connection this is pure luck, so it is worth retrying.
      return providerError(
        'The upload to Deepgram did not finish in time. Check the connection and try again.',
        true,
        detail,
      );
    case 429:
      return providerError(
        'Deepgram is rate limiting this project — too many transcriptions at once. Wait a moment and try again.',
        true,
        detail,
      );
    case 504:
      // NOT an audio-length limit. Deepgram budgets ten minutes of *processing*
      // per synchronous request (twenty for Whisper), so how long a file can be
      // depends on the model's speed and on Deepgram's load that minute. The
      // same file can succeed on a retry, and will certainly succeed on a faster
      // model — which is why this says both things out loud.
      return providerError(
        'Deepgram ran out of processing time for this file. Its batch endpoint allows about ten minutes of processing per request (twenty for Whisper models). Try again, pick a faster model, or split the file into shorter pieces.',
        true,
        detail,
      );
    default:
      if (status >= 500) {
        return providerError(
          `Deepgram had a server error (HTTP ${status}). Trying again usually works.`,
          true,
          detail,
        );
      }
      return providerError(`Deepgram returned HTTP ${status}.${suffix}`, false, detail);
  }
}

// ── Model catalogue ───────────────────────────────────────────────────────────

/**
 * The model family, derived from `canonical_name` rather than from the
 * `architecture` field.
 *
 * The API's own `architecture` cannot be used for this: every `enhanced-*` model
 * reports `polaris`, `phoneme` reports both `base` and `unknown` across its rows,
 * and `nova-general` reports `nova` on some rows and `nova-2` on others. The
 * canonical name is the only self-consistent signal, and it is also what the
 * user sees.
 */
function familyOf(canonicalName: string): string {
  if (canonicalName.startsWith('nova-3')) return 'nova-3';
  if (canonicalName.startsWith('nova-2')) return 'nova-2';
  if (canonicalName.startsWith('nova')) return 'nova';
  if (canonicalName.startsWith('enhanced')) return 'enhanced';
  if (canonicalName.startsWith('whisper')) return 'whisper';
  // Everything left is the base tier, which uses bare names: `general`,
  // `meeting`, `phonecall`, `phoneme`, and a couple of Deepgram's own jokes.
  return 'base';
}

/** Best models first. Whisper last: it is the slowest tier and cannot diarize. */
const FAMILY_RANK: Record<string, number> = {
  'nova-3': 0,
  'nova-2': 1,
  nova: 2,
  enhanced: 3,
  base: 4,
  whisper: 5,
};

/** Smallest to largest, because alphabetical would read base → large → medium → small → tiny. */
const WHISPER_SIZE_ORDER: readonly string[] = [
  'whisper-tiny',
  'whisper-base',
  'whisper-small',
  'whisper-medium',
  'whisper-large',
];

function isGeneralModel(canonicalName: string): boolean {
  return canonicalName === 'general' || canonicalName.endsWith('-general');
}

/**
 * Family first, then the general-purpose model ahead of the domain-tuned ones.
 *
 * Without the second key `nova-2-atc` would sort above `nova-2-general`, putting
 * an air-traffic-control model at the top of the list for a user transcribing a
 * podcast.
 */
function compareCanonical(a: string, b: string): number {
  const familyA = familyOf(a);
  const familyB = familyOf(b);
  const rankA = FAMILY_RANK[familyA] ?? 9;
  const rankB = FAMILY_RANK[familyB] ?? 9;
  if (rankA !== rankB) return rankA - rankB;

  if (familyA === 'whisper' && familyB === 'whisper') {
    const sizeA = WHISPER_SIZE_ORDER.indexOf(a);
    const sizeB = WHISPER_SIZE_ORDER.indexOf(b);
    if (sizeA !== sizeB) return (sizeA < 0 ? 99 : sizeA) - (sizeB < 0 ? 99 : sizeB);
  }

  const generalA = isGeneralModel(a) ? 0 : 1;
  const generalB = isGeneralModel(b) ? 0 : 1;
  if (generalA !== generalB) return generalA - generalB;

  return a.localeCompare(b);
}

/**
 * `nova-3-general` → `Nova-3 General`.
 *
 * The hyphen is kept only in front of a bare number, because `nova-3` is one
 * product name while `nova-3-general` is a product name and a variant. Tokens
 * that are not plain lowercase words are left exactly as they are, so Deepgram's
 * `general-dQw4w9WgXcQ` easter egg is not mangled into `General Dqw4w9wgxcq`.
 */
function prettyLabel(canonicalName: string): string {
  const parts: string[] = [];
  for (const token of canonicalName.split('-')) {
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(token) && last !== undefined) {
      parts[parts.length - 1] = `${last}-${token}`;
      continue;
    }
    parts.push(/^[a-z]+$/.test(token) ? `${token.charAt(0).toUpperCase()}${token.slice(1)}` : token);
  }
  return parts.join(' ');
}

interface ModelGroup {
  canonicalName: string;
  architectures: Set<string>;
  languages: Set<string>;
  multilingual: boolean;
}

function toProviderModel(group: ModelGroup): ProviderModel {
  const family = familyOf(group.canonicalName);
  const languages = [...group.languages].sort((a, b) => a.localeCompare(b));
  if (group.multilingual) {
    // `multi` is a real, documented value for `?language=` — it turns on
    // code-switching — but it appears nowhere in /v1/models' language arrays, so
    // a list built purely from the response would never offer it.
    languages.unshift('multi');
  }

  const architecture = [...group.architectures].sort((a, b) => a.localeCompare(b)).join(', ');
  const parts: string[] = [];
  if (architecture.length > 0) parts.push(architecture);
  parts.push(`${languages.length} language${languages.length === 1 ? '' : 's'}`);
  if (family === 'whisper') parts.push('no diarization');
  if (group.multilingual) parts.push('code-switching');

  return {
    id: group.canonicalName,
    label: prettyLabel(group.canonicalName),
    description: parts.join(' · '),
    languages,
    // `pricePerMinuteUsd` is deliberately absent. /v1/models carries no pricing,
    // Deepgram's rates vary by plan, and a hard-coded number in a shipped desktop
    // app would eventually lie to the user about their own bill.
    capabilities: {
      // Diarization is supported on every Deepgram architecture except Whisper
      // Cloud, which has no diarizer behind it at all.
      diarization: family !== 'whisper',
      // Deepgram always returns word timings and never charges extra for them,
      // so there is nothing to negotiate — hence `wordTimestamps` in
      // `CloudOptions` is not sent as a parameter anywhere in this file.
      wordTimestamps: true,
      // `translate` is omitted rather than set false: Deepgram has no
      // translation mode at all for pre-recorded audio, on any model.
    },
  };
}

/**
 * Fold the 443-row `stt` array into one entry per model the user can actually pick.
 *
 * Two traps live here. The first is that `name` is NOT the value the API accepts
 * in `?model=` — four different models are named `general` (`nova-3-general`,
 * `nova-general`, `enhanced-general`, `base`'s own `general`), so `canonical_name`
 * is the id and `name` is never used. The second is that rows are duplicated per
 * language group and per batch/streaming variant, so `nova-3-general` alone
 * appears 77 times with different `languages` arrays; the union of those arrays
 * is the model's real language coverage.
 */
function parseModels(body: unknown): ProviderModel[] {
  if (!isRecord(body)) return [];

  const groups = new Map<string, ModelGroup>();
  for (const entry of asArray(body.stt)) {
    if (!isRecord(entry)) continue;
    // Streaming-only rows are useless to a file transcriber, and this is also
    // what keeps Flux out of the list — it never reports `batch: true`.
    if (entry.batch !== true) continue;

    const canonicalName = asString(entry.canonical_name);
    if (canonicalName === undefined || canonicalName.length === 0) continue;

    let group = groups.get(canonicalName);
    if (group === undefined) {
      group = { canonicalName, architectures: new Set(), languages: new Set(), multilingual: false };
      groups.set(canonicalName, group);
    }

    const architecture = asString(entry.architecture);
    if (architecture !== undefined && architecture.length > 0) group.architectures.add(architecture);
    for (const language of asArray(entry.languages)) {
      const tag = asString(language);
      if (tag !== undefined && tag.length > 0) group.languages.add(tag);
    }
    if (entry.multilingual === true) group.multilingual = true;
  }

  return [...groups.values()]
    .sort((a, b) => compareCanonical(a.canonicalName, b.canonicalName))
    .map(toProviderModel);
}

// ── Request construction ──────────────────────────────────────────────────────

function isWhisperModel(modelId: string): boolean {
  return familyOf(modelId) === 'whisper';
}

/**
 * Content types Deepgram recognises, keyed by the extensions this app accepts.
 *
 * Deepgram sniffs the container itself and documents the header as optional, but
 * sending it saves it the work. The important part is the fallback: it must
 * never be `application/json`, because that is the header that switches
 * `/v1/listen` into fetch-this-URL mode, where a binary body is read as JSON and
 * comes back as "corrupt or unsupported data".
 */
const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  mp2: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  wave: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  aifc: 'audio/aiff',
  amr: 'audio/amr',
  ac3: 'audio/ac3',
  wma: 'audio/x-ms-wma',
  mka: 'audio/x-matroska',
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ts: 'video/mp2t',
  mts: 'video/mp2t',
  m2ts: 'video/mp2t',
  '3gp': 'video/3gpp',
  ogv: 'video/ogg',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-asf',
  asf: 'video/x-ms-asf',
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extensionOf(filePath)] ?? 'application/octet-stream';
}

/**
 * Build the `/v1/listen` URL.
 *
 * `model` is always set: the API's own default is `base-general`, the oldest and
 * cheapest tier, so an omitted parameter silently downgrades every job.
 * `version` is left alone so it stays at `latest`; pinning it would freeze the
 * app to a model revision that Deepgram eventually retires.
 *
 * The API key is never a query parameter here — it goes in the header, so this
 * URL is safe to put in a log line or an error `detail`.
 */
function buildListenUrl(req: CloudRequest): string {
  const url = new URL('/v1/listen', API_BASE);
  const params = url.searchParams;

  params.set('model', req.modelId);
  // smart_format implies punctuate, and paragraphs force-enables it too, but all
  // three are sent explicitly so a future change to any one of them cannot
  // quietly turn punctuation off. smart_format is what produces the
  // `punctuated_word` field the segment builder below depends on.
  params.set('smart_format', 'true');
  params.set('punctuate', 'true');
  // paragraphs only does anything for space-delimited languages; for Chinese,
  // Japanese and Thai it is ignored rather than rejected, and `utterances`
  // below is the preferred segmentation source anyway.
  params.set('paragraphs', 'true');
  params.set('utterances', 'true');

  const { language } = req.options;
  if (language !== null && language.length > 0) {
    params.set('language', language);
  } else {
    // Without this the API defaults to `language=en` and transcribes Bulgarian
    // audio as garbled English rather than failing. Detection is pre-recorded
    // only, which is fine here, and it is what populates `detected_language`.
    params.set('detect_language', 'true');
  }

  if (req.options.diarize && !isWhisperModel(req.modelId)) {
    // `diarize=true` is deprecated and always routes to the v1 diarizer;
    // `diarize_model` both enables diarization and selects the model, and
    // Deepgram REJECTS any request that sets both. So this is the only
    // diarization parameter this adapter ever sends — do not add `diarize` back.
    params.set('diarize_model', 'latest');
  }
  // Whisper Cloud has no diarizer, and asking for one there is a hard rejection
  // of the whole job. Dropping the request silently is the lesser evil: the
  // model list already advertises `diarization: false` for every Whisper model,
  // so the UI has what it needs to explain the missing speaker labels.

  // `options.translate` has no equivalent at Deepgram — there is no translation
  // mode on /v1/listen for any model — so it is deliberately ignored here.

  return url.toString();
}

// ── Response parsing ──────────────────────────────────────────────────────────

/**
 * Deepgram numbers speakers from zero as integers. They are turned into strings
 * because `Word.speaker` is a label, not an index, and ElevenLabs' `speaker_0`
 * has to live in the same field.
 */
function speakerLabel(value: unknown): string | undefined {
  const numeric = asNumber(value);
  if (numeric !== undefined) return String(Math.round(numeric));
  const text = asString(value);
  return text !== undefined && text.length > 0 ? text : undefined;
}

/**
 * `punctuated_word` first, `word` second.
 *
 * The published schema declares `punctuated_word` only on utterance words, but
 * the live API returns it on channel words too whenever smart_format or
 * punctuate is on — and this adapter always turns both on. Falling back to
 * `word` matters for the models that ignore punctuation entirely, such as
 * `phoneme`.
 */
function parseWords(raw: unknown): Word[] {
  const words: Word[] = [];
  for (const item of asArray(raw)) {
    if (!isRecord(item)) continue;
    const text = asString(item.punctuated_word) ?? asString(item.word);
    if (text === undefined || text.length === 0) continue;

    const startMs = secondsToMs(item.start) ?? 0;
    const endMs = Math.max(secondsToMs(item.end) ?? startMs, startMs);
    const confidence = asNumber(item.confidence);
    const speaker = speakerLabel(item.speaker);

    words.push({
      text,
      startMs,
      endMs,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(speaker !== undefined ? { speaker } : {}),
    });
  }
  return words;
}

/**
 * Segments from `results.utterances`, the best source Deepgram offers.
 *
 * Utterances break on speaker turns and on pauses longer than `utt_split`, which
 * is exactly the boundary a subtitle wants; paragraphs break on sentence flow and
 * happily run a single speaker's answer across a question. Utterances also carry
 * their own words, so no time-window matching is needed.
 */
function segmentsFromUtterances(raw: unknown): Segment[] {
  const segments: Segment[] = [];
  for (const item of asArray(raw)) {
    if (!isRecord(item)) continue;

    const words = parseWords(item.words);
    const text = (asString(item.transcript) ?? words.map((w) => w.text).join(' ')).trim();
    if (text.length === 0 && words.length === 0) continue;

    const startMs = secondsToMs(item.start) ?? words[0]?.startMs ?? 0;
    const endMs = Math.max(
      secondsToMs(item.end) ?? words[words.length - 1]?.endMs ?? startMs,
      startMs,
    );
    const speaker = speakerLabel(item.speaker);

    segments.push({ startMs, endMs, text, words, ...(speaker !== undefined ? { speaker } : {}) });
  }
  return segments;
}

/**
 * Segments from `alternatives[0].paragraphs.paragraphs`, the fallback.
 *
 * Paragraph objects carry sentences and timings but no words of their own, so the
 * alternative's flat word list is walked with a cursor and handed out by time.
 * A cursor rather than a filter because both lists are already in order and both
 * can be long — an hour of speech is ~10 000 words, and filtering the whole list
 * per paragraph is quadratic for no benefit.
 *
 * Losing the words here would be worse than it sounds: `resegment` in
 * `subtitles.ts` needs word timings to split a long paragraph into readable cues,
 * and without them the whole paragraph becomes one unreadable subtitle.
 */
function segmentsFromParagraphs(raw: unknown, words: Word[]): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (const item of asArray(raw)) {
    if (!isRecord(item)) continue;

    const sentences: string[] = [];
    let sentenceStart: number | undefined;
    let sentenceEnd: number | undefined;
    for (const sentence of asArray(item.sentences)) {
      if (!isRecord(sentence)) continue;
      const text = asString(sentence.text);
      if (text !== undefined && text.length > 0) sentences.push(text);
      sentenceStart ??= secondsToMs(sentence.start);
      const end = secondsToMs(sentence.end);
      if (end !== undefined) sentenceEnd = end;
    }

    const startMs = secondsToMs(item.start) ?? sentenceStart ?? 0;
    const endMs = Math.max(secondsToMs(item.end) ?? sentenceEnd ?? startMs, startMs);

    const owned: Word[] = [];
    while (cursor < words.length) {
      const word = words[cursor];
      if (word === undefined) break;
      // A word starting exactly on the boundary belongs to the next paragraph.
      if (word.startMs >= endMs) break;
      owned.push(word);
      cursor += 1;
    }

    const text = (sentences.length > 0 ? sentences.join(' ') : owned.map((w) => w.text).join(' ')).trim();
    if (text.length === 0 && owned.length === 0) continue;

    const speaker = speakerLabel(item.speaker);
    segments.push({
      startMs,
      endMs,
      text,
      words: owned,
      ...(speaker !== undefined ? { speaker } : {}),
    });
  }

  // Rounding at the last boundary can strand the final word or two. Appending
  // them to the last segment keeps every word in the transcript, which matters
  // because the exporters read words, not just segment text.
  const last = segments[segments.length - 1];
  if (last !== undefined && cursor < words.length) {
    const leftover = words.slice(cursor);
    last.words = [...last.words, ...leftover];
    const tail = leftover[leftover.length - 1];
    if (tail !== undefined) last.endMs = Math.max(last.endMs, tail.endMs);
  }

  return segments;
}

function buildTranscript(payload: unknown, req: CloudRequest): Transcript {
  if (!isRecord(payload)) {
    throw providerError('Deepgram returned a response this app could not read.', false, clip(String(payload)));
  }

  const metadata = isRecord(payload.metadata) ? payload.metadata : undefined;
  const results = isRecord(payload.results) ? payload.results : undefined;
  if (results === undefined) {
    // The only documented 200 without `results` is the async acknowledgement for
    // a request that set `callback=`. This adapter never sets it — Deepgram does
    // not store transcripts and offers no fetch-it-later endpoint, so a desktop
    // app with no public HTTPS endpoint would simply lose the result — but if the
    // shape ever changes, failing loudly beats returning an empty transcript.
    const requestId = metadata !== undefined ? asString(metadata.request_id) : undefined;
    throw providerError(
      'Deepgram accepted the audio but returned no transcript.',
      true,
      requestId !== undefined ? `request ${requestId}` : undefined,
    );
  }

  const channel = firstRecord(asArray(results.channels));
  const alternative = channel !== undefined ? firstRecord(asArray(channel.alternatives)) : undefined;
  const words = alternative !== undefined ? parseWords(alternative.words) : [];

  let segments = segmentsFromUtterances(results.utterances);
  if (segments.length === 0 && alternative !== undefined) {
    const paragraphs = isRecord(alternative.paragraphs) ? alternative.paragraphs.paragraphs : undefined;
    segments = segmentsFromParagraphs(paragraphs, words);
  }
  if (segments.length === 0 && alternative !== undefined) {
    // Last resort: the whole channel as one segment. This is what comes back for
    // a non-space-delimited language, where `paragraphs` does nothing.
    const text = (asString(alternative.transcript) ?? '').trim();
    if (text.length > 0 || words.length > 0) {
      const startMs = words[0]?.startMs ?? 0;
      const endMs = Math.max(words[words.length - 1]?.endMs ?? req.durationMs, startMs);
      segments = [{ startMs, endMs, text, words }];
    }
  }

  // `detected_language` is only present when `detect_language=true` was sent;
  // when a language was requested, Deepgram honours it silently and the request
  // is the better answer. Not inventing one when neither exists is deliberate —
  // `null` means "unknown", which is different from guessing "en".
  const detected = channel !== undefined ? asString(channel.detected_language) : undefined;
  const rawLanguage = detected ?? req.options.language;
  const language =
    rawLanguage !== null && rawLanguage !== undefined && rawLanguage.length > 0
      ? rawLanguage.toLowerCase()
      : null;

  // Absent for Whisper Cloud even with detection on, which is why it is optional.
  const languageConfidence = channel !== undefined ? asNumber(channel.language_confidence) : undefined;

  // ffprobe's duration wins. Deepgram's `metadata.duration` is what it decoded
  // and billed for, which is close but not identical, and every cue in the app
  // is clamped against this number.
  const durationMs =
    req.durationMs > 0 ? req.durationMs : (metadata !== undefined ? secondsToMs(metadata.duration) : undefined) ?? 0;

  return normalizeTranscript({
    language,
    ...(languageConfidence !== undefined ? { languageConfidence } : {}),
    durationMs,
    segments,
    source: {
      kind: 'cloud',
      engineId: 'deepgram',
      modelId: req.modelId,
      label: `${prettyLabel(req.modelId)} · Deepgram`,
    },
    createdAt: new Date().toISOString(),
  });
}

// ── Adapter ───────────────────────────────────────────────────────────────────

/**
 * Name the project behind the key, for the "connected as" line in Settings.
 *
 * A 401 from here is NOT a bad key. Deepgram keys carry scopes, and a key minted
 * for transcription alone legitimately lacks `project:read` — it will transcribe
 * perfectly and still be refused by /v1/projects. Treating that as a failed test
 * would lock out exactly the narrowly-scoped keys a security-minded user creates,
 * so every failure here degrades to "no project name" and the caller carries on.
 */
async function describeProject(apiKey: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const response = await request(
      `${API_BASE}/v1/projects`,
      { method: 'GET', headers: authHeaders(apiKey) },
      signal,
    );
    if (!response.ok) {
      await response.text().catch(() => '');
      return undefined;
    }

    const body: unknown = await response.json();
    if (!isRecord(body)) return undefined;

    const names: string[] = [];
    for (const project of asArray(body.projects)) {
      if (!isRecord(project)) continue;
      const name = asString(project.name);
      if (name !== undefined && name.length > 0) names.push(name);
    }

    const first = names[0];
    if (first === undefined) return undefined;
    return names.length === 1 ? first : `${first} (+${names.length - 1} more)`;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

/**
 * Validate a key against GET /v1/auth/token.
 *
 * This endpoint, not /v1/models: the model list is served without any
 * authentication at all, so a "test" built on it would accept every string the
 * user typed. /v1/auth/token costs no transcription credits and answers on the
 * status code alone — the success body is undocumented, absent from the OpenAPI
 * spec, and is deliberately not parsed here, because any field name read out of
 * it would be a guess that can break without notice.
 */
async function testKey(apiKey: string, signal: AbortSignal): Promise<KeyTestResult> {
  let response: Response;
  try {
    response = await request(
      `${API_BASE}/v1/auth/token`,
      { method: 'GET', headers: authHeaders(apiKey) },
      signal,
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    // A dead network is not a bad key, and saying so keeps the user from
    // re-typing a perfectly good one.
    return { ok: false, message: `Could not reach Deepgram: ${errorText(error)}` };
  }

  if (response.status === 401) {
    // This body is `text/plain` — literally `Invalid credentials.` — so
    // `response.json()` would throw here and hide the real answer behind a
    // parse error. Drained rather than read because the text adds nothing.
    await response.text().catch(() => '');
    return { ok: false, message: 'Deepgram rejected that key. Copy it again from the Deepgram console.' };
  }

  if (!response.ok) {
    // `readDeepgramError`, not `readErrorMessage`. The latter is synchronous and
    // takes an already-parsed body; handed a `Response` it sees a non-null
    // object, finds none of `detail`/`err_msg`/`message`/`error` on it, and
    // returns null — which the template then rendered as the literal word
    // "null". Measured against Deepgram's own 429 dialect, the user was shown:
    //
    //   Deepgram could not check the key (HTTP 429). null
    //
    // while `{"err_code":"RATE_LIMIT_EXCEEDED","err_msg":"Too many requests."}`
    // sat unread in a stream nobody consumed.
    const failure = await readDeepgramError(response);
    const detail = failure.message ?? '';
    return {
      ok: false,
      message: detail.length > 0
        ? `Deepgram could not check the key (HTTP ${response.status}). ${detail}`
        : `Deepgram could not check the key (HTTP ${response.status}). Try again in a moment.`,
    };
  }

  await response.text().catch(() => '');

  const account = await describeProject(apiKey, signal);
  // The model list is public and cheap, so fetching it here means the model
  // picker is populated the instant the key checks out — one visible step
  // instead of two. A failure is not worth failing the test over.
  let models: ProviderModel[];
  try {
    models = await listModels(apiKey, signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    models = [];
  }

  const message =
    models.length > 0
      ? `Key accepted. ${models.length} batch model${models.length === 1 ? '' : 's'} available.`
      : 'Key accepted.';

  return {
    ok: true,
    message,
    ...(account !== undefined ? { account } : {}),
    ...(models.length > 0 ? { models } : {}),
  };
}

/**
 * GET /v1/models.
 *
 * The key parameter is required by `ProviderAdapter` and deliberately not used:
 * this endpoint is public, and sending an Authorization header it does not read
 * would only widen where the key travels. The key-scoped variant,
 * /v1/projects/{id}/models, exists for custom models, but reaching it needs the
 * `project:read` scope that a transcribe-only key does not have — so the public
 * list is the one that works for every key this app will ever see.
 */
async function listModels(_apiKey: string, signal: AbortSignal): Promise<ProviderModel[]> {
  const response = await request(`${API_BASE}/v1/models`, { method: 'GET' }, signal);
  await assertOk(response, 'deepgram');
  const body: unknown = await response.json();
  return parseModels(body);
}

/**
 * POST the file to /v1/listen and wait.
 *
 * There is no progress to report and none is faked. Deepgram's batch endpoint
 * holds the connection open and sends response headers only once the whole file
 * has been processed, so the upload and the transcription are indistinguishable
 * from out here — a percentage would be a lie, and `null` is what `JobProgress`
 * has for precisely this case.
 *
 * The synchronous request is also the only option: the async `callback=` flow
 * needs a public HTTPS endpoint to deliver to, and Deepgram does not store
 * transcripts, so there is nothing to fetch later if the callback has nowhere
 * to land.
 */
async function transcribe(req: CloudRequest, ctx: CloudContext): Promise<Transcript> {
  ctx.onProgress(null, 'Uploading to Deepgram');

  const url = buildListenUrl(req);
  const body = await fileToBlob(req.filePath);

  const response = await request(
    url,
    {
      method: 'POST',
      headers: {
        ...authHeaders(req.apiKey),
        // Explicit, so it wins over whatever type the Blob carries. Anything but
        // `application/json` — see CONTENT_TYPES.
        'Content-Type': contentTypeFor(req.filePath),
      },
      body,
    },
    ctx.signal,
  );

  if (!response.ok) {
    throw listenFailure(response.status, await readDeepgramError(response));
  }

  ctx.onProgress(null, 'Receiving transcript');
  const payload: unknown = await response.json();
  return buildTranscript(payload, req);
}

export const deepgramAdapter: ProviderAdapter = {
  id: 'deepgram',
  testKey,
  listModels,
  transcribe,
};
