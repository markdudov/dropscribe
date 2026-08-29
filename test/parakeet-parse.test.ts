/// <reference types="vitest/globals" />
/**
 * `electron/engines/parakeet-cpp.ts` — the `-ps` stderr parser.
 *
 * The fixture below is not invented. The two lines marked VERBATIM were copied
 * out of `parakeet-cli`'s real stderr (recorded in the measurement notes beside
 * this repo and summarised in `docs/engines/verification.md`), `▁` marker and
 * column padding included; the rest are written in exactly that shape.
 *
 * Three of the assertions here are the ones that cost an afternoon each if they
 * are wrong, and none of them fails loudly in production:
 *
 * - `t0`/`t1` are CENTISECONDS. Read them as milliseconds and every subtitle
 *   lands at a tenth of its real time, which looks like a sync bug in ffmpeg.
 * - A word is assembled from several tokens (`▁produ` + `ce`), so a parser that
 *   emits one word per token produces a transcript of syllables.
 * - Confidence is the MINIMUM token probability, not the mean. A mean hides the
 *   one guessed syllable behind three certain ones — and that word is precisely
 *   the one a reviewer needs flagged.
 */

import {
  parseTokenLine,
  tokensToWords,
  wordsToSegments,
} from '../electron/engines/parakeet-tokens';
import type { ParakeetToken } from '../electron/engines/parakeet-tokens';
import type { Word } from '../electron/shared/transcript';

// No mocking is needed any more. The parser moved into
// `electron/engines/parakeet-tokens.ts`, which imports nothing at all — that is
// the whole point of the split, and it is why this file lives beside the other
// pure tests rather than under `test/node/`.

/** `noUncheckedIndexedAccess` makes every index a `T | undefined`; fail loudly instead. */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`expected an element at index ${index}`);
  return value;
}

/** VERBATIM — a punctuation token, straight from the binary. */
const REAL_PUNCTUATION_LINE =
  '      [51] id= 7883 frame=107 dur_idx= 1 dur_val= 1 p=0.9996 plog=-15.4943 t0= 856 t1= 856 word_start=false "."';

/** VERBATIM — a word-initial token, straight from the binary. */
const REAL_WORD_LINE =
  '      [50] id= 4128 frame=105 dur_idx= 2 dur_val= 2 p=1.0000 plog=-20.8481 t0= 840 t1= 856 word_start=true "▁word"';

/**
 * "We produce audio." in the same column format.
 *
 * `▁produ` + `ce` is the multi-token word; the final `.` is the punctuation
 * token with `t0 === t1` that must attach to "audio" instead of becoming a cue
 * of its own.
 */
const TOKEN_LINES: readonly string[] = [
  '      [ 0] id=  512 frame=  2 dur_idx= 2 dur_val= 2 p=0.9987 plog=-1.2043 t0=   4 t1=  16 word_start=true "▁We"',
  '      [ 1] id= 9021 frame= 11 dur_idx= 3 dur_val= 3 p=0.9210 plog=-3.4410 t0=  20 t1=  44 word_start=true "▁produ"',
  '      [ 2] id=  733 frame= 16 dur_idx= 1 dur_val= 1 p=0.8734 plog=-6.0021 t0=  44 t1=  52 word_start=false "ce"',
  '      [ 3] id= 1044 frame= 18 dur_idx= 2 dur_val= 2 p=1.0000 plog=-11.8765 t0=  56 t1=  80 word_start=true "▁audio"',
  '      [ 4] id= 7883 frame= 20 dur_idx= 1 dur_val= 1 p=0.9996 plog=-15.4943 t0=  80 t1=  80 word_start=false "."',
];

