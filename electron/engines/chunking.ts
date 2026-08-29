/**
 * Cutting a long recording into decodable pieces, and stitching the pieces
 * back into one transcript.
 *
 * Two hours of film decoded to the 16 kHz mono 16-bit WAV both local binaries
 * eat is about 230 MB on disk. That is annoying but survivable, and it is not
 * why this file exists. The two reasons that matter are:
 *
 *  - **Whisper degrades with length.** It is an encoder-decoder with a 30 s
 *    attention window and an autoregressive text decoder conditioned on its own
 *    previous output. Over an hour that conditioning drifts: timestamps slide
 *    late, and over music or a long silence the decoder falls into a repetition
 *    loop and emits the same sentence until the audio runs out. Bounding the
 *    input bounds the blast radius — a chunk that goes bad costs one chunk, and
 *    the chunks around it are still correct.
 *  - **Cloud providers cap the upload.** Every one of them has a request size
 *    or duration limit, and the only honest way to transcribe a two-hour film
 *    through an endpoint that accepts twenty minutes is to send it in pieces.
 *
 * This is deliberately **not** applied to Parakeet. Parakeet v3 is a TDT
 * transducer: it walks the encoder's frames strictly in order and emits tokens
 * per frame, with no cross-attention over a decoded prefix and no fixed window
 * to slide. A ten-second file and a two-hour file decode by exactly the same
 * mechanism, and nothing about it drifts with length — so chunking Parakeet
 * would buy nothing and pay for it in boundary artefacts. Chunking is for
 * Whisper, and for a cloud upload that exceeds the provider's limit.
 *
 * PURE. No `node:` and no `electron` imports — the only import in this file is
 * a type, so it compiles unchanged in the renderer and in a jsdom test.
 */

import type { Segment, Word } from '../shared/transcript';

/** One piece of the media timeline, in absolute milliseconds from the start of the file. */
export interface Chunk {
  /** Position in the plan, `0`-based. Preserved so results can arrive out of order. */
  index: number;
  startMs: number;
  /** Exclusive-ish: the last chunk's `endMs` is exactly the media duration. */
  endMs: number;
}

export interface ChunkPlan {
  chunks: Chunk[];
  /**
   * How much each chunk repeats of the one before it. `0` when the plan is a
   * single chunk, because with no boundary there is nothing to overlap and
   * nothing for `stitch` to reconcile.
   */
  overlapMs: number;
}

/** Half an hour. Comfortably inside the range where Whisper's decoder stays honest. */
export const DEFAULT_MAX_CHUNK_MS = 30 * 60_000;

/**
 * Five seconds of repeated audio at every seam.
 *
 * Long enough to contain any single utterance — nobody speaks one uninterrupted
 * sentence for five seconds without a word boundary the recognizer can find —
 * and short enough that the duplicated decode work is under 1 % of a 30-minute
 * chunk.
 */
export const DEFAULT_OVERLAP_MS = 5_000;

/**
 * Refuse to plan chunks shorter than this however small `maxChunkMs` gets.
 * Below roughly ten seconds a chunk is smaller than Whisper's own decode window
 * and the plan is all seam and no content; the floor also bounds how many
 * chunks a caller with a bad number can talk us into allocating.
 */
const MIN_CHUNK_MS = 10_000;

/**
 * How far apart two segments may start and still be judged the same speech at
 * a seam. A quarter of a second is under one syllable: a segment that begins
 * more than that before the previously accepted one ended is inside it, not
 * after it.
 */
const BOUNDARY_TOLERANCE_MS = 250;

/**
 * Cap on how far back `stitch` looks for a text duplicate. The duplicate, if
 * there is one, sits within a couple of segments of the seam; scanning the
 * whole accepted list would make stitching quadratic in the length of a film
 * to catch a case that cannot happen.
 */
const MAX_DEDUPE_SCAN = 64;

/**
 * Split `durationMs` into chunks no longer than `maxChunkMs`, each repeating
 * the last `overlapMs` of its predecessor.
 *
 * The common case costs nothing: anything at or under `maxChunkMs` comes back
 * as one chunk covering the whole file, which the caller runs exactly as it
 * would have without this module.
 *
 * **Why overlap at all.** A cut is placed by the clock, not by the speech, so
 * it lands in the middle of a word about as often as not. The chunk before the
 * cut ends mid-word and the recognizer drops the fragment; the chunk after the
 * cut starts mid-word and drops it again — the word is lost from both sides and
 * from the stitched result. Making each chunk start `overlapMs` *before* its
 * nominal boundary means the word is fully inside at least one chunk, and every
 * duplicate that overlap creates is removed again by `stitch`. Losing text is
 * unrecoverable; duplicated text is a de-duplication problem, so the design
 * trades the first for the second on purpose.
 *
 * Chunks are equal-ish rather than "as long as allowed, plus a stub": five
 * 24-minute chunks decode more evenly, and progress reporting over equal pieces
 * does not stall on a final 90-second runt after four half-hour marathons.
 */
