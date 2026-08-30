/// <reference types="vitest/globals" />
/**
 * `electron/engines/chunking.ts` — joining the pieces of a long recording.
 *
 * NOT WIRED UP YET. `grep -rn "engines/chunking" electron src test` finds no
 * importer: `planChunks` and `stitch` exist for the day a file is too long for
 * one pass, and nothing calls them today. The tests are here anyway, because a
 * module that is correct when it is connected is worth more than one that is
 * debugged afterwards, in production, on somebody's four-hour recording.
 *
 * WHAT IS PINNED. Every chunk after the first overlaps the one before it, and
 * the seam is de-duplicated: the earlier chunk's account of the shared audio
 * wins. The header states the assumption that makes that safe — "because every
 * chunk extends a full overlapMs past where the next one starts, the earlier
 * chunk covers the seam region completely. Nothing is lost by discarding the
 * later chunk's account of it."
 *
 * That is true of a segment lying WITHIN the seam. It is false of one that
 * begins inside the seam and ends past it: chunk N's audio stops at
 * chunk(N+1).startMs + overlapMs, so it can say nothing about what comes after,
 * and dropping chunk N+1's segment whole deletes the only decode of that span.
 * The transcript then reads as a clean sentence with a phrase missing from the
 * middle of it — the worst shape a transcription error can take, because
 * nothing about the output looks wrong.
 */

import { stitch } from '../electron/engines/chunking';

function words(text: string, startMs: number, endMs: number) {
  const parts = text.split(' ');
  const step = (endMs - startMs) / parts.length;
  return parts.map((word, i) => ({
    text: word,
    startMs: Math.round(startMs + step * i),
    endMs: Math.round(startMs + step * (i + 1)),
  }));
}

function segment(text: string, startMs: number, endMs: number) {
  return { startMs, endMs, text, words: words(text, startMs, endMs) };
}

describe('stitch, at a seam', () => {
  /*
   * Chunk 0 covers [0, 1_805_000] and ends mid-sentence — its audio simply
   * stops. Chunk 1 starts at 1_800_000 and its first segment straddles the
   * boundary: it begins at 1_804_000, inside the seam, and runs to 1_806_500,
   * outside it. Only chunk 1 heard anything after 1_805_000.
   */
  const results = [
    {
      chunk: { index: 0, startMs: 0, endMs: 1_805_000 },
      segments: [segment('and then he walked out of the room and', 1_795_000, 1_805_000)],
    },
    {
      chunk: { index: 1, startMs: 1_800_000, endMs: 3_600_000 },
      segments: [
        // relative to the chunk's own start
        segment('out of the room and never came back at all', 4_000, 6_500),
        segment('the next morning was quiet', 7_000, 9_000),
      ],
    },
  ];

  const out = stitch(results, 5_000);
  const text = out.map((s) => s.text).join(' ');

  it('keeps the words only the later chunk could have heard', () => {
    expect(text).toContain('never came back at all');
  });

  it('does not repeat the words both chunks heard', () => {
    expect(text.match(/out of the room/g) ?? []).toHaveLength(1);
  });

  it('stays in order and does not overlap itself', () => {
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i]!.startMs).toBeGreaterThanOrEqual(out[i - 1]!.endMs - 250);
    }
  });

  it('still keeps the segment that follows the seam untouched', () => {
    expect(text).toContain('the next morning was quiet');
  });
});
