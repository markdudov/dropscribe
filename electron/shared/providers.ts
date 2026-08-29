/**
 * Cloud speech-to-text providers the user brings their own key for.
 *
 * Four providers, four completely different APIs. What they have in common is
 * only what this file declares: a key can be tested, models can be listed, and
 * a file can be transcribed into the one `Transcript` shape. Everything
 * provider-specific — auth header name, whether the model list needs the key at
 * all, which of three error-body shapes comes back — is buried in the adapter
 * under `electron/providers/`.
 *
 * No adapter is allowed to leak its own response types past this boundary. That
 * is what makes adding a fifth provider a one-file change.
 */

export type ProviderId = 'deepinfra' | 'deepgram' | 'elevenlabs' | 'openrouter';

export const PROVIDER_IDS: readonly ProviderId[] = ['deepinfra', 'deepgram', 'elevenlabs', 'openrouter'];

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  /** One line in the settings list, before a key is entered. */
  blurb: string;
  /** Ghost text in the key field. Shows the shape without showing a real key. */
  keyPlaceholder: string;
  /** Where the user gets a key. Opened via a semantic id, never a renderer-supplied URL. */
  keyUrl: string;
  docsUrl: string;
  /** Billing unit, shown next to a model's price. */
  priceUnit: 'per-minute' | 'per-hour';
  /**
   * A hard ceiling on the compressed upload, in bytes, where the provider
   * publishes one.
   *
   * It lives here rather than inside the adapter because the QUEUE has to know
   * it before the adapter is ever called: the upload is encoded once, by
   * `compressForUpload`, and the bitrate it picks has to fit. Bug 0002 is
   * exactly what happens when a number like this is known in one module and
   * assumed in another — the encoder changed, the cap did not move, and jobs
   * started failing before they reached the network.
   *
   * Absent means the provider publishes no figure. It does not mean unlimited;
   * it means we have nothing to fit to and will send what we would have sent.
   */
  maxUploadBytes?: number;
}

export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    blurb: 'Whisper large-v3 and large-v3-turbo, plus Voxtral and Qwen3-ASR.',
    keyPlaceholder: 'Bearer token from the DeepInfra dashboard',
    keyUrl: 'https://deepinfra.com/dash/api_keys',
    docsUrl: 'https://docs.deepinfra.com/apis/speech',
    priceUnit: 'per-minute',
  },
  {
    id: 'deepgram',
    label: 'Deepgram',
    blurb: 'Nova-3 and Nova-2. Fast, strong diarization, 100+ languages.',
    keyPlaceholder: 'Deepgram API key',
    keyUrl: 'https://console.deepgram.com/signup',
    docsUrl: 'https://developers.deepgram.com/docs/pre-recorded-audio',
    priceUnit: 'per-minute',
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    blurb: 'Scribe v2. 90+ languages, speaker diarization and audio-event tags.',
    keyPlaceholder: 'sk_…',
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    docsUrl: 'https://elevenlabs.io/docs/api-reference/speech-to-text',
    priceUnit: 'per-hour',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    blurb: 'One key for many vendors’ audio models, routed through a single endpoint.',
    keyPlaceholder: 'sk-or-v1-…',
    keyUrl: 'https://openrouter.ai/keys',
    docsUrl: 'https://openrouter.ai/docs',
    priceUnit: 'per-minute',
    // 17 MiB. OpenRouter documents a 25 MB request limit and the audio travels
    // base64-encoded, which inflates by 4/3 — 17 MiB of audio becomes ~23.8 MB
    // of body, under the published figure whichever side of the encoding they
    // measure. The adapter enforces it; the queue encodes to fit it.
    maxUploadBytes: 17 * 1024 * 1024,
  },
];

export function findProvider(id: ProviderId): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export interface ProviderModelCapabilities {
  diarization?: boolean;
  wordTimestamps?: boolean;
  /** The model can translate to English in the same call. */
  translate?: boolean;
}

export interface ProviderModel {
  /** The exact string sent to the API. Never a display name — Deepgram's `name` field is not unique. */
  id: string;
  label: string;
  description?: string;
  /** `null` or absent means the model detects or accepts any language. */
  languages?: string[] | null;
  /** USD, normalized to per minute of audio regardless of how the vendor quotes it. */
  pricePerMinuteUsd?: number;
  capabilities?: ProviderModelCapabilities;
}

/**
 * The outcome of the Test connection button.
 *
 * `message` is written for the user and is displayed verbatim, so it must never
 * contain a stack trace, a URL with the key in it, or the key itself.
 */
export interface KeyTestResult {
  ok: boolean;
  message: string;
  /** Whatever identifies the account: an email, a plan name, a project name. */
  account?: string;
  /**
   * Models discovered during the test. Present when one round trip can answer
   * both questions, which is the common case — it is what lets the model picker
   * populate the instant the key checks out.
   */
  models?: ProviderModel[];
}

/** Options a job passes to a cloud adapter. Not every provider honours every field. */
export interface CloudOptions {
  /** ISO-639-1, or `null` to let the provider detect. */
  language: string | null;
  diarize: boolean;
  /** Ask for word-level timings where the provider charges nothing extra for them. */
  wordTimestamps: boolean;
  /** Translate to English instead of transcribing, where supported. */
  translate: boolean;
}

export const DEFAULT_CLOUD_OPTIONS: CloudOptions = {
  language: null,
  diarize: false,
  wordTimestamps: true,
  translate: false,
};
