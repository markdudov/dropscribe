/// <reference types="vitest/globals" />
/**
 * `electron/shared/transcript.ts` — the repairs every adapter's output goes
 * through before anything else in the app is allowed to see it.
 *
 * These are the cases the file's own header names as real engine misbehaviour:
 * a final segment whose end runs past the audio because the last decode window
 * was padded, a hallucinated tail with no content, and segments arriving out of
 * order. Each one is silent — the transcript still reads correctly — and each
 * one moves a subtitle into the wrong second.
 */

import type { Segment, Transcript, TranscriptSource, Word } from '../electron/shared/transcript';
import {
  allWords,
  hasWordTimings,
  normalizeTranscript,
  speakers,
} from '../electron/shared/transcript';

/** `noUncheckedIndexedAccess` makes every index a `T | undefined`; fail loudly instead. */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`expected an element at index ${index}`);
  return value;
}

const SOURCE: TranscriptSource = {
  kind: 'local',
  engineId: 'whisper-cpp',
  modelId: 'ggml-large-v3-turbo',
  label: 'Whisper large-v3-turbo (local)',
};

/** `exactOptionalPropertyTypes`: absent means the key is missing, never `undefined`. */
function word(text: string, startMs: number, endMs: number, speaker?: string): Word {
  return { text, startMs, endMs, ...(speaker !== undefined ? { speaker } : {}) };
}

function transcript(segments: Segment[], durationMs: number): Transcript {
  return {
    language: 'en',
    durationMs,
    segments,
    source: SOURCE,
    createdAt: '2026-08-29T12:00:00.000Z',
  };
}

describe('normalizeTranscript', () => {
  it('clamps a segment and its words back inside durationMs', () => {
    const out = normalizeTranscript(
      transcript(
        [
          {
            startMs: 9_500,
            endMs: 12_400,
            text: 'past the end',
            words: [word('past', 9_500, 10_400), word('the', 10_400, 11_600), word('end', 11_600, 12_400)],
          },
        ],
        10_000,
      ),
    );

    const segment = at(out.segments, 0);
    expect(segment.startMs).toBe(9_500);
    expect(segment.endMs).toBe(10_000);
    expect(segment.words.map((w) => [w.startMs, w.endMs])).toEqual([
      [9_500, 10_000],
      [10_000, 10_000],
      [10_000, 10_000],
    ]);
  });

  it('rounds fractional milliseconds rather than truncating them', () => {
    const out = normalizeTranscript(
      transcript([{ startMs: 14.3 * 1000, endMs: 20_000.4, text: 'ok', words: [] }], 60_000),
    );
    const segment = at(out.segments, 0);
    expect(segment.startMs).toBe(14_300);
    expect(segment.endMs).toBe(20_000);
  });

  it('drops a segment with neither text nor words', () => {
    const out = normalizeTranscript(
      transcript(
        [
          { startMs: 0, endMs: 500, text: '   ', words: [] },
          { startMs: 600, endMs: 900, text: 'kept', words: [] },
          // A word list whose every entry is blank counts as no words at all.
          { startMs: 1_000, endMs: 1_200, text: '', words: [word('', 1_000, 1_200)] },
        ],
        5_000,
      ),
    );
    expect(out.segments.map((s) => s.text)).toEqual(['kept']);
  });

  it('keeps a text-only segment, even one with a zero-length span', () => {
    const out = normalizeTranscript(
      transcript([{ startMs: 2_000, endMs: 2_000, text: '  Hello.  ', words: [] }], 5_000),
    );
    expect(out.segments).toHaveLength(1);
    const segment = at(out.segments, 0);
    expect(segment.text).toBe('Hello.');
    expect(segment.words).toEqual([]);
    expect(segment.startMs).toBe(2_000);
    expect(segment.endMs).toBe(2_000);
  });

  it('sorts segments by start, then by end', () => {
    const out = normalizeTranscript(
      transcript(
        [
          { startMs: 5_000, endMs: 6_000, text: 'third', words: [] },
          { startMs: 1_000, endMs: 4_000, text: 'second', words: [] },
          { startMs: 1_000, endMs: 2_000, text: 'first', words: [] },
        ],
        10_000,
      ),
    );
    expect(out.segments.map((s) => s.text)).toEqual(['first', 'second', 'third']);
  });

  it('raises an end that sits before its own start', () => {
    const out = normalizeTranscript(
      transcript([{ startMs: 3_000, endMs: 1_000, text: 'backwards', words: [word('backwards', 3_000, 1_000)] }], 10_000),
    );
    const segment = at(out.segments, 0);
    expect(segment.endMs).toBe(3_000);
    expect(at(segment.words, 0).endMs).toBe(3_000);
  });

  // `durationMs: 0` means nobody measured the media. Clamping to it would erase
  // every timing in the transcript, so the limit is simply not applied.
  it('does not collapse a transcript whose duration is unknown', () => {
    const out = normalizeTranscript(
      transcript([{ startMs: 1_000, endMs: 4_000, text: 'still here', words: [] }], 0),
    );
    const segment = at(out.segments, 0);
    expect(segment.startMs).toBe(1_000);
    expect(segment.endMs).toBe(4_000);
  });

  it('leaves everything outside the segment list alone', () => {
    const input = transcript([{ startMs: 0, endMs: 1_000, text: 'hi', words: [] }], 1_000);
    const out = normalizeTranscript(input);
    expect(out.language).toBe('en');
    expect(out.durationMs).toBe(1_000);
    expect(out.source).toEqual(SOURCE);
    expect(out.createdAt).toBe('2026-08-29T12:00:00.000Z');
  });
});

