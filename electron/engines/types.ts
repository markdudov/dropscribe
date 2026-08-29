/**
 * What every local engine looks like from the queue's side.
 *
 * There are exactly two local engines and both are whisper.cpp binaries, so an
 * abstraction here is nearly free — but it is not decoration. `whisper-cli` and
 * `parakeet-cli` disagree about almost everything that matters: one writes a
 * token-level JSON file and streams progress percentages on stderr, the other
 * writes the plain transcript on stdout, a per-token stream on stderr behind
 * `-ps`, and never reports progress at all — so one engine's progress is
 * measured and the other's is estimated from elapsed time. The queue must not know which of those it is driving, or
 * every future engine becomes a second `if` in `queue.ts`.
 *
 * Note what is deliberately absent from `LocalRunRequest`: the media path. By
 * the time an engine runs, `ffmpeg.ts` has already produced a 16 kHz mono
 * 16-bit WAV, because the dropped file is usually a video container that
 * neither binary can demux. An engine takes a WAV and nothing else.
 */

import type { EngineId } from '../shared/models';
import type { Transcript } from '../shared/transcript';

export interface LocalRunRequest {
  /** 16 kHz mono 16-bit WAV, already extracted. Never the user's original file. */
  wavPath: string;
  /** Absolute path to the GGML/GGUF weights under `<userData>/models/`. */
  modelPath: string;
  /**
   * Duration as measured by ffprobe. The engine is told this rather than asked,
   * because whisper's own idea of the length comes from the padded final decode
   * window and runs past the end of the audio.
   */
  durationMs: number;
  /** ISO-639-1 hint, or `null` to let the engine detect. Parakeet ignores it. */
  language: string | null;
  /** Translate to English instead of transcribing. Parakeet cannot. */
  translate: boolean;
  /** Already resolved from settings; `0` still means "choose for me". */
  threads: number;
}

export interface LocalRunContext {
  /**
   * Cancelled by the user. An engine must kill its child process on abort — an
   * orphaned whisper run holds a multi-gigabyte model resident and keeps every
   * core busy long after the row disappeared from the UI.
   */
  signal: AbortSignal;
  /** 0..100. Called only when the number actually moved forwards. */
  onProgress: (percent: number) => void;
}

export interface LocalEngine {
  readonly id: EngineId;
  /**
   * Resolves with a normalized transcript, or rejects with an Error whose
   * `message` is safe to show the user verbatim and whose `cause` carries the
   * engine's own stderr for the disclosure panel.
   */
  run(request: LocalRunRequest, ctx: LocalRunContext): Promise<Transcript>;
}
