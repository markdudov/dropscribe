/**
 * The catalogue of local models the app can download and run.
 *
 * Every entry is pinned by size and SHA-256, taken from Hugging Face's own LFS
 * metadata rather than measured after a download — a hash computed from bytes
 * you already trusted proves nothing. `scripts/verify-model-catalogue.mjs`
 * re-reads them from the API so a silently re-uploaded file is caught in CI
 * instead of by a user with a half-working model.
 *
 * Both engines are whisper.cpp binaries. That is not a coincidence worth
 * hiding: since b4938 whisper.cpp ships `parakeet-cli` alongside `whisper-cli`,
 * both reading GGML/GGUF weights and both accelerated by the same Metal /
 * CPU backend. The alternative considered was sherpa-onnx for Parakeet, which
 * would have meant a second runtime, a second model format (ONNX encoder /
 * decoder / joiner / tokens quartet) and a second set of platform binaries to
 * sign. One engine family is why this app has no ONNX Runtime in it at all.
 */

export type EngineId = 'whisper-cpp' | 'parakeet-cpp';

export interface LocalModel {
  /** Stable id used in settings, IPC and the on-disk file name. Never change one. */
  id: string;
  /** What the user sees in the picker. */
  label: string;
  /** One line under the label explaining the trade-off. */
  blurb: string;
  engine: EngineId;
  /** Direct download URL. Hugging Face `resolve` URLs redirect to a CDN. */
  url: string;
  /** File name on disk under `<userData>/models/`. */
  fileName: string;
  /** Exact byte count, for the progress bar and as a first integrity check. */
  bytes: number;
  /** Lowercase hex SHA-256 of the file, from the Hugging Face LFS metadata. */
  sha256: string;
  /** Licence of the WEIGHTS, which is not the licence of this app. */
  license: string;
  /** Where the weights come from, shown in the licence panel. */
  source: string;
  /** Roughly how much RAM the model needs resident. Used for a pre-flight warning. */
  approxRamMb: number;
  /** `null` means the model detects the language itself. */
  languages: string[] | null;
  /** Marks the entry the app suggests first for its engine. */
  recommended?: boolean;
}

const HF = 'https://huggingface.co';
const WHISPER_REPO = `${HF}/ggerganov/whisper.cpp/resolve/main`;
const PARAKEET_REPO = `${HF}/ggml-org/parakeet-GGUF/resolve/main`;

export const LOCAL_MODELS: readonly LocalModel[] = [
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper large-v3-turbo',
    blurb: 'The fast one. Near large-v3 accuracy at a fraction of the time. Start here.',
    engine: 'whisper-cpp',
    url: `${WHISPER_REPO}/ggml-large-v3-turbo.bin`,
    fileName: 'ggml-large-v3-turbo.bin',
    bytes: 1_624_555_275,
    sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
    license: 'MIT',
    source: 'openai/whisper-large-v3-turbo, converted to GGML by ggerganov/whisper.cpp',
    approxRamMb: 1800,
    languages: null,
    recommended: true,
  },
  {
    id: 'whisper-large-v3-turbo-q5',
    label: 'Whisper large-v3-turbo (quantized)',
    blurb: 'Same model at 5-bit. A third of the disk and memory, a small accuracy cost.',
    engine: 'whisper-cpp',
    url: `${WHISPER_REPO}/ggml-large-v3-turbo-q5_0.bin`,
    fileName: 'ggml-large-v3-turbo-q5_0.bin',
    bytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    license: 'MIT',
    source: 'openai/whisper-large-v3-turbo, converted and quantized by ggerganov/whisper.cpp',
    approxRamMb: 800,
    languages: null,
  },
  {
    id: 'whisper-large-v3',
    label: 'Whisper large-v3',
    blurb: 'The accurate one. Noticeably slower than turbo, and worth it on hard audio.',
    engine: 'whisper-cpp',
    url: `${WHISPER_REPO}/ggml-large-v3.bin`,
    fileName: 'ggml-large-v3.bin',
    bytes: 3_095_033_483,
    sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
    license: 'MIT',
    source: 'openai/whisper-large-v3, converted to GGML by ggerganov/whisper.cpp',
    approxRamMb: 3400,
    languages: null,
  },
  {
    id: 'whisper-large-v3-q5',
    label: 'Whisper large-v3 (quantized)',
    blurb: 'large-v3 at 5-bit. Fits comfortably in 8 GB of RAM.',
    engine: 'whisper-cpp',
    url: `${WHISPER_REPO}/ggml-large-v3-q5_0.bin`,
    fileName: 'ggml-large-v3-q5_0.bin',
    bytes: 1_081_140_203,
    sha256: 'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1',
    license: 'MIT',
    source: 'openai/whisper-large-v3, converted and quantized by ggerganov/whisper.cpp',
    approxRamMb: 1400,
    languages: null,
  },
  {
    id: 'parakeet-tdt-0.6b-v3',
    label: 'Parakeet TDT 0.6B v3',
    blurb: 'NVIDIA’s multilingual model. Very fast, 25 European languages, punctuation included.',
    engine: 'parakeet-cpp',
    url: `${PARAKEET_REPO}/ggml-parakeet-tdt-0.6b-v3-q8_0.bin`,
    fileName: 'ggml-parakeet-tdt-0.6b-v3-q8_0.bin',
    bytes: 668_757_119,
    sha256: '4d64e9e96c2792186d072fde0034df0ad670cf680a2f53069052ead827fd600e',
    license: 'CC-BY-4.0',
    source: 'nvidia/parakeet-tdt-0.6b-v3, converted to GGML by ggml-org/parakeet-GGUF',
    approxRamMb: 1000,
    // Parakeet v3 is trained on exactly these 25 languages and does not detect
    // anything outside them — unlike Whisper, which will attempt any of 99.
    // Listing them is what lets the UI warn before a job produces nonsense.
    languages: [
      'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu',
      'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk',
    ],
    recommended: true,
  },
  {
    id: 'parakeet-tdt-0.6b-v3-f16',
    label: 'Parakeet TDT 0.6B v3 (F16)',
    blurb: 'Full-precision Parakeet. Marginally more accurate, noticeably larger.',
    engine: 'parakeet-cpp',
    url: `${PARAKEET_REPO}/ggml-parakeet-tdt-0.6b-v3-f16.bin`,
    fileName: 'ggml-parakeet-tdt-0.6b-v3-f16.bin',
    bytes: 1_255_897_319,
    sha256: '833bffc9513b2cae867ee9e51633cfd11e4d51aaa5597c8ac02159385a2b426f',
    license: 'CC-BY-4.0',
    source: 'nvidia/parakeet-tdt-0.6b-v3, converted to GGML by ggml-org/parakeet-GGUF',
    approxRamMb: 1700,
    languages: [
      'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu',
      'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk',
    ],
  },
];

export function findLocalModel(id: string): LocalModel | undefined {
  return LOCAL_MODELS.find((m) => m.id === id);
}

/** Human-readable byte size, for the download UI. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit] ?? 'B'}`;
}