export function planChunks(
  durationMs: number,
  options?: { maxChunkMs?: number; overlapMs?: number },
): ChunkPlan {
  const duration = Math.max(0, finiteMs(durationMs, 0));
  // Clamped, not trusted: `maxChunkMs` arrives from settings and a cloud
  // adapter's own limit arithmetic, and a zero or a NaN there must not produce
  // a plan with an infinite number of chunks.
  const maxChunkMs = Math.max(MIN_CHUNK_MS, finiteMs(options?.maxChunkMs ?? DEFAULT_MAX_CHUNK_MS, DEFAULT_MAX_CHUNK_MS));
  // An overlap at or above the chunk length means consecutive chunks never
  // advance. Half the chunk is the last value at which forward progress is
  // still at least half a chunk per step, so the chunk count stays bounded.
  const overlapMs = Math.min(
    Math.max(0, finiteMs(options?.overlapMs ?? DEFAULT_OVERLAP_MS, DEFAULT_OVERLAP_MS)),
    Math.floor(maxChunkMs / 2),
  );

  // The whole point of the module is to be free when it is not needed. A zero
  // or unknown duration lands here too and yields one empty chunk, which every
  // downstream stage already handles as "a file with nothing in it".
  if (duration <= maxChunkMs) {
    return { chunks: [{ index: 0, startMs: 0, endMs: duration }], overlapMs: 0 };
  }

  // Integer arithmetic on purpose. Distributing `duration` with a fractional
  // stride and rounding each boundary independently lets a chunk come out one
  // millisecond over `maxChunkMs`, which is meaningless for Whisper but not for
  // a cloud limit derived from it. Handing out a whole number of milliseconds
  // per step, with the remainder spread one millisecond at a time over the
  // leading chunks, keeps every chunk provably within the cap and the last
  // boundary provably exact.
  const strideBudget = duration - overlapMs; // > 0: duration > maxChunkMs >= 2 * overlapMs
  const maxStride = maxChunkMs - overlapMs; // > 0 by the clamp above
  const count = Math.ceil(strideBudget / maxStride); // >= 2, since strideBudget > maxStride
  const baseStride = Math.floor(strideBudget / count);
  const remainder = strideBudget - baseStride * count;

  const chunks: Chunk[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const stride = baseStride + (index < remainder ? 1 : 0);
    const startMs = cursor;
    cursor += stride;
    // Every chunk reaches `overlapMs` past the point where the next one begins,
    // so the seam region is decoded twice — once with the full preceding
    // context, once cold. The last chunk lands exactly on the duration because
    // the strides sum to `strideBudget`.
    chunks.push({ index, startMs, endMs: cursor + overlapMs });
  }
  return { chunks, overlapMs };
}

/**
 * Put chunk results back together: shift each chunk's segment timings into
 * absolute time and drop what the overlap duplicated.
 *
 * Results may arrive in any order — the queue runs chunks sequentially today
 * but a retry re-appends a chunk that was already tried, and a cloud adapter
 * with parallel uploads finishes out of order — so ordering is taken from
 * `chunk.startMs`, never from the position in the array. A repeated `chunk`
 * keeps its last result, because the only way the same chunk is submitted twice
 * is a retry, and a retry supersedes what it retried.
 *
 * **Why the earlier chunk wins a tie.** Both chunks decoded the seam region,
 * but not from the same standing start. The earlier chunk reached it with the
 * whole preceding minute already in its encoder window and its decoder
 * conditioned on the sentence that leads into it; the later chunk begins there
 * cold, with the audio's first instants missing their onset and no context to
 * disambiguate a homophone. The earlier chunk's version of the overlap is the
 * better-informed decode, so it is the one kept — and because every chunk
 * extends a full `overlapMs` past where the next one starts, the earlier chunk
 * covers the seam region completely. Nothing is lost by discarding the later
 * chunk's account of it.
 */
