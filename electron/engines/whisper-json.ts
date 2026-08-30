/**
 * Turning `whisper-cli`'s `-ojf` JSON into segments and words.
 *
 * Split out of `whisper-cpp.ts` on purpose: that file spawns a child process and
 * asks `binaries-runtime` where the executable lives, which reaches into
 * `electron`. This file reaches into nothing. It is therefore compiled by both
 * TypeScript projects and testable without an Electron runtime — the same rule
 * that governs every other pure module in this repository.
 *
 * The shape it parses was measured, not remembered (see
 * `docs/engines/verification.md`):
 *
 *     { "result": { "language": "bg" },
 *       "transcription": [ { "offsets": { "from": 0, "to": 2260 },
 *                            "text": " …",
 *                            "tokens": [ { "text": " \u0422\u043e\u0432\u0430",
 *                                          "offsets": { "from": 10, "to": 220 },
 *                                          "id": 264, "p": 0.42 } ] } ] }
 *
 * **`offsets.from` and `offsets.to` are already integer milliseconds.** Nothing
 * here multiplies or divides them. The engine that reports centiseconds is
 * Parakeet, in the file next door, and conflating the two is the single easiest
 * way to ship subtitles that drift by a factor of ten.
 */

import type { Segment, Word } from '../shared/transcript';

/**
 * Special tokens whisper emits alongside real text: `[_BEG_]`, `[_TT_123]`,
 * and the annotations `[BLANK_AUDIO]` / `[MUSIC]`. Anything wholly wrapped in
 * brackets is dropped. That does discard the audio-event annotations some users
 * like, but they carry no useful timing of their own and would otherwise be
 * glued onto the next real word by the merge below.
 */
export const BRACKETED = /^\[.*\]$/;

/**
 * A word is finished when the accumulated text ends a sentence, because the
 * token after a full stop frequently arrives without the leading space that
 * normally marks a word boundary.
 *
 * The known cost is decimals: `3` + `.` + `14` becomes `3.` and `14`. Requiring
 * the next token to look like a new sentence would fix that and break on
 * languages that do not capitalise, so the cheap rule wins.
 */
export const SENTENCE_END = /[.!?…。！？][)"'”’\]]?$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

/** `offsets` on a segment or a token. Already integer milliseconds — see the file header. */
export function readOffsets(owner: Record<string, unknown>): { from: number; to: number } | null {
  const offsets = owner['offsets'];
  if (!isRecord(offsets)) return null;
  const from = readNumber(offsets, 'from');
  const to = readNumber(offsets, 'to');
  if (from === null || to === null) return null;
  return { from, to };
}

export function isSpecialToken(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return BRACKETED.test(trimmed) || trimmed.startsWith('[_');
}

export interface PendingWord {
  text: string;
  startMs: number;
  endMs: number;
  /** Lowest `p` seen so far, or `null` when no token carried one. */
  weakest: number | null;
}

/**
 * Merge whisper's sub-word tokens into words.
 *
 * whisper tokenises `" transcription"` as `" trans"` + `"cription"`, and the
 * leading space is part of the token text — that space is the entire word
 * boundary signal, which is why the raw text is inspected before trimming.
 */
/**
 * Scripts that do not put a space between one word and the next.
 *
 * Han, kana, Thai, Lao, Khmer and Burmese. `wordsFromTokens` decides where a
 * word begins from a leading space, a whitespace token, or sentence-ending
 * punctuation, and a sentence in any of these offers none of the three — so
 * every token between two full stops merged into a single Word.
 *
 * Measured on 83 Han characters covering 13.3 seconds of speech: one word, one
 * cue, 83 characters on a line whose limit is 42, and the cue clamped to 7000 ms
 * so the subtitle vanished six seconds before the speaker did. Every rule in
 * `resegment` operates on words, so one word means no break, no balanced line
 * and no honoured duration — the subtitle layer inert for roughly a fifth of the
 * languages this app claims to handle.
 *
 * The tokenizer already produces the right granularity. A token in one of these
 * scripts now simply stands on its own rather than being glued to its
 * neighbour. That is not linguistic word segmentation — doing that properly
 * needs a dictionary — but a cue can now be broken between characters, which is
 * what CJK subtitling does anyway.
 */
