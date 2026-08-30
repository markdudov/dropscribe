/**
 * ElevenLabs Scribe.
 *
 * Three things about this API are not what a reader would guess, and each one
 * costs a silent bug rather than a loud error:
 *
 * 1. The auth header is literally `xi-api-key: <key>`. Not `Authorization`, no
 *    `Bearer` prefix. A request with `Authorization: Bearer …` is treated as an
 *    *unauthenticated* request, so the failure surfaces as "no key sent" rather
 *    than "wrong header".
 * 2. `enable_logging` is a QUERY parameter, not a multipart field. Several of
 *    ElevenLabs' own doc pages put it in the body, where it is silently ignored
 *    — and being ignored means the opposite of what this app promises, because
 *    the default is server-side retention.
 * 3. `tag_audio_events` defaults to TRUE. Left alone it writes `(laughter)` and
 *    `(music)` into the word stream, which then land in the user's .srt.
 *
 * Model discovery deliberately does NOT use `GET /v1/models`: that endpoint is
 * the text-to-speech catalogue and carries no speech-to-text flag of any kind,
 * so filtering it is guesswork. The only authoritative machine-readable list of
 * accepted STT model ids is the `model_id` enum inside the public OpenAPI
 * document, which is what `listModels` reads.
 */

import { openAsBlob } from 'node:fs';
import { basename, extname } from 'node:path';

import type { KeyTestResult, ProviderModel } from '../shared/providers';
import type { Segment, Transcript, Word } from '../shared/transcript';
import { normalizeTranscript } from '../shared/transcript';
import type { CloudContext, CloudRequest, ProviderAdapter } from './types';
import { longFetch } from './types';

const API_ROOT = 'https://api.elevenlabs.io';
const SUBSCRIPTION_URL = `${API_ROOT}/v1/user/subscription`;
const USER_URL = `${API_ROOT}/v1/user`;
const OPENAPI_URL = `${API_ROOT}/openapi.json`;

/**
 * Zero-retention. `enable_logging=false` tells ElevenLabs not to keep the audio
 * or the transcript on their side, and it is the only correct default for a
 * desktop app whose whole premise is that the user drops private recordings —
 * interviews, therapy notes, legal calls — onto a window on their own machine.
 * Anyone who wants the transcript kept in the ElevenLabs history can use the
 * ElevenLabs web app; this app does not get to make that choice for them.
 */
const STT_URL = `${API_ROOT}/v1/speech-to-text?enable_logging=false`;

/**
 * Explicitly false, because the API default is true.
 *
 * With tagging on, the response contains `type: 'audio_event'` entries whose
 * text is `(laughter)`, `(applause)`, `(music)`. Those are useful for a
 * transcript you read and actively harmful in a subtitle file you burn into a
 * video. The constant is used both to build the form field and to filter the
 * response, so the request and the parser can never disagree about it.
 */
const TAG_AUDIO_EVENTS = false;

/**
 * A silence longer than this starts a new segment.
 *
 * 700 ms is roughly the pause that separates two sentences in speech; below it
 * you are inside a phrase. This only decides what the *engine-level* segments
 * are — subtitle cue length and reading speed are `resegment`'s job downstream,
 * so this number does not need to know anything about line lengths.
 */
const GAP_BREAK_MS = 700;

/** The key check is one small GET; anything slower than this is a dead network. */
const KEY_TEST_TIMEOUT_MS = 20_000;
/** The spec document is ~2 MB, so it gets a longer leash than the key check. */
const SPEC_TIMEOUT_MS = 30_000;
/** Model ids change a few times a year; re-reading 2 MB more often is waste. */
const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;

/**
 * Used when the OpenAPI fetch fails or its shape has moved.
 *
 * `scribe_v1_experimental` is deliberately absent: it was removed from the enum
 * and sending it now fails validation, so a "helpful" extra entry here would
 * hand the user a model that cannot run.
 */
const FALLBACK_MODEL_IDS: readonly string[] = ['scribe_v2', 'scribe_v1'];

interface ModelNote {
  label: string;
  description: string;
  /** ElevenLabs quotes Scribe per HOUR of audio; see `toProviderModel`. */
  pricePerHourUsd?: number;
}

