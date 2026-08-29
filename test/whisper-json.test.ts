/// <reference types="vitest/globals" />
/**
 * `electron/engines/whisper-json.ts` — the `-ojf` JSON reader.
 *
 * Every fixture below is VERBATIM from a real run: whisper.cpp b4938,
 * `ggml-tiny.bin`, an 8.78 s WAV, `whisper-cli -oj -ojf`. Hand-written fixtures
 * are how a parser ends up agreeing with an imagined format — see
 * `docs/engines/verification.md` for the capture.
 */

import {
  isSpecialToken,
  languageFromJson,
  segmentsFromJson,
  wordsFromTokens,
} from '../electron/engines/whisper-json';
import type { Word } from '../electron/shared/transcript';

/** `noUncheckedIndexedAccess` makes every index `T | undefined`; fail loudly instead. */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`expected an element at index ${index}`);
  return value;
}

/** VERBATIM — the head of segment 0's token array. */
const REAL_TOKENS: readonly unknown[] = [
  { text: '[_BEG_]', offsets: { from: 0, to: 0 }, id: 50364, p: 0.989719 },
  { text: ' the', offsets: { from: 10, to: 220 }, id: 264, p: 0.415889 },
  { text: ' quick', offsets: { from: 220, to: 580 }, id: 1702, p: 0.717194 },
  { text: ' brown', offsets: { from: 580, to: 920 }, id: 6292, p: 0.666929 },
  { text: ' fox', offsets: { from: 1090, to: 1160 }, id: 21026, p: 0.698869 },
  { text: ' jumps', offsets: { from: 1160, to: 1510 }, id: 16704, p: 0.979823 },
];

/** A word whose pieces arrive as several tokens, the way whisper splits rarer words. */
const SPLIT_WORD_TOKENS: readonly unknown[] = [
  { text: ' drop', offsets: { from: 100, to: 300 }, id: 1, p: 0.94 },
  { text: '-', offsets: { from: 300, to: 320 }, id: 2, p: 0.61 },
  { text: 'scribe', offsets: { from: 320, to: 700 }, id: 3, p: 0.88 },
];

describe('isSpecialToken', () => {
  it('drops whisper control tokens', () => {
    expect(isSpecialToken('[_BEG_]')).toBe(true);
    expect(isSpecialToken('[_TT_310]')).toBe(true);
  });

  it('drops the bracketed audio-event annotations too', () => {
    // They carry no timing of their own and would be glued onto the next real
    // word by the merge, which is worse than losing them.
    expect(isSpecialToken('[BLANK_AUDIO]')).toBe(true);
    expect(isSpecialToken('[MUSIC]')).toBe(true);
  });

  it('keeps ordinary text, including a lone bracket', () => {
    expect(isSpecialToken(' the')).toBe(false);
    expect(isSpecialToken('[')).toBe(false);
    expect(isSpecialToken('sound [effects')).toBe(false);
  });
});

describe('wordsFromTokens', () => {
  it('starts a new word at every leading space and drops the special token', () => {
    const words = wordsFromTokens(REAL_TOKENS);
    expect(words.map((w) => w.text)).toEqual(['the', 'quick', 'brown', 'fox', 'jumps']);
  });

  it('takes each word timing straight from its own tokens, in milliseconds', () => {
    const words = wordsFromTokens(REAL_TOKENS);
    // Already integer milliseconds in the file — nothing is scaled here. The
    // engine that reports centiseconds is Parakeet, next door.
    expect(at(words, 0)).toMatchObject({ text: 'the', startMs: 10, endMs: 220 });
    expect(at(words, 3)).toMatchObject({ text: 'fox', startMs: 1090, endMs: 1160 });
  });

  it('joins continuation tokens into one word spanning all of them', () => {
    const words = wordsFromTokens(SPLIT_WORD_TOKENS);
    expect(words).toHaveLength(1);
    expect(at(words, 0)).toMatchObject({ text: 'drop-scribe', startMs: 100, endMs: 700 });
  });

  it('gives a word the MINIMUM probability of its tokens, not the mean', () => {
    const words = wordsFromTokens(SPLIT_WORD_TOKENS);
    // 0.94, 0.61, 0.88. The mean is 0.81 — comfortably above any threshold the
    // 0.61 syllable should have tripped. A word is only as good as its weakest
    // piece.
    expect(at(words, 0).confidence).toBe(0.61);
  });

  it('ignores anything that is not a token object', () => {
    const words: Word[] = wordsFromTokens([null, 'nope', 42, ...REAL_TOKENS.slice(1, 3)]);
    expect(words.map((w) => w.text)).toEqual(['the', 'quick']);
  });

  it('returns nothing for an empty list', () => {
    expect(wordsFromTokens([])).toEqual([]);
  });
});

describe('segmentsFromJson', () => {
  /** VERBATIM shape, trimmed to two segments and their offsets. */
  const root = {
    result: { language: 'bg' },
    transcription: [
      {
        timestamps: { from: '00:00:00,000', to: '00:00:02,260' },
        offsets: { from: 0, to: 2260 },
        text: ' Това е тест на българската транскрипция.',
        tokens: [
          { text: '[_BEG_]', offsets: { from: 0, to: 0 }, id: 50364, p: 0.99 },
          { text: ' Това', offsets: { from: 20, to: 300 }, id: 1, p: 0.97 },
          { text: ' е', offsets: { from: 300, to: 420 }, id: 2, p: 0.99 },
        ],
      },
      {
        timestamps: { from: '00:00:02,580', to: '00:00:05,320' },
        offsets: { from: 2580, to: 5320 },
        text: ' Приложението трябва да разпознае думите правилно.',
        tokens: [],
      },
    ],
  };

  it('reads offsets as milliseconds and trims the leading space off the text', () => {
    const segments = segmentsFromJson(root);
    expect(segments).toHaveLength(2);
    expect(at(segments, 0)).toMatchObject({
      startMs: 0,
      endMs: 2260,
      text: 'Това е тест на българската транскрипция.',
    });
    expect(at(segments, 1)).toMatchObject({ startMs: 2580, endMs: 5320 });
  });

  it('carries the merged words, and an empty array when there are no tokens', () => {
    const segments = segmentsFromJson(root);
    expect(at(segments, 0).words.map((w) => w.text)).toEqual(['Това', 'е']);
    // Never null. A segment with no word timings still has a `words` array, so
    // every consumer can iterate it without a guard.
    expect(at(segments, 1).words).toEqual([]);
  });

  it('returns nothing rather than throwing when the shape is wrong', () => {
    expect(segmentsFromJson({})).toEqual([]);
    expect(segmentsFromJson({ transcription: 'not an array' })).toEqual([]);
    expect(segmentsFromJson({ transcription: [null, 7] })).toEqual([]);
  });
});

describe('languageFromJson', () => {
  it('reads the detected language', () => {
    expect(languageFromJson({ result: { language: 'bg' } })).toBe('bg');
  });

  it('answers null rather than inventing one', () => {
    // `null` and `"und"` are different claims. We do not make the second.
    expect(languageFromJson({})).toBeNull();
    expect(languageFromJson({ result: {} })).toBeNull();
    expect(languageFromJson({ result: { language: 42 } })).toBeNull();
  });
});