describe('speakers', () => {
  it('returns first-appearance order with no duplicates', () => {
    const out = speakers(
      transcript(
        [
          {
            startMs: 0,
            endMs: 2_000,
            text: 'a b c',
            words: [word('a', 0, 500, 'Bob'), word('b', 500, 1_000, 'Ann'), word('c', 1_000, 2_000, 'Bob')],
          },
          {
            startMs: 2_000,
            endMs: 3_000,
            text: 'd',
            words: [word('d', 2_000, 3_000, 'Cleo')],
          },
        ],
        3_000,
      ),
    );
    expect(out).toEqual(['Bob', 'Ann', 'Cleo']);
  });

  it('falls back to the segment label when the segment has no words', () => {
    const out = speakers(
      transcript(
        [
          { startMs: 0, endMs: 1_000, text: 'hello', words: [], speaker: 'speaker_1' },
          { startMs: 1_000, endMs: 2_000, text: 'there', words: [], speaker: 'speaker_0' },
          { startMs: 2_000, endMs: 3_000, text: 'again', words: [], speaker: 'speaker_1' },
        ],
        3_000,
      ),
    );
    expect(out).toEqual(['speaker_1', 'speaker_0']);
  });

  it('is empty for a transcript that was never diarized', () => {
    expect(
      speakers(transcript([{ startMs: 0, endMs: 1_000, text: 'hello', words: [word('hello', 0, 1_000)] }], 1_000)),
    ).toEqual([]);
  });
});

describe('hasWordTimings and allWords', () => {
  const timed = transcript(
    [
      { startMs: 0, endMs: 1_000, text: 'one two', words: [word('one', 0, 400), word('two', 400, 1_000)] },
      { startMs: 1_000, endMs: 1_500, text: 'three', words: [word('three', 1_000, 1_500)] },
    ],
    2_000,
  );
  const untimed = transcript(
    [
      { startMs: 0, endMs: 1_000, text: 'one two', words: [] },
      { startMs: 1_000, endMs: 1_500, text: 'three', words: [] },
    ],
    2_000,
  );

  it('reports word timings only when at least one segment has them', () => {
    expect(hasWordTimings(timed)).toBe(true);
    expect(hasWordTimings(untimed)).toBe(false);
    expect(hasWordTimings(transcript([], 0))).toBe(false);
  });

  it('flattens every word across every segment, in order', () => {
    expect(allWords(timed).map((w) => w.text)).toEqual(['one', 'two', 'three']);
    expect(allWords(untimed)).toEqual([]);
  });
});
