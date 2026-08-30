/**
 * The contract every cloud provider adapter implements, plus the four helpers
 * all four of them turned out to need.
 *
 * The helpers live here rather than in a `providers/http.ts` for one reason:
 * they encode decisions that must be identical across adapters or the UI lies.
 * If DeepInfra reported a network outage as "fetch failed" and Deepgram
 * reported it as "TypeError", the same broken Wi-Fi would produce two different
 * job errors and the user would think they had two different problems. One
 * fetch wrapper, one status-code vocabulary, one error-body reader.
 *
 * Rule 6 of the project applies to every line below: an API key never reaches a
 * message, a URL, or a log. That is why `abortableFetch` takes the URL and the
 * init separately and never interpolates anything from the init into an error,
 * and why keys travel exclusively in headers — a key in a query string would be
 * printed by any proxy, any crash reporter, and `new URL(url).host` below.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { extensionOf } from '../shared/media-extensions';
import type { CloudOptions, KeyTestResult, ProviderId, ProviderModel } from '../shared/providers';
import type { Transcript } from '../shared/transcript';

/** One file, one model, one key. Everything an adapter needs to do its job. */
export interface CloudRequest {
  apiKey: string;
  modelId: string;
  /**
   * Absolute path to the file to upload. The queue has already compressed the
   * source to something small, but not to a fixed format: the encoder is chosen
   * from what the vendored ffmpeg was built with, so this is Ogg/Opus on one
   * build and MP4/AAC on another. Adapters upload what they are given and never
   * re-encode — only the queue knows what the source actually was — and they
   * read the container from this path's extension rather than assuming one.
   */
  filePath: string;
  /** From ffprobe. The authority on duration; a provider's own number is a claim. */
  durationMs: number;
  options: CloudOptions;
}

export interface CloudContext {
  signal: AbortSignal;
  /**
   * `percent` is `null` whenever the stage genuinely cannot be measured, which
   * for an HTTP transcription is most of it: the request is one round trip and
   * the server reports nothing until it is finished. Adapters pass `null`
   * rather than animating a made-up bar, so the UI can show an indeterminate
   * spinner instead of a progress bar that stalls at 90% for four minutes.
   */
  onProgress: (percent: number | null, stage: string) => void;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  /**
   * Never throws. A bad key, a refused connection and a cancelled test are all
   * `{ ok: false }` with a sentence the settings panel shows verbatim — the
   * caller is a button, and a button has nowhere to put an exception.
   */
  testKey(apiKey: string, signal: AbortSignal): Promise<KeyTestResult>;
  /**
   * `force` is what the Refresh models button means: go and ask, do not answer
   * from a cache. An adapter that keeps no cache may ignore it — most do.
   */
  listModels(apiKey: string, signal: AbortSignal, options?: { force?: boolean }): Promise<ProviderModel[]>;
  transcribe(request: CloudRequest, ctx: CloudContext): Promise<Transcript>;
}

/**
 * An HTTP failure from a provider, already phrased for the user.
 *
 * It is a plain `Error` subclass on purpose: callers that only do
 * `error instanceof Error ? error.message : String(error)` keep working and get
 * a sentence worth showing. Callers that care can read `status` and
 * `retryable` to decide whether the retry button is worth offering.
 */
export class ProviderError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  /** The provider's own error body, for the disclosure triangle. Never the key. */
  readonly detail: string | undefined;

  constructor(message: string, status: number, retryable: boolean, detail?: string) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}

/**
 * `fetch` with the job's cancellation wired in and network failures translated.
 *
 * The signal is applied last and overwrites anything in `init`, so an adapter
 * cannot accidentally pass its own signal and become uncancellable — a stuck
 * upload that ignores Cancel is the worst bug this layer can have.
 *
 * There is deliberately no timeout. A 90-minute recording legitimately keeps
 * the connection open for minutes with nothing on the wire, and every fixed
 * timeout we could pick would be wrong for either the long files or the short
 * ones. Cancellation is the user's timeout, and it is always available.
 */
export async function abortableFetch(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  // Cheap short-circuit: if the job was cancelled while we were reading the
  // file off disk, do not open a socket just to abort it a millisecond later.
  signal.throwIfAborted();

  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    // undici rejects with an AbortError whose shape differs across runtimes.
    // Re-throwing the signal's own reason gives every adapter one thing to
    // check, and keeps "the user pressed Cancel" from being reported as a
    // network fault in the job list.
    signal.throwIfAborted();
    throw new Error(
      `Could not reach ${hostOf(url)}. Check your internet connection and try again.`,
      { cause: error },
    );
  }
}