export function stitch(
  results: readonly { chunk: Chunk; segments: readonly Segment[] }[],
  overlapMs: number,
): Segment[] {
  const overlap = Math.max(0, finiteMs(overlapMs, 0));

  // Last result per chunk wins; see the retry note above.
  const byChunk = new Map<string, { chunk: Chunk; segments: readonly Segment[] }>();
  for (const result of results) {
    byChunk.set(`${finiteMs(result.chunk.index, 0)}:${chunkStart(result.chunk)}`, result);
  }
  const ordered = [...byChunk.values()].sort(
    (a, b) => chunkStart(a.chunk) - chunkStart(b.chunk) || finiteMs(a.chunk.index, 0) - finiteMs(b.chunk.index, 0),
  );

  const out: Segment[] = [];
  let processed = 0;
  for (const result of ordered) {
    const shiftMs = chunkStart(result.chunk);
    // De-duplication only ever applies to the leading seam of a chunk that has
    // a predecessor. Applying it to the first chunk processed would police
    // segments against each other inside a single decode, where a recognizer is
    // entitled to emit slightly overlapping spans and every one of them is real.
    const seamEndMs = processed === 0 ? Number.NEGATIVE_INFINITY : shiftMs + overlap;
    processed += 1;

    const shifted = result.segments
      .map((segment) => shiftSegment(segment, shiftMs))
      .filter((segment) => segment.text.length > 0 || segment.words.length > 0)
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

    for (const segment of shifted) {
      if (out.length === 0 || segment.startMs >= seamEndMs) {
        out.push(segment);
        continue;
      }
      // Same words, decoded twice: keep the earlier chunk's copy.
      if (hasTextDuplicate(out, segment, shiftMs)) continue;
      // Not the same words — a fragment, or a different split of the same
      // speech. Whichever starts first is kept, so this one survives only if it
      // begins after what is already there has finished saying its piece.
      const previous = out[out.length - 1];
      if (previous !== undefined && previous.endMs - segment.startMs > BOUNDARY_TOLERANCE_MS) continue;
      out.push(segment);
    }
  }

  out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return out;
}

/**
 * Is `candidate` a re-decode of something already accepted at this seam?
 *
 * The scan walks backwards from the newest accepted segment and stops at the
 * first one that ends before the shared region begins: a segment that finished
 * before the seam cannot be a second reading of audio inside it.
 */
function hasTextDuplicate(accepted: readonly Segment[], candidate: Segment, seamStartMs: number): boolean {
  const key = normalizeForCompare(candidate.text);
  // A segment with no comparable text (a lone "♪", pure punctuation) would
  // match every other such segment. Let the timing rule decide those instead.
  if (key.length === 0) return false;

  for (let i = accepted.length - 1, scanned = 0; i >= 0 && scanned < MAX_DEDUPE_SCAN; i -= 1, scanned += 1) {
    const earlier = accepted[i];
    if (earlier === undefined) break;
    if (earlier.endMs <= seamStartMs - BOUNDARY_TOLERANCE_MS) break;
    if (normalizeForCompare(earlier.text) === key) return true;
  }
  return false;
}

/**
 * Fold away everything two decodes of the same audio may legitimately disagree
 * about: casing after a sentence break that only one chunk could see, a comma
 * the cold start did not place, a doubled space around a dropped token. What is
 * left is the words, and if the words match it is the same speech.
 *
 * NFKC first so a curly apostrophe, a full-width Latin letter and their plain
 * forms compare equal before the punctuation class is stripped.
 */
function normalizeForCompare(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Move a segment from chunk-relative to absolute time.
 *
 * Word timings are shifted with it. Forgetting them is the classic version of
 * this bug: the segment lands in the right minute, the word-level export and
 * every karaoke-style cue built from `words` stays pinned to the start of the
 * file, and nothing complains until someone opens the SRT.
 */
function shiftSegment(segment: Segment, shiftMs: number): Segment {
  const startMs = Math.max(0, finiteMs(segment.startMs, 0) + shiftMs);
  const endMs = Math.max(startMs, finiteMs(segment.endMs, 0) + shiftMs);
  const words: Word[] = segment.words.map((word) => {
    const wordStartMs = Math.max(0, finiteMs(word.startMs, 0) + shiftMs);
    return {
      ...word,
      startMs: wordStartMs,
      endMs: Math.max(wordStartMs, finiteMs(word.endMs, 0) + shiftMs),
    };
  });
  // Spread first so `speaker` and any future optional field survive without
  // being written as an explicit `undefined`, which `exactOptionalPropertyTypes`
  // rejects and which would serialize into the exported JSON.
  return { ...segment, startMs, endMs, text: segment.text.trim(), words };
}

/** A chunk's absolute start, defended against a NaN or a negative from a caller. */
function chunkStart(chunk: Chunk): number {
  return Math.max(0, finiteMs(chunk.startMs, 0));
}

/** Round to whole milliseconds, substituting `fallback` for NaN and Infinity. */
function finiteMs(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}