const MODEL_NOTES: Readonly<Record<string, ModelNote>> = {
  scribe_v2: {
    label: 'Scribe v2',
    description: 'Recommended. Current generation, 90+ languages, word timings and diarization.',
    pricePerHourUsd: 0.22,
  },
  scribe_v1: {
    label: 'Scribe v1',
    description: 'Superseded by Scribe v2. Keep it only to reproduce an older transcript.',
    // No price on purpose. ElevenLabs' pricing page quotes a per-hour figure for
    // Scribe v2 and says nothing about v1, and a made-up number in a cost column
    // is worse than an empty one.
  },
};

// ── tiny unknown-narrowing helpers ────────────────────────────────────────────
// Every response below is parsed from `unknown`. The adapter never declares an
// interface and casts a body into it: a vendor that renames a field would then
// produce `undefined` where the types promise a string, and the crash would land
// three layers away from the cause.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function titleCase(value: string): string {
  const first = value[0];
  return first === undefined ? value : first.toUpperCase() + value.slice(1);
}

/** Walk a path of object keys, giving up the moment one of them is not an object. */
function dig(value: unknown, ...keys: readonly string[]): Record<string, unknown> | undefined {
  let node: unknown = value;
  for (const key of keys) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return isRecord(node) ? node : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Gateways and proxies answer with HTML. Returning `undefined` lets the
    // caller fall back to the HTTP status instead of throwing a SyntaxError the
    // user cannot act on.
    return undefined;
  }
}

// ── request plumbing ──────────────────────────────────────────────────────────

/**
 * The header, and nothing else that could carry the key.
 *
 * Note the absence of `content-type`: `fetch` derives it from the `FormData`
 * body together with the multipart boundary, and setting it by hand produces a
 * boundary-less header that the server cannot parse.
 */
function authHeaders(apiKey: string): Record<string, string> {
  return { 'xi-api-key': apiKey, accept: 'application/json' };
}

interface Deadline {
  signal: AbortSignal;
  timedOut: () => boolean;
  release: () => void;
}

/**
 * A child signal that aborts when the caller aborts *or* when time runs out.
 *
 * `AbortSignal.any` would say this in one line, but it is recent enough that
 * pinning the app's minimum Node/Electron on it buys nothing here.
 */
function withDeadline(parent: AbortSignal, ms: number): Deadline {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, ms);
  const onParentAbort = (): void => controller.abort();
  if (parent.aborted) controller.abort();
  else parent.addEventListener('abort', onParentAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => expired,
    release: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onParentAbort);
    },
  };
}

/** `fetch` wraps transport failures in a generic TypeError; the real code is on `cause`. */
function causeCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause: unknown = error.cause;
  return isRecord(cause) ? str(cause['code']) : undefined;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Turn a transport failure into something a user can act on.
 *
 * The `UND_ERR_HEADERS_TIMEOUT` case is the one worth naming: the STT endpoint
 * holds the connection open for the whole transcription, and Node's default
 * five-minute header timeout can fire on a multi-hour file even though nothing
 * is actually wrong. Reporting that as "network error" sends people to their
 * router instead of to a shorter file.
 */
function networkMessage(error: unknown): string {
  switch (causeCode(error)) {
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return 'ElevenLabs did not answer in time. Very long recordings can outlast the request timeout — try again, or split the file.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Could not reach api.elevenlabs.io. Check your internet connection.';
    case 'ECONNRESET':
    case 'ECONNREFUSED':
    case 'EPIPE':
    case 'UND_ERR_SOCKET':
      return 'The connection to ElevenLabs was interrupted before the transcript arrived.';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'The secure connection to ElevenLabs was rejected. A proxy or antivirus may be intercepting HTTPS.';
    default:
      return 'Could not reach ElevenLabs.';
  }
}

interface ApiFailure {
  /** Shown to the user verbatim. Never contains the key or a URL with it. */
  message: string;
  /** The vendor's own words, for the disclosure triangle on a failed job. */
  detail: string;
}