/**
 * Throw a user-facing error unless the response is a 2xx.
 *
 * Reads the body ONLY on failure. On success it returns without touching the
 * stream, because a consumed body cannot be read again and the caller still
 * needs its JSON.
 */
export async function assertOk(response: Response, providerLabel: string): Promise<void> {
  if (response.ok) return;

  const raw = await readBodyText(response);
  const parsed = parseMaybeJson(raw);
  const fromBody = readErrorMessage(parsed);
  const status = response.status;

  // The status code decides what the user should DO; the provider's own message
  // is appended only when it adds something, because "Bad Request" repeated in
  // two registers helps nobody.
  const base = ((): string => {
    if (status === 400 || status === 422) return `${providerLabel} rejected the request.`;
    if (status === 401 || status === 403) return `${providerLabel} rejected the API key. Check it in Settings.`;
    if (status === 402) return `${providerLabel} reports no remaining credit on this account.`;
    if (status === 404) return `${providerLabel} does not know that model or endpoint.`;
    if (status === 413) return `The audio file is larger than ${providerLabel} accepts.`;
    if (status === 415) return `${providerLabel} does not accept this audio format.`;
    if (status === 429) return `${providerLabel} is rate limiting this key. Wait a moment and try again.`;
    if (status >= 500) return `${providerLabel} had a server error. This is usually temporary.`;
    return `${providerLabel} returned HTTP ${status}.`;
  })();

  // The provider's own sentence is appended only when it says something the
  // status line did not. Deepgram answering 429 with `{"err_msg":"Rate
  // limited"}` would otherwise produce "…is rate limiting this key. Wait a
  // moment and try again. Rate limited", which is the same fact three times.
  const message = fromBody !== null && addsInformation(base, fromBody)
    ? `${base} (${fromBody})`
    : base;

  // 408/425/429 and every 5xx are worth a retry button; a 401 or a 413 will
  // fail identically forever and offering Retry for them is a small lie.
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  const detail = raw.trim().length > 0 ? clip(raw.trim(), 2000) : undefined;
  throw new ProviderError(message, status, retryable, detail);
}

/**
 * Pull the human sentence out of whichever error envelope a provider uses.
 *
 * Four providers, five shapes, and DeepInfra alone uses three of them:
 * FastAPI's `{detail: "..."}` for auth, FastAPI's
 * `{detail: [{loc, msg, type}]}` for validation, and occasionally a nested
 * `{detail: {message}}`. Deepgram sends `{err_code, err_msg}`, ElevenLabs
 * sends `{detail: {status, message}}`, OpenRouter sends `{error: {message}}`.
 * Guessing wrong costs the user the only sentence that explains the failure,
 * so this reads all of them and returns `null` rather than inventing one.
 */
export function readErrorMessage(body: unknown): string | null {
  // A bare string body: usable only if it is not an HTML error page, which is
  // what a CDN or a proxy in front of the API returns and which would dump a
  // <!doctype html> into the job list.
  if (typeof body === 'string') return cleanSentence(looksLikeMarkup(body) ? '' : body);
  if (!isRecord(body)) return null;

  const detail = body['detail'];
  if (typeof detail === 'string') return cleanSentence(detail);

  if (Array.isArray(detail)) {
    // FastAPI 422: [{loc: ["body", "model"], msg: "field required", type: ...}]
    // The last element of `loc` is the field name, and naming the field is the
    // whole value of this shape — "field required" alone is useless.
    const parts: string[] = [];
    for (const item of detail) {
      if (!isRecord(item)) continue;
      const msg = item['msg'];
      if (typeof msg !== 'string' || msg.trim().length === 0) continue;
      const loc = item['loc'];
      const field = Array.isArray(loc)
        ? [...loc].reverse().find((p): p is string => typeof p === 'string' && p !== 'body')
        : undefined;
      parts.push(field !== undefined ? `${field}: ${msg.trim()}` : msg.trim());
    }
    return cleanSentence(parts.join('; '));
  }

  if (isRecord(detail)) {
    const nested = detail['message'] ?? detail['msg'] ?? detail['reason'];
    if (typeof nested === 'string') return cleanSentence(nested);
  }

  const errMsg = body['err_msg'];
  if (typeof errMsg === 'string') return cleanSentence(errMsg);

  const message = body['message'];
  if (typeof message === 'string') return cleanSentence(message);

  const error = body['error'];
  if (typeof error === 'string') return cleanSentence(error);
  if (isRecord(error)) {
    const nested = error['message'] ?? error['msg'];
    if (typeof nested === 'string') return cleanSentence(nested);
  }

  return null;
}