const NO_WORD_SPACES =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u0e00-\u0eff\u1000-\u109f\u1780-\u17ff]/u;

export function wordsFromTokens(tokens: readonly unknown[]): Word[] {
  const words: Word[] = [];
  let pending: PendingWord | null = null;
  let boundaryPending = false;

  const flush = (): void => {
    if (pending === null) return;
    const text = pending.text.trim();
    if (text.length > 0) {
      words.push({
        text,
        startMs: pending.startMs,
        endMs: Math.max(pending.endMs, pending.startMs),
        // MINIMUM, not mean: a word is only as trustworthy as its worst token.
        // Averaging lets three confident sub-word tokens hide the one the model
        // was guessing at, and it is precisely that word a reviewer needs to see
        // flagged.
        ...(pending.weakest !== null ? { confidence: pending.weakest } : {}),
      });
    }
    pending = null;
  };

  for (const token of tokens) {
    if (!isRecord(token)) continue;
    const raw = readString(token, 'text');
    if (raw === null || isSpecialToken(raw)) continue;
    if (raw.trim().length === 0) {
      // A whitespace-only token carries no text but still separates words, so
      // remember the boundary for the next token that does have some.
      boundaryPending = true;
      continue;
    }
    const offsets = readOffsets(token);
    if (offsets === null) continue;

    const startsWord =
      pending === null ||
      boundaryPending ||
      /^\s/.test(raw) ||
      SENTENCE_END.test(pending.text.trimEnd()) ||
      // Either side being in a script without word spaces is enough: a Han
      // character must not be glued to the one before it, and a Latin word must
      // not be glued onto a Han character either.
      NO_WORD_SPACES.test(raw.trimStart().charAt(0)) ||
      NO_WORD_SPACES.test(pending.text.trimEnd().slice(-1));
    if (startsWord) flush();
    boundaryPending = false;

    const probability = readNumber(token, 'p');
    if (pending === null) {
      pending = { text: raw, startMs: offsets.from, endMs: offsets.to, weakest: probability };
    } else {
      pending.text += raw;
      pending.endMs = Math.max(pending.endMs, offsets.to);
      pending.weakest =
        probability === null
          ? pending.weakest
          : pending.weakest === null
            ? probability
            : Math.min(pending.weakest, probability);
    }
  }

  flush();
  return words;
}

export function segmentsFromJson(root: Record<string, unknown>): Segment[] {
  const raw = root['transcription'];
  if (!Array.isArray(raw)) return [];

  const segments: Segment[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const tokens = entry['tokens'];
    const words = Array.isArray(tokens) ? wordsFromTokens(tokens) : [];
    const offsets = readOffsets(entry);
    const first = words[0];
    const last = words[words.length - 1];

    // `-ojf` is what puts `tokens` in the file. If a future build drops it the
    // segment text is still usable, just not word-timed, so fall back rather
    // than throwing away the transcription.
    const text = (readString(entry, 'text') ?? '').trim() || words.map((w) => w.text).join(' ');
    if (text.length === 0) continue;
    // whisper marks a stretch of silence with a segment whose entire text is
    // `[BLANK_AUDIO]` and whose only token was dropped above. Keeping it would
    // put a subtitle on screen that reads "[BLANK_AUDIO]" during the silence,
    // which is worse than no cue at all — and worse than the gap it describes.
    if (words.length === 0 && BRACKETED.test(text)) continue;

    const startMs = offsets?.from ?? first?.startMs ?? 0;
    const endMs = offsets?.to ?? last?.endMs ?? startMs;
    segments.push({ startMs, endMs, text, words });
  }
  return segments;
}

/**
 * `result.language` is the language whisper actually decoded in, which is the
 * detected one when `-l auto` was passed and the requested one otherwise.
 * `auto` and `und` are echoes, not detections, so they become `null` — the
 * transcript contract is explicit that a language is never invented.
 */
export function languageFromJson(root: Record<string, unknown>): string | null {
  const result = root['result'];
  if (!isRecord(result)) return null;
  const language = (readString(result, 'language') ?? '').trim().toLowerCase();
  if (language.length === 0 || language === 'auto' || language === 'und') return null;
  return language;
}