/** The header noise that shares stderr with the token lines. */
const HEADER_LINES: readonly string[] = [
  'parakeet_backend_init: using Metal backend',
  'Successfully loaded Parakeet model',
  'system_info: n_threads = 8 / 12 | METAL = 1 | NEON = 1 | ARM_FMA = 1 |',
  'Processing file: /tmp/dropscribe-abc123.wav (140442 samples, 8.778 sec)',
  'read_audio_data: 140442 samples, 8.778 sec, 16000 Hz, 1 channel',
  'ggml_metal_init: picking default device: Apple M2 Pro',
  'ggml_metal_library_init: using embedded metal library',
  '',
  '   ',
  // The human-readable `-ps` segment form, which is NOT what this parser reads.
  '[00:00:00.000 --> 00:00:05.040]  We produce audio.',
];

describe('parseTokenLine', () => {
  it('reads the real punctuation line the binary printed', () => {
    expect(parseTokenLine(REAL_PUNCTUATION_LINE)).toEqual({
      id: 7883,
      p: 0.9996,
      t0: 856,
      t1: 856,
      wordStart: false,
      text: '.',
    });
  });

  it('reads the real word line, marker and all', () => {
    expect(parseTokenLine(REAL_WORD_LINE)).toEqual({
      id: 4128,
      p: 1,
      t0: 840,
      t1: 856,
      wordStart: true,
      // The marker is kept here on purpose; stripping is `tokensToWords`' job.
      text: '▁word',
    });
  });

  it('returns null for every header line that shares the stream', () => {
    for (const line of HEADER_LINES) {
      expect(parseTokenLine(line)).toBeNull();
    }
  });

  it('returns null rather than half a token for a malformed line', () => {
    expect(
      parseTokenLine('      [52] id= 1 frame=1 dur_idx=1 dur_val=1 p=0.5 plog=-1.0 t0=1 t1=2 word_start=maybe "x"'),
    ).toBeNull();
    expect(parseTokenLine('[52] id= 1 p=0.5 "x"')).toBeNull();
  });

  it('tolerates however wide the binary padded each column', () => {
    const wide = parseTokenLine(
      '   [1234] id=   12 frame=  7 dur_idx=10 dur_val=10 p=0.5000 plog=-2.0000 t0=1234 t1=5678 word_start=true "▁x"',
    );
    expect(wide?.t0).toBe(1234);
    expect(wide?.t1).toBe(5678);
    expect(wide?.wordStart).toBe(true);
  });
});

describe('tokensToWords', () => {
  const tokens: ParakeetToken[] = TOKEN_LINES.map((line) => {
    const token = parseTokenLine(line);
    if (token === null) throw new Error(`fixture line did not parse: ${line}`);
    return token;
  });

  it('multiplies the printed centiseconds by ten', () => {
    const words = tokensToWords(tokens);
    // t0=4 → 40 ms, t1=16 → 160 ms. Reading these as milliseconds would put the
    // whole transcript in the first second of the file.
    expect(at(words, 0)).toEqual({ text: 'We', startMs: 40, endMs: 160, confidence: 0.9987 });
  });

  it('assembles one word out of several tokens and strips the marker', () => {
    const words = tokensToWords(tokens);
    expect(words.map((word) => word.text)).toEqual(['We', 'produce', 'audio.']);
    for (const word of words) expect(word.text).not.toContain('▁');

    // "▁produ" (t0=20) through "ce" (t1=52).
    expect(at(words, 1).startMs).toBe(200);
    expect(at(words, 1).endMs).toBe(520);
  });

  it('attaches a zero-length punctuation token to the word before it', () => {
    const words = tokensToWords(tokens);
    expect(words).toHaveLength(3);
    expect(at(words, 2).text).toBe('audio.');
    // "▁audio" ran 56..80; the full stop is 80..80 and adds no time of its own.
    expect(at(words, 2).startMs).toBe(560);
    expect(at(words, 2).endMs).toBe(800);
  });

  it('takes the minimum token probability, not the mean', () => {
    const words = tokensToWords(tokens);
    // "produce" is 0.9210 and 0.8734. The mean would be 0.8972 — high enough to
    // pass any review threshold the weaker syllable should have tripped.
    expect(at(words, 1).confidence).toBe(0.8734);
    expect(at(words, 1).confidence).not.toBeCloseTo((0.921 + 0.8734) / 2, 4);
    // "audio." is 1.0000 and 0.9996.
    expect(at(words, 2).confidence).toBe(0.9996);
  });

  it('opens a word for a continuation token that has nothing to continue', () => {
    const orphan = parseTokenLine(REAL_PUNCTUATION_LINE);
    if (orphan === null) throw new Error('fixture did not parse');
    expect(tokensToWords([orphan])).toEqual([
      { text: '.', startMs: 8_560, endMs: 8_560, confidence: 0.9996 },
    ]);
  });

  it('drops a token that is nothing but the marker', () => {
    const marker = parseTokenLine(
      '      [ 9] id=   1 frame=  1 dur_idx= 1 dur_val= 1 p=1.0000 plog=-1.0000 t0=   1 t1=   1 word_start=true "▁"',
    );
    if (marker === null) throw new Error('fixture did not parse');
    expect(tokensToWords([marker])).toEqual([]);
  });

  it('returns nothing for no tokens', () => {
    expect(tokensToWords([])).toEqual([]);
  });
});