/**
 * Extension → MIME. Two jobs, and the second one is the load-bearing one.
 *
 * Most of this table is about what the user dropped: only what the four
 * provider APIs actually list as accepted, so nothing here promises a type a
 * provider would reject.
 *
 * The first five rows — ogg, mp3, wav, flac and m4a, with their aliases — are a
 * different obligation. Those are the containers *we* produce:
 * `compressForUpload` picks its encoder from whatever the vendored ffmpeg was
 * built with, and that set is not the same on macOS and Windows, so an upload
 * can arrive here as any of them and the call site cannot know which in
 * advance. Every one of them must resolve to a real type, because on all three
 * upload paths a wrong Content-Type changes how the bytes are read: Deepgram
 * takes the audio as a raw request body and picks its demuxer from the header,
 * and ElevenLabs and DeepInfra send multipart, where the part's declared type
 * travels with the file. Dropping one of these five rows does not degrade a
 * guess — it hands a provider `application/octet-stream` and buys a 415.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  mp3: 'audio/mpeg', mp2: 'audio/mpeg', mpga: 'audio/mpeg',
  wav: 'audio/wav', wave: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4', aac: 'audio/aac',
  webm: 'audio/webm',
  amr: 'audio/amr',
  aiff: 'audio/aiff', aif: 'audio/aiff', aifc: 'audio/aiff',
  caf: 'audio/x-caf',
  wma: 'audio/x-ms-wma',
  mp4: 'video/mp4', m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mpeg: 'video/mpeg', mpg: 'video/mpeg',
};

/**
 * Read a file into a `Blob` fit for `FormData`.
 *
 * Yes, this holds the whole file in memory. The alternative — streaming the
 * file into a hand-rolled multipart body — was rejected because `FormData` is
 * the only thing undici's `fetch` will build a correct boundary for, and
 * because of what the queue actually hands us: 16 kHz mono speech at 12–32
 * kbps, depending on which encoder the vendored ffmpeg had. A four-hour podcast
 * arrives here as roughly 22 MB with libopus and about 60 MB on a build that
 * fell back to AAC. Sixty megabytes held briefly in a Buffer is not the problem
 * worth solving; streaming would buy nothing and cost a multipart
 * implementation nobody wants to debug.
 *
 * The MIME type matters more than it looks: several of these APIs sniff the
 * declared type before they sniff the bytes, and an `application/octet-stream`
 * upload gets a 415 from at least one of them.
 */
export async function fileToBlob(filePath: string): Promise<Blob> {
  const bytes = await readFile(filePath);
  // `basename` first: `extensionOf` scans for the last dot in the whole string,
  // and a file with no extension inside `/Users/me/holiday.2019/audio` would
  // otherwise be typed from "2019/audio".
  const type = MIME_BY_EXTENSION[extensionOf(basename(filePath))] ?? 'application/octet-stream';
  // A fresh view over the same buffer: `Buffer` is a pooled slice of a larger
  // allocation, and handing that pool straight to `Blob` has historically
  // uploaded whichever neighbouring file shared the pool.
  return new Blob([new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)], { type });
}

// ── internals ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `null` for anything that is only whitespace, so callers get one empty case. */
function cleanSentence(value: string): string | null {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length === 0 ? null : clip(text, 300);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * True when `detail` contains a word `base` does not already cover.
 *
 * Compared on five-character stems so "limiting" and "limited" count as the
 * same claim, which is the whole point — providers phrase the status text in
 * their own tense and we are only trying to avoid saying it twice.
 */
function addsInformation(base: string, detail: string): boolean {
  const stems = (value: string): Set<string> =>
    new Set((value.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((word) => word.slice(0, 5)));
  const covered = stems(base);
  const wanted = [...stems(detail)].filter((word) => word.length > 2);
  if (wanted.length === 0) return false;
  return wanted.some((word) => !covered.has(word));
}

function looksLikeMarkup(value: string): boolean {
  return /^\s*(<!doctype|<html|<\?xml)/i.test(value);
}

function parseMaybeJson(raw: string): unknown {
  if (raw.trim().length === 0) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Not JSON — hand the raw text on, `readErrorMessage` knows to reject HTML.
    return raw;
  }
}

/** A body we cannot read must not turn a 401 into a stack trace. */
async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * Host only, never the path or the query. Providers put nothing secret in a
 * hostname, and this string ends up in a message the user can screenshot.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the provider';
  }
}
