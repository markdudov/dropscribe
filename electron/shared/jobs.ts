/**
 * One dropped file's journey, as both processes see it.
 *
 * A job is created the moment a path is accepted and lives until the user
 * clears it. Main owns the truth; the renderer holds a copy kept in step by
 * `job:updated` events. The renderer never mutates a job except through IPC.
 */

import type { ProviderId } from './providers';
import type { Transcript } from './transcript';

/** What the user chose to run this file through. */
export type TranscribeTarget =
  | { kind: 'local'; modelId: string }
  | { kind: 'cloud'; providerId: ProviderId; modelId: string };

export type JobStatus =
  | 'queued'
  /** ffprobe + audio extraction. Fast, but not instant on a 4 GB movie. */
  | 'preparing'
  | 'running'
  | 'done'
  | 'failed'
  /** The user cancelled. Distinct from `failed` so the UI does not cry wolf. */
  | 'cancelled';

export interface JobProgress {
  /** 0..100, or `null` while the stage cannot report a fraction. */
  percent: number | null;
  /** A short phrase for the UI: `Extracting audio`, `Transcribing`, `Uploading`. */
  stage: string;
}

/**
 * A failure the user can act on.
 *
 * `message` is user-facing and shown verbatim. `detail` is the engine's own
 * output, shown only behind a disclosure — it is where the ffmpeg stderr or the
 * provider's error body goes, and it must never contain the API key.
 */
export interface JobError {
  message: string;
  detail?: string;
  /** True when retrying without changing anything could plausibly work. */
  retryable: boolean;
}

export interface Job {
  id: string;
  /** Absolute path. Authorized by main before it is ever used. */
  filePath: string;
  fileName: string;
  bytes: number;
  /** From ffprobe, once `preparing` has run. `null` before that. */
  durationMs: number | null;
  target: TranscribeTarget;
  status: JobStatus;
  progress: JobProgress;
  transcript?: Transcript;
  error?: JobError;
  /** Epoch ms. Absent until the job leaves the queue. */
  startedAt?: number;
  finishedAt?: number;
}

export const TERMINAL_STATUSES: readonly JobStatus[] = ['done', 'failed', 'cancelled'];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Human label for a target, used in the job row and in exported JSON. */
export function targetLabel(target: TranscribeTarget, modelLabel: string, providerLabel?: string): string {
  return target.kind === 'local' ? `${modelLabel} (local)` : `${modelLabel} · ${providerLabel ?? target.providerId}`;
}
