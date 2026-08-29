/// <reference types="vitest/globals" />
/**
 * `electron/engines/whisper-json.ts` — `whisper-cli`'s `-ojf` JSON to words.
 *
 * This is the half of the whisper adapter that touches nothing: no child
 * process, no `binaries-runtime`, no `electron`. The half that does is covered
 * by `test/node/whisper-parse.test.ts`, which lives under `test/node/` because
 * it needs `@types/node`.
 *
 * The four properties below are each a silent failure in production — the
 * transcript still reads plausibly, it is just wrong:
 *
 * - A token's LEADING SPACE is the entire word-boundary signal. whisper
 *   tokenises `" transcription"` as `" trans"` + `"cription"`, so a parser that
 *   trims before inspecting produces a transcript of syllables.
 * - `[_BEG_]`, `[_TT_120]` and `[BLANK_AUDIO]` are not words. Kept, they get
 *   glued onto the next real one.
 * - `offsets.from` / `offsets.to` are ALREADY integer milliseconds. Parakeet is
 *   the engine that reports centiseconds, in the file next door; a wrapper that
 *   multiplies these by ten shifts every cue ten-fold.
 * - Confidence is the MINIMUM token `p`, never the mean.
 */

import {
  isSpecialToken,
  languageFromJson,
  readOffsets,
  segmentsFromJson,
  wordsFromTokens,
} from '../electron/engines/whisper-json';

/** `noUncheckedIndexedAccess` makes every index a `T | undefined`; fail loudly instead. */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`expected an element at index ${index}`);
  return value;
}

/** A token in the shape `-ojf` writes one. `p` is omitted where a test needs it absent. */
function token(text: string, from: number, to: number, p?: number): unknown {
  return { text, offsets: { from, to }, id: 0, ...(p !== undefined ? { p } : {}) };
}

/**
 * "We produce audio." as whisper really tokenises it.
 *
 * `" produ"` + `"ce"` is the whole point: the sub-word split is what a naive
 * one-word-per-token reader gets wrong, and the leading spaces are the only
 * thing marking where one word ends.
 */
const TOKENS: readonly unknown[] = [
  { text: '[_BEG_]', offsets: { from: 0, to: 0 }, id: 50364, p: 0.512 },
  token(' We', 0, 320, 0.9812),
  token(' produ', 320, 700, 0.921),
  token('ce', 700, 900, 0.7204),
  token(' audio', 940, 1600, 0.9931),
  token('.', 1600, 1620, 0.8802),
  { text: '[_TT_120]', offsets: { from: 2000, to: 2000 }, id: 50484, p: 0.4001 },
];

