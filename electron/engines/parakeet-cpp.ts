/**
 * `parakeet-cli` from whisper.cpp b4938, wrapped into a `LocalEngine`.
 *
 * The binary looks impoverished next to `whisper-cli` — its whole option set is
 * `-t/--threads`, `-m/--model`, `-f/--file`, `-ng/--no-gpu`, `-dev/--device`,
 * `-ps/--print-segments`, `-otxt`, `-of` and `-np`, with no JSON writer, no
 * language flag and no progress callback. But `-ps` turns out to print, on
 * **stderr**, one line per decoded token carrying everything this adapter
 * needs:
 *
 *     [50] id= 4128 frame=105 dur_idx= 2 dur_val= 2 p=1.0000 plog=-20.8481 t0= 840 t1= 856 word_start=true "▁word"
 *
 * That is richer than the human-readable `[00:00.000 --> 00:05.040] text`
 * segment form, and it is what this file parses. Three details in it are easy
 * to get wrong and each was measured against the real binary (see
 * `docs/engines/verification.md`):
 *
 * - **`t0` and `t1` are centiseconds**, not milliseconds and not seconds. The
 *   last token of an 8.778 s recording reported `t1= 856`. Multiply by 10.
 * - **`word_start` is authoritative.** Do not infer word boundaries from the
 *   `▁` marker alone, and do not infer them from spaces — a token like `"cri"`
 *   continues the previous word with neither.
 * - **Punctuation is its own token** with `word_start=false` and `t0 == t1`.
 *   It attaches to the preceding word rather than becoming a word of its own,
 *   which is what keeps a subtitle from ending on a lone full stop.
 *
 * Parakeet v3 is transcribe-only and detects its own language, so
 * `request.language` and `request.translate` are ignored. Silently ignoring a
 * flag is normally a bug; here it is the honest behaviour, because the
 * alternative — failing a queued job because a global setting says "translate"
 * — punishes the user for a model capability they did not choose. The UI
 * disables both toggles while a Parakeet model is selected, so the ignored
 * value is never one the user set with this engine in mind.
 */

import { spawn } from 'node:child_process';
import { cpus } from 'node:os';

import { binaryPath } from '../binaries-runtime';
import type { Segment, Transcript } from '../shared/transcript';
import { normalizeTranscript } from '../shared/transcript';
// The token parsing lives next door, free of node and electron imports, so
// both TypeScript projects compile it and its tests need no Electron runtime.
import type { ParakeetToken } from './parakeet-tokens';
import { parseTokenLine, tokensToWords, wordsToSegments } from './parakeet-tokens';
import type { LocalEngine, LocalRunContext, LocalRunRequest } from './types';

/** How much stderr travels with a failure: enough for the error and the banner above it. */
const STDERR_TAIL_LINES = 40;

/** `Math.max(1, min(8, cores - 2))` — see the note in the queue about leaving cores for the UI. */
function resolveThreads(requested: number): number {
  if (requested > 0) return requested;
  return Math.max(1, Math.min(8, cpus().length - 2));
}

async function run(request: LocalRunRequest, ctx: LocalRunContext): Promise<Transcript> {
  const args = [
    '-m', request.modelPath,
    '-f', request.wavPath,
    '-ps',
    '-np',
    '-t', String(resolveThreads(request.threads)),
  ];

  const tokens: ParakeetToken[] = [];
  const stderrTail: string[] = [];
  let stdout = '';
  let stderrCarry = '';

  const child = spawn(binaryPath('parakeet-cli'), args, { stdio: ['ignore', 'pipe', 'pipe'] });

  /**
   * Parakeet prints no progress at all, so the bar is driven by elapsed time
   * against a measured real-time factor. It is an estimate and it is capped
   * below 100 %: a bar that sits at 100 % while the process is still working
   * reads as a hang, and one that jumps backwards reads as a failure.
   */
  const startedAt = Date.now();
  // Measured on an M2 Pro: 171 s of audio in 3.0 s, a real-time factor of 57.
  // The assumption here is deliberately well below that. An estimate that runs
  // AHEAD of reality parks the bar at its 95 % cap for most of the job, which
  // reads worse than one that lags and then jumps to done. Windows has no Metal
  // path and falls back to the CPU backend, hence the much lower figure.
  const assumedRtf = process.platform === 'darwin' ? 35 : 8;
  const ticker = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    const expected = request.durationMs / assumedRtf;
    if (expected <= 0) return;
    ctx.onProgress(Math.min(95, Math.round((elapsed / expected) * 100)));
  }, 500);

  const onAbort = (): void => {
    child.kill('SIGKILL');
  };
  ctx.signal.addEventListener('abort', onAbort, { once: true });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    // Token lines arrive split across chunk boundaries; hold the partial line.
    stderrCarry += chunk;
    const lines = stderrCarry.split('\n');
    stderrCarry = lines.pop() ?? '';
    for (const line of lines) {
      const token = parseTokenLine(line);
      if (token) {
        tokens.push(token);
        continue;
      }
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    }
  });

  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve(exitCode ?? -1));
    });

    const trailing = parseTokenLine(stderrCarry);
    if (trailing) tokens.push(trailing);

    if (ctx.signal.aborted) {
      const error = new Error('Transcription was cancelled.');
      error.name = 'AbortError';
      throw error;
    }
    if (code !== 0) {
      throw new Error(`Parakeet could not transcribe this file (exit code ${code}).`, {
        cause: stderrTail.join('\n'),
      });
    }

    const words = tokensToWords(tokens);
    const segments = words.length > 0
      ? wordsToSegments(words)
      // No tokens at all means `-ps` gave us nothing — an older build, or a
      // change upstream. The plain transcript is still on stdout, so fall back
      // to one segment spanning the file rather than losing the transcription.
      : fallbackSegments(stdout, request.durationMs);

    ctx.onProgress(100);

    return normalizeTranscript({
      // Parakeet reports no language. Leaving this null is the honest answer;
      // guessing from the text would put a wrong flag next to a good transcript.
      language: null,
      durationMs: request.durationMs,
      segments,
      source: {
        kind: 'local',
        engineId: 'parakeet-cpp',
        modelId: request.modelPath,
        label: 'Parakeet TDT 0.6B v3 (local)',
      },
      createdAt: new Date().toISOString(),
    });
  } finally {
    clearInterval(ticker);
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

function fallbackSegments(stdout: string, durationMs: number): Segment[] {
  const text = stdout.trim();
  if (text.length === 0) return [];
  return [{ startMs: 0, endMs: durationMs, text, words: [] }];
}

export const parakeetEngine: LocalEngine = {
  id: 'parakeet-cpp',
  run,
};