/**
 * ElevenLabs has TWO error bodies, and 422 is the odd one.
 *
 * Normal errors: `{"detail":{"type","code","message","status","request_id"}}`.
 * Validation errors: `{"detail":[{"loc":[…],"msg","type"}]}` — `detail` is an
 * ARRAY there, so `detail.message` is `undefined` and a parser that only knows
 * the first shape reports an empty reason for exactly the failures that carry
 * the most useful reason.
 */
function describeFailure(status: number, raw: string, requestId: string | null): ApiFailure {
  const body = parseJson(raw);
  const detail = isRecord(body) ? body['detail'] : undefined;

  let vendorMessage: string | undefined;
  let code: string | undefined;

  if (isRecord(detail)) {
    vendorMessage = str(detail['message']);
    code = str(detail['code']) ?? str(detail['status']);
  } else if (Array.isArray(detail)) {
    const reasons: string[] = [];
    for (const item of detail) {
      if (!isRecord(item)) continue;
      const msg = str(item['msg']);
      if (msg === undefined) continue;
      const loc = Array.isArray(item['loc'])
        ? item['loc'].filter((p): p is string | number => typeof p === 'string' || typeof p === 'number')
        : [];
      // `loc` is ["body","model_id"]; the leading "body" is noise to a user.
      const field = loc.filter((p) => p !== 'body').join('.');
      reasons.push(field.length > 0 ? `${field}: ${msg}` : msg);
    }
    if (reasons.length > 0) vendorMessage = reasons.join('; ');
    code = 'validation_error';
  } else {
    vendorMessage = str(detail);
  }

  const message = failureMessage(status, code, vendorMessage);
  const parts = [`HTTP ${status}`];
  if (requestId !== null && requestId.length > 0) parts.push(`request-id ${requestId}`);
  const head = parts.join(' · ');
  const tail = raw.trim().slice(0, 2000);
  return { message, detail: tail.length > 0 ? `${head}\n${tail}` : head };
}

function failureMessage(status: number, code: string | undefined, vendorMessage: string | undefined): string {
  if (status === 401) {
    // `needs_authorization` means the header never arrived, which is a bug in
    // this app rather than a bad key — say so, so the user does not go and
    // regenerate a perfectly good key.
    return code === 'needs_authorization'
      ? 'ElevenLabs received no API key with the request.'
      : 'ElevenLabs rejected this API key.';
  }
  if (status === 402 || code === 'insufficient_credits') {
    return 'The ElevenLabs account has no credit left for this transcription.';
  }
  if (status === 403) return 'This ElevenLabs key is not allowed to use speech-to-text.';
  if (status === 404) return 'The ElevenLabs speech-to-text endpoint was not found.';
  if (status === 413) return 'ElevenLabs refused the upload as too large.';
  if (status === 422) {
    return vendorMessage !== undefined
      ? `ElevenLabs rejected the request: ${vendorMessage}`
      : 'ElevenLabs rejected the request as invalid.';
  }
  if (status === 429) {
    return 'ElevenLabs is rate limiting this key, or the account is at its concurrent-transcription limit. Try again in a moment.';
  }
  if (status >= 500) return `ElevenLabs is having trouble (HTTP ${status}). Try again shortly.`;
  return vendorMessage !== undefined ? `ElevenLabs: ${vendorMessage}` : `ElevenLabs returned HTTP ${status}.`;
}

// ── models ────────────────────────────────────────────────────────────────────

let modelCache: { at: number; models: ProviderModel[] } | null = null;

function prettyModelId(id: string): string {
  // "scribe_v3" -> "Scribe v3". Only the first token is capitalized, because
  // "Scribe V3" reads like a product name that does not exist.
  const [head = id, ...rest] = id.split('_');
  return [titleCase(head), ...rest].join(' ');
}