describe('wordsToSegments', () => {
  function word(text: string, startMs: number, endMs: number): Word {
    return { text, startMs, endMs };
  }

  it('starts a new segment after a silence of 700 ms or more', () => {
    const segments = wordsToSegments([
      word('one', 0, 200),
      word('two', 300, 500),
      // 800 ms of silence.
      word('three', 1_300, 1_500),
    ]);
    expect(segments.map((segment) => segment.text)).toEqual(['one two', 'three']);
    expect(at(segments, 0)).toMatchObject({ startMs: 0, endMs: 500 });
    expect(at(segments, 1)).toMatchObject({ startMs: 1_300, endMs: 1_500 });
  });

  it('keeps a shorter pause inside one segment', () => {
    const segments = wordsToSegments([word('one', 0, 200), word('two', 899, 1_100)]);
    expect(segments).toHaveLength(1);
    expect(at(segments, 0).text).toBe('one two');
  });

  it('breaks a monologue that would otherwise run past 15 seconds', () => {
    // 31 words, 100 ms apart, so only the length rule can close a segment.
    const words = Array.from({ length: 31 }, (_unused, i) => word(`w${i}`, i * 600, i * 600 + 500));
    const segments = wordsToSegments(words);

    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.endMs - segment.startMs).toBeLessThanOrEqual(15_000);
    }
    // No word is lost across the split.
    expect(segments.flatMap((segment) => segment.words).map((w) => w.text)).toEqual(
      words.map((w) => w.text),
    );
  });

  it('carries the words themselves into the segment, not just the text', () => {
    const words = [word('one', 0, 200), word('two', 300, 500)];
    const segments = wordsToSegments(words);
    expect(at(segments, 0).words).toEqual(words);
    // A copy, so a later mutation of the bucket cannot reach back into it.
    expect(at(segments, 0).words).not.toBe(words);
  });

  it('returns nothing for no words', () => {
    expect(wordsToSegments([])).toEqual([]);
  });
});

describe('the whole -ps stream', () => {
  it('turns interleaved header noise and token lines into one segment', () => {
    const stream = [
      ...HEADER_LINES.slice(0, 4),
      at(TOKEN_LINES, 0),
      at(TOKEN_LINES, 1),
      'ggml_metal_init: allocating',
      at(TOKEN_LINES, 2),
      at(TOKEN_LINES, 3),
      at(TOKEN_LINES, 4),
      ...HEADER_LINES.slice(4),
    ];

    const tokens: ParakeetToken[] = [];
    for (const line of stream) {
      const token = parseTokenLine(line);
      if (token !== null) tokens.push(token);
    }

    expect(tokens).toHaveLength(5);
    const segments = wordsToSegments(tokensToWords(tokens));
    expect(segments).toHaveLength(1);
    expect(at(segments, 0).text).toBe('We produce audio.');
    expect(at(segments, 0).startMs).toBe(40);
    expect(at(segments, 0).endMs).toBe(800);
  });
});