describe('wordsFromTokens', () => {
  it('starts a new word at a leading space and continues one without', () => {
    expect(wordsFromTokens(TOKENS).map((word) => word.text)).toEqual(['We', 'produce', 'audio.']);
  });

  it('reads offsets as the integer milliseconds they already are', () => {
    const words = wordsFromTokens(TOKENS);
    // 0..320 stays 0..320. A wrapper reading `t0`/`t1` would write 0..3200.
    expect(at(words, 0)).toMatchObject({ startMs: 0, endMs: 320 });
    expect(at(words, 1)).toMatchObject({ startMs: 320, endMs: 900 });
    expect(at(words, 2)).toMatchObject({ startMs: 940, endMs: 1_620 });
  });

  it('takes the minimum token probability, not the mean', () => {
    const words = wordsFromTokens(TOKENS);
    // "produce" is 0.9210 and 0.7204; the mean would be 0.8207, comfortably
    // above any threshold the weak syllable should have tripped.
    expect(at(words, 1).confidence).toBe(0.7204);
    expect(at(words, 1).confidence).not.toBeCloseTo((0.921 + 0.7204) / 2, 4);
    expect(at(words, 2).confidence).toBe(0.8802);
  });

  it('drops [_BEG_], [_TT_n] and every other bracketed special token', () => {
    const words = wordsFromTokens(TOKENS);
    for (const word of words) {
      expect(word.text).not.toMatch(/\[_/);
      expect(word.text).not.toMatch(/^\[.*\]$/);
    }
    // `[_BEG_]` sits at offset 0 carrying p=0.512. Had it been merged into "We",
    // that word would still start at 0 but would report 0.512 as its confidence.
    expect(at(words, 0).confidence).toBe(0.9812);
  });

  it('drops the audio-event annotations too', () => {
    const words = wordsFromTokens([
      token(' [BLANK_AUDIO]', 0, 1_000, 0.9),
      token(' [MUSIC]', 1_000, 2_000, 0.9),
      token(' Hello', 2_000, 2_400, 0.9),
    ]);
    expect(words.map((word) => word.text)).toEqual(['Hello']);
  });

  it('treats a whitespace-only token as a boundary rather than a word', () => {
    const words = wordsFromTokens([
      token('one', 0, 300, 0.9),
      token(' ', 300, 320, 0.9),
      token('two', 320, 900, 0.8),
    ]);
    expect(words.map((word) => word.text)).toEqual(['one', 'two']);
    expect(at(words, 1)).toMatchObject({ startMs: 320, endMs: 900 });
  });

  // The token after a full stop frequently arrives without the leading space
  // that normally marks a boundary, so sentence-final punctuation closes a word.
  it('closes a word on sentence-final punctuation', () => {
    const words = wordsFromTokens([
      token(' Hi', 0, 200, 0.9),
      token('.', 200, 220, 0.9),
      token('Then', 240, 600, 0.9),
    ]);
    expect(words.map((word) => word.text)).toEqual(['Hi.', 'Then']);
  });

  // The known and accepted cost of that rule, pinned so nobody "fixes" it by
  // accident and breaks a language that does not capitalise.
  it('splits a decimal number, the price the rule openly pays', () => {
    const words = wordsFromTokens([
      token(' 3', 0, 100, 0.9),
      token('.', 100, 110, 0.9),
      token('14', 110, 300, 0.9),
    ]);
    expect(words.map((word) => word.text)).toEqual(['3.', '14']);
  });

  it('omits confidence entirely when no token carried a probability', () => {
    const words = wordsFromTokens([token(' Hello', 0, 400)]);
    expect(words).toEqual([{ text: 'Hello', startMs: 0, endMs: 400 }]);
    expect('confidence' in at(words, 0)).toBe(false);
  });

  it('keeps the one probability it did get when a sibling token has none', () => {
    const words = wordsFromTokens([token(' produ', 0, 300, 0.42), token('ce', 300, 500)]);
    expect(words).toEqual([{ text: 'produce', startMs: 0, endMs: 500, confidence: 0.42 }]);
  });

  it('never lets an end run before its own start', () => {
    const words = wordsFromTokens([token(' backwards', 900, 100, 0.9)]);
    expect(at(words, 0)).toMatchObject({ startMs: 900, endMs: 900 });
  });

  it('skips anything that is not a usable token', () => {
    expect(
      wordsFromTokens([
        'not an object',
        null,
        { id: 1 },
        { text: 42, offsets: { from: 0, to: 1 } },
        // No offsets at all: there is nothing to time it with.
        { text: ' orphan', id: 2, p: 0.9 },
        token(' Kept', 0, 400, 0.9),
      ]).map((word) => word.text),
    ).toEqual(['Kept']);
  });

  it('returns nothing for no tokens', () => {
    expect(wordsFromTokens([])).toEqual([]);
  });
});

describe('segmentsFromJson', () => {
  const DOCUMENT: Record<string, unknown> = {
    systeminfo: 'NEON = 1 | ARM_FMA = 1 | METAL = 1 |',
    result: { language: 'en' },
    transcription: [
      {
        timestamps: { from: '00:00:00,000', to: '00:00:02,000' },
        offsets: { from: 0, to: 2000 },
        text: ' We produce audio.',
        tokens: TOKENS,
      },
    ],
  };

  it('builds one segment per transcription entry, words included', () => {
    const segments = segmentsFromJson(DOCUMENT);
    expect(segments).toHaveLength(1);
    expect(at(segments, 0)).toMatchObject({ startMs: 0, endMs: 2_000, text: 'We produce audio.' });
    expect(at(segments, 0).words.map((word) => word.text)).toEqual(['We', 'produce', 'audio.']);
  });

  // whisper marks silence with a segment whose entire text is `[BLANK_AUDIO]`.
  // Kept, it puts a subtitle reading "[BLANK_AUDIO]" over the silence, which is
  // worse than the gap it describes.
  it('drops a segment that is nothing but a bracketed annotation', () => {
    const segments = segmentsFromJson({
      transcription: [
        { offsets: { from: 0, to: 1000 }, text: ' [BLANK_AUDIO]', tokens: [token(' [BLANK_AUDIO]', 0, 1_000, 0.9)] },
        { offsets: { from: 1000, to: 1500 }, text: ' Hello.', tokens: [token(' Hello.', 1_000, 1_500, 0.9)] },
      ],
    });
    expect(segments.map((segment) => segment.text)).toEqual(['Hello.']);
  });

  it('falls back to the segment text when a build stops writing tokens', () => {
    const segments = segmentsFromJson({
      transcription: [{ offsets: { from: 0, to: 1000 }, text: ' No tokens here.' }],
    });
    expect(at(segments, 0).text).toBe('No tokens here.');
    expect(at(segments, 0).words).toEqual([]);
  });

  it('falls back to the words when a build stops writing segment text', () => {
    const segments = segmentsFromJson({
      transcription: [{ offsets: { from: 0, to: 900 }, tokens: [token(' one', 0, 300, 0.9), token(' two', 320, 900, 0.9)] }],
    });
    expect(at(segments, 0).text).toBe('one two');
  });

  it('times a segment from its words when the entry has no offsets', () => {
    const segments = segmentsFromJson({
      transcription: [{ text: ' one two', tokens: [token(' one', 120, 300, 0.9), token(' two', 320, 940, 0.9)] }],
    });
    expect(at(segments, 0)).toMatchObject({ startMs: 120, endMs: 940 });
  });

  it('skips entries it cannot read at all', () => {
    expect(
      segmentsFromJson({
        transcription: [
          'not an object',
          null,
          // Neither text nor a usable token: there is nothing to keep.
          { offsets: { from: 0, to: 10 }, text: '   ', tokens: [] },
          { offsets: { from: 10, to: 500 }, text: ' Kept.', tokens: [token(' Kept.', 10, 500, 0.9)] },
        ],
      }).map((segment) => segment.text),
    ).toEqual(['Kept.']);
  });

  it('returns nothing when the document has no transcription array', () => {
    expect(segmentsFromJson({})).toEqual([]);
    expect(segmentsFromJson({ transcription: 'nope' })).toEqual([]);
    expect(segmentsFromJson({ transcription: [] })).toEqual([]);
  });
});

describe('languageFromJson', () => {
  it('reports the language whisper decoded in, lowercased and trimmed', () => {
    expect(languageFromJson({ result: { language: 'en' } })).toBe('en');
    expect(languageFromJson({ result: { language: '  BG  ' } })).toBe('bg');
  });

  // `auto` and `und` are echoes of the flag, not detections. The transcript
  // contract is explicit that a language is never invented.
  it('never invents a language out of an echo', () => {
    expect(languageFromJson({ result: { language: 'auto' } })).toBeNull();
    expect(languageFromJson({ result: { language: 'und' } })).toBeNull();
    expect(languageFromJson({ result: { language: '' } })).toBeNull();
    expect(languageFromJson({ result: { language: '   ' } })).toBeNull();
  });

  it('returns null when the document says nothing about a language', () => {
    expect(languageFromJson({})).toBeNull();
    expect(languageFromJson({ result: 'nope' })).toBeNull();
    expect(languageFromJson({ result: {} })).toBeNull();
    expect(languageFromJson({ result: { language: 7 } })).toBeNull();
  });
});

describe('the small readers the merge is built from', () => {
  it('recognises a special token without mistaking real text for one', () => {
    expect(isSpecialToken('[_BEG_]')).toBe(true);
    expect(isSpecialToken(' [_TT_120]')).toBe(true);
    expect(isSpecialToken('[BLANK_AUDIO]')).toBe(true);
    expect(isSpecialToken(' We')).toBe(false);
    // Whitespace is a boundary, not a special token — the merge handles it
    // separately, and calling it special here would lose the boundary.
    expect(isSpecialToken('   ')).toBe(false);
  });

  it('reads offsets only when both ends are finite numbers', () => {
    expect(readOffsets({ offsets: { from: 10, to: 220 } })).toEqual({ from: 10, to: 220 });
    expect(readOffsets({ offsets: { from: 10 } })).toBeNull();
    expect(readOffsets({ offsets: { from: '10', to: '220' } })).toBeNull();
    expect(readOffsets({ offsets: { from: 0, to: Number.NaN } })).toBeNull();
    expect(readOffsets({})).toBeNull();
  });
});