function toProviderModel(id: string): ProviderModel {
  const note = MODEL_NOTES[id];
  const perHour = note?.pricePerHourUsd;
  return {
    id,
    label: note?.label ?? prettyModelId(id),
    description:
      note?.description ??
      'Listed by the ElevenLabs API but not known to this build of DropScribe. It should still work.',
    // Scribe detects the language itself and covers 90+ of them, so there is no
    // list worth showing — `null` means "any", which is different from "unknown".
    languages: null,
    // The vendor quotes $/hour while every other provider in this app quotes
    // $/minute. Converting here, once, is what lets the model picker put four
    // providers' prices in one column. Rounded because the raw quotient is
    // 0.0036666666666666666 and that gets written to settings.json verbatim.
    ...(perHour !== undefined ? { pricePerMinuteUsd: Math.round((perHour / 60) * 1e6) / 1e6 } : {}),
    capabilities: {
      diarization: true,
      wordTimestamps: true,
      // Scribe transcribes in the spoken language only; there is no translate
      // task on this endpoint. Saying so lets the UI disable the checkbox
      // instead of letting the user ask for something that silently won't happen.
      translate: false,
    },
  };
}

/**
 * Recommended first, deprecated last, anything new in between.
 *
 * A model id this build has never heard of might be better than Scribe v2 or
 * might be a niche variant; it sorts above the model ElevenLabs itself calls
 * superseded, and below the one this app has actually been run against.
 */
function modelRank(id: string): number {
  if (id === 'scribe_v2') return 0;
  if (id === 'scribe_v1') return 2;
  return 1;
}

function toModelList(ids: readonly string[]): ProviderModel[] {
  const unique: string[] = [];
  for (const id of ids) {
    if (id.length > 0 && !unique.includes(id)) unique.push(id);
  }
  unique.sort((a, b) => modelRank(a) - modelRank(b) || a.localeCompare(b));
  return unique.map(toProviderModel);
}

/**
 * Read the accepted `model_id` values straight out of the public OpenAPI spec.
 *
 * Every step of the walk is checked rather than asserted, because surviving a
 * restructured document is the entire reason this function exists: if the enum
 * ever moves behind a `$ref`, `dig` returns `undefined` and the caller falls
 * back to the hardcoded ids instead of throwing on a background refresh.
 *
 * The document is public — no key — and about 2 MB, which is why the result is
 * cached rather than fetched per call.
 */
async function fetchModelIds(parent: AbortSignal): Promise<string[] | null> {
  const deadline = withDeadline(parent, SPEC_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAPI_URL, { headers: { accept: 'application/json' }, signal: deadline.signal });
    if (!res.ok) return null;
    const spec: unknown = parseJson(await res.text());
    const modelId = dig(
      spec,
      'paths',
      '/v1/speech-to-text',
      'post',
      'requestBody',
      'content',
      'multipart/form-data',
      'schema',
      'properties',
      'model_id',
    );
    const values = modelId?.['enum'];
    if (!Array.isArray(values)) return null;
    const ids = values
      .filter((v): v is string => typeof v === 'string')
      // The realtime ids live in the WebSocket API and are rejected by this
      // endpoint's enum; if one ever leaks into the batch schema it would give
      // the user a model that 422s on every file.
      .filter((v) => !v.includes('realtime'));
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  } finally {
    deadline.release();
  }
}

/** Never throws: a model list is a convenience, and the fallback is always right enough to transcribe with. */
async function loadModels(signal: AbortSignal, force = false): Promise<ProviderModel[]> {
  const cached = modelCache;
  // `force` is the Refresh models button. Without it that button did nothing at
  // all for six hours after the first successful fetch: it went through
  // `listModels`, hit this cache, and returned the same list it already had, so
  // a model ElevenLabs added this morning stayed invisible until the afternoon
  // with no way to ask again.
  if (!force && cached !== null && Date.now() - cached.at < MODEL_CACHE_MS) return cached.models;
  const ids = await fetchModelIds(signal);
  const models = toModelList(ids ?? FALLBACK_MODEL_IDS);
  // Only a real answer is cached. Caching the fallback would hide a recovered
  // network for six hours.
  if (ids !== null) modelCache = { at: Date.now(), models };
  return models;
}

// ── key test ──────────────────────────────────────────────────────────────────

/**
 * "Creator plan · key …a91f · 84,120 characters left".
 *
 * The character figure is the text-to-speech quota, not the speech-to-text one
 * — Scribe is billed by the hour and the subscription endpoint has no hours
 * field — so it is included as a way to recognise *which* account this is, not
 * as a budget for transcription.
 */
function describeAccount(subscription: unknown, keyTail: string | undefined): string | undefined {
  const parts: string[] = [];
  const tier = isRecord(subscription) ? str(subscription['tier']) : undefined;
  if (tier !== undefined && tier.length > 0) parts.push(`${titleCase(tier)} plan`);
  if (keyTail !== undefined) parts.push(`key …${keyTail}`);
  if (isRecord(subscription)) {
    const used = num(subscription['character_count']);
    const limit = num(subscription['character_limit']);
    if (used !== undefined && limit !== undefined && limit > 0) {
      const left = Math.max(0, Math.round(limit - used));
      parts.push(`${left.toLocaleString('en-US')} characters left`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * The last four characters of the server's own key preview.
 *
 * `xi_api_key_preview` is meant for display, but this app cannot verify how much
 * of the key it contains, and `KeyTestResult` is persisted to settings.json —
 * so it is trimmed to the same four-character tail the credential store uses
 * everywhere else. Nothing that could reconstruct a key reaches disk.
 */
function keyTailFrom(user: unknown): string | undefined {
  const preview = isRecord(user) ? str(user['xi_api_key_preview']) : undefined;
  if (preview === undefined) return undefined;
  const trimmed = preview.trim();
  return trimmed.length >= 4 ? trimmed.slice(-4) : undefined;
}

// ── transcript conversion ─────────────────────────────────────────────────────

/** One entry of the response `words` array, already in this app's units. */
interface RawEntry {
  text: string;
  /** `null` when ElevenLabs reported no timing for this entry. */
  startMs: number | null;
  endMs: number | null;
  /** `word` | `spacing` | `audio_event`, or whatever a future version adds. */
  kind: string;
  speaker: string | null;
  logprob: number | null;
}

interface Chunk {
  languageCode: string | null;
  languageProbability: number | null;
  text: string;
  entries: RawEntry[];
  durationSecs: number | null;
}

/**
 * Float seconds to integer milliseconds, rounded once, here.
 *
 * `14.3 * 1000` is 14299.999999999998; truncating it loses a millisecond on
 * every single cue, and the losses accumulate visibly over an hour of subtitles.
 */
function secondsToMs(value: unknown): number | null {
  const seconds = num(value);
  return seconds === undefined ? null : Math.round(seconds * 1000);
}

function readEntries(value: unknown): RawEntry[] {
  if (!Array.isArray(value)) return [];
  const out: RawEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const text = str(item['text']);
    if (text === undefined) continue;
    out.push({
      text,
      startMs: secondsToMs(item['start']),
      endMs: secondsToMs(item['end']),
      kind: str(item['type']) ?? 'word',
      speaker: str(item['speaker_id']) ?? null,
      logprob: num(item['logprob']) ?? null,
    });
  }
  return out;
}

function readChunk(body: Record<string, unknown>): Chunk {
  return {
    languageCode: str(body['language_code'])?.toLowerCase() ?? null,
    languageProbability: num(body['language_probability']) ?? null,
    text: str(body['text']) ?? '',
    entries: readEntries(body['words']),
    durationSecs: num(body['audio_duration_secs']) ?? null,
  };
}

/**
 * One response shape or the other.
 *
 * With `use_multi_channel=true` the body is `{transcripts:[…]}` with NO
 * top-level `text`. This app never asks for that, but the branch costs four
 * lines and the alternative — a future option flipping the shape and producing
 * a silently empty transcript — costs a bug report nobody can reproduce.
 */
function readChunks(body: unknown): Chunk[] {
  if (!isRecord(body)) return [];
  const transcripts = body['transcripts'];
  if (Array.isArray(transcripts) && typeof body['text'] !== 'string') {
    return transcripts.filter(isRecord).map(readChunk);
  }
  return [readChunk(body)];
}

/** `logprob` is a natural log of a probability, so `exp` puts it back on 0..1. */
function confidenceFrom(logprob: number | null): number | undefined {
  if (logprob === null) return undefined;
  const p = Math.exp(logprob);
  if (!Number.isFinite(p)) return undefined;
  return Math.min(1, Math.max(0, p));
}

/** A word plus the whitespace that separated it from the word before it. */
interface Placed {
  word: Word;
  separatorBefore: string;
}

/**
 * Words, with the `spacing` entries consumed rather than dropped.
 *
 * ElevenLabs splits the stream into `word` entries and `spacing` entries, and
 * the spacing entries carry the actual whitespace. Dropping them and joining
 * words with `' '` looks identical in English and is wrong in Japanese, Chinese
 * and Thai, where the model emits no spacing at all and a joined-with-spaces
 * transcript reads as broken. So spacing never becomes a `Word` — it becomes
 * the separator between two of them.
 */
function buildWords(entries: readonly RawEntry[], keepSpeaker: boolean): Placed[] {
  // If a response carries no spacing entries whatsoever there is nothing to
  // reconstruct from, and a single space is the least-bad guess for the
  // space-separated scripts that make up most of this API's traffic.
  const defaultSeparator = entries.some((e) => e.kind === 'spacing') ? '' : ' ';
  const placed: Placed[] = [];
  let pending = '';
  let cursorMs = 0;

  for (const entry of entries) {
    if (entry.kind === 'spacing') {
      pending += entry.text;
      continue;
    }
    if (entry.kind === 'audio_event' && !TAG_AUDIO_EVENTS) {
      // We asked for no audio events. If one arrives anyway it is dropped here
      // rather than in the exporter, so `(laughter)` can never reach a cue.
      continue;
    }

    const startMs = entry.startMs ?? cursorMs;
    const endMs = Math.max(entry.endMs ?? startMs, startMs);
    cursorMs = endMs;

    const confidence = confidenceFrom(entry.logprob);
    const speaker = entry.speaker;
    const word: Word = {
      text: entry.text,
      startMs,
      endMs,
      ...(confidence !== undefined ? { confidence } : {}),
      // Scribe labels every word `speaker_0` even when diarization was not
      // requested. Carrying that through would make a non-diarized transcript
      // look diarized and prefix every subtitle line with a speaker name.
      ...(keepSpeaker && speaker !== null && speaker.length > 0 ? { speaker } : {}),
    };

    let separatorBefore = '';
    if (placed.length > 0) {
      if (pending.length === 0) separatorBefore = defaultSeparator;
      // A run of whitespace collapses to one space — it can only be a run
      // because a dropped audio event left the spacing on both sides of it.
      else separatorBefore = pending.trim().length === 0 ? ' ' : pending;
    }
    placed.push({ word, separatorBefore });
    pending = '';
  }

  return placed;
}

/**
 * Group words into engine-level segments: a new one on a speaker change, and on
 * any silence longer than `GAP_BREAK_MS`.
 *
 * Nothing here knows about line length or reading speed. Those belong to
 * `resegment`, which runs later and can be re-run with different settings
 * without going back to the provider.
 */
function groupSegments(placed: readonly Placed[]): Segment[] {
  const segments: Segment[] = [];
  let current: Placed[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const items = current;
    current = [];
    const first = items[0];
    if (first === undefined) return;
    const words = items.map((item) => item.word);
    const text = items
      .map((item, index) => (index === 0 ? '' : item.separatorBefore) + item.word.text)
      .join('')
      .trim();
    let startMs = first.word.startMs;
    let endMs = first.word.endMs;
    for (const word of words) {
      startMs = Math.min(startMs, word.startMs);
      endMs = Math.max(endMs, word.endMs);
    }
    const speaker = first.word.speaker;
    segments.push({ startMs, endMs, text, words, ...(speaker !== undefined ? { speaker } : {}) });
  };

  let previousEndMs: number | null = null;
  let previousSpeaker: string | undefined;
  for (const item of placed) {
    const speaker = item.word.speaker;
    const gapMs = previousEndMs === null ? 0 : item.word.startMs - previousEndMs;
    if (current.length > 0 && (speaker !== previousSpeaker || gapMs > GAP_BREAK_MS)) flush();
    current.push(item);
    previousEndMs = item.word.endMs;
    previousSpeaker = speaker;
  }
  flush();
  return segments;
}

function toTranscript(body: unknown, request: CloudRequest): Transcript {
  const chunks = readChunks(body);
  const keepSpeaker = request.options.diarize;

  const segments: Segment[] = [];
  for (const chunk of chunks) segments.push(...groupSegments(buildWords(chunk.entries, keepSpeaker)));

  const wholeText = chunks
    .map((chunk) => chunk.text.trim())
    .filter((text) => text.length > 0)
    .join('\n');

  if (segments.length === 0 && wholeText.length === 0) {
    throw new Error('ElevenLabs returned an empty transcript. The file may contain no speech it could recognise.');
  }

  // Duration comes from ffprobe, because the engine's own figure is what it
  // decoded rather than what the file is, and every clamp downstream keys off
  // this number. `audio_duration_secs` is only the fallback for a job that
  // reached here without a probe.
  let durationMs = Math.round(request.durationMs);
  if (!(durationMs > 0)) {
    const vendorSecs = chunks.reduce<number | null>(
      (best, chunk) => (chunk.durationSecs === null ? best : Math.max(best ?? 0, chunk.durationSecs)),
      null,
    );
    const lastEnd = segments.reduce((max, segment) => Math.max(max, segment.endMs), 0);
    durationMs = vendorSecs !== null ? Math.round(vendorSecs * 1000) : lastEnd;
  }

  if (segments.length === 0) {
    // Text but no word timings: still a usable transcript for txt/md export, and
    // `resegment` will fall back to its no-timing path for subtitles.
    segments.push({ startMs: 0, endMs: durationMs, text: wholeText, words: [] });
  }

  const languageChunk = chunks.find((chunk) => chunk.languageCode !== null);
  const languageConfidence = languageChunk?.languageProbability ?? null;
  const modelLabel = MODEL_NOTES[request.modelId]?.label ?? prettyModelId(request.modelId);

  return normalizeTranscript({
    language: languageChunk?.languageCode ?? null,
    ...(languageConfidence !== null ? { languageConfidence } : {}),
    durationMs,
    segments,
    source: {
      kind: 'cloud',
      engineId: 'elevenlabs',
      modelId: request.modelId,
      label: `${modelLabel} · ElevenLabs`,
    },
    createdAt: new Date().toISOString(),
  });
}

// ── upload helpers ────────────────────────────────────────────────────────────

const UPLOAD_MIME: Readonly<Record<string, string>> = {
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.3gp': 'video/3gpp',
};

function uploadMime(filePath: string): string {
  return UPLOAD_MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

// ── the adapter ───────────────────────────────────────────────────────────────

export const elevenLabsAdapter: ProviderAdapter = {
  id: 'elevenlabs',

  async testKey(apiKey: string, signal: AbortSignal): Promise<KeyTestResult> {
    // `/v1/user/subscription` is the cheapest authenticated call in the API: it
    // costs no credits and it answers "is this key good" and "whose account is
    // it" in one round trip. Transcribing a one-second file to test a key would
    // bill the user for the privilege.
    const deadline = withDeadline(signal, KEY_TEST_TIMEOUT_MS);
    let raw: string;
    let ok: boolean;
    let status: number;
    let requestId: string | null;
    try {
      const res = await fetch(SUBSCRIPTION_URL, { headers: authHeaders(apiKey), signal: deadline.signal });
      ok = res.ok;
      status = res.status;
      requestId = res.headers.get('request-id');
      raw = await res.text();
    } catch (error) {
      if (signal.aborted) return { ok: false, message: 'The connection test was cancelled.' };
      if (deadline.timedOut()) return { ok: false, message: 'ElevenLabs did not answer within 20 seconds.' };
      return { ok: false, message: networkMessage(error) };
    } finally {
      deadline.release();
    }

    if (!ok) return { ok: false, message: describeFailure(status, raw, requestId).message };

    const subscription = parseJson(raw);

    // Two follow-ups the answer does not depend on: the key preview, and the
    // model list. Both are allowed to fail — the key is already proven good, and
    // reporting "invalid key" because a second, unrelated request timed out
    // would send the user to regenerate a working key.
    const [userResult, models] = await Promise.all([
      (async (): Promise<unknown> => {
        const followUp = withDeadline(signal, KEY_TEST_TIMEOUT_MS);
        try {
          const res = await fetch(USER_URL, { headers: authHeaders(apiKey), signal: followUp.signal });
          return res.ok ? parseJson(await res.text()) : undefined;
        } catch {
          return undefined;
        } finally {
          followUp.release();
        }
      })(),
      loadModels(signal),
    ]);

    const account = describeAccount(subscription, keyTailFrom(userResult));
    return {
      ok: true,
      message: 'Connected to ElevenLabs.',
      ...(account !== undefined ? { account } : {}),
      // Handing the models back with the test result is what lets the model
      // picker populate the instant the key checks out, with no second spinner.
      models,
    };
  },

  // The spec document is public, so the key is genuinely unused here. It stays
  // in the signature because every other provider needs one.
  async listModels(
    _apiKey: string,
    signal: AbortSignal,
    options?: { force?: boolean },
  ): Promise<ProviderModel[]> {
    return loadModels(signal, options?.force ?? false);
  },

  async transcribe(request: CloudRequest, ctx: CloudContext): Promise<Transcript> {
    const { apiKey, modelId, filePath, options } = request;

    let blob: Blob;
    try {
      // `openAsBlob` keeps the file on disk and streams it out of the multipart
      // body. Reading it into a Buffer first would put an entire movie in the
      // main process's heap for the length of the upload.
      blob = await openAsBlob(filePath, { type: uploadMime(filePath) });
    } catch (error) {
      throw new Error('The audio file could not be opened for upload.', { cause: error });
    }

    const form = new FormData();
    form.append('model_id', modelId);
    form.append('file', blob, basename(filePath));
    // Word timings are free on this endpoint and they are the only thing that
    // lets `resegment` cut cues on real boundaries later, so they are always
    // requested — asking for `none` would save nothing and leave the exporter
    // with a single cue spanning the whole file.
    form.append('timestamps_granularity', 'word');
    form.append('tag_audio_events', String(TAG_AUDIO_EVENTS));
    if (options.language !== null && options.language.length > 0) {
      form.append('language_code', options.language);
    }
    if (options.diarize) form.append('diarize', 'true');
    // `options.translate` has no counterpart here: Scribe transcribes in the
    // spoken language and the endpoint has no translate task. The model's
    // `capabilities.translate: false` is how the UI is told; silently not
    // translating is the documented behaviour of a provider that cannot.

    // The endpoint is synchronous and reports nothing until it is finished, so
    // there is no honest percentage to give — one stage that covers the upload
    // and the wait beats a progress bar this adapter would have to invent.
    ctx.onProgress(null, 'Uploading and transcribing');

    let res: Response;
    try {
      // `longFetch`, not global fetch: the comment at the top of this file
      // already names undici's five-minute header timeout as something that
      // fires on a long file "even though nothing is actually wrong". It no
      // longer fires — see providers/types.ts.
      res = await longFetch(STT_URL, {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: form,
        signal: ctx.signal,
      });
    } catch (error) {
      if (isAbort(error) || ctx.signal.aborted) throw error;
      throw new Error(networkMessage(error), { cause: error });
    }

    ctx.onProgress(null, 'Building transcript');

    const requestId = res.headers.get('request-id');
    const raw = await res.text();
    if (!res.ok) {
      const failure = describeFailure(res.status, raw, requestId);
      throw new Error(failure.message, { cause: failure.detail });
    }

    const body = parseJson(raw);
    if (body === undefined) {
      throw new Error('ElevenLabs returned a response this app could not read.', {
        cause: raw.slice(0, 2000),
      });
    }
    return toTranscript(body, request);
  },
};

/**
 * Aliases.
 *
 * `providers/index.ts` is written alongside this file and only the interface was
 * agreed, not the export name. An extra binding costs nothing and turns a
 * guessed import into a working one.
 */
export const elevenlabsAdapter = elevenLabsAdapter;
export const elevenLabsProvider = elevenLabsAdapter;
export default elevenLabsAdapter;
