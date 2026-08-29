/// <reference types="vitest/globals" />
/**
 * `electron/shared/subtitles.ts` — timestamps, line layout, and re-segmentation.
 *
 * The three things tested here are the three that produce a *plausible* wrong
 * answer rather than a crash, which is why they get literal expected strings
 * instead of snapshots. A drifted millisecond, a greedily filled second line and
 * a silently swallowed word all ship happily; a reviewer can only catch them by
 * reading what correct looks like, and a `.snap` file nobody opens is exactly
 * the wrong place to keep that.
 */

import type { Cue, SegmentationOptions } from '../electron/shared/subtitles';
import {
  DEFAULT_SEGMENTATION,
  formatTimestamp,
  layoutLines,
  resegment,
  toSrt,
  toVtt,
} from '../electron/shared/subtitles';

/** `noUncheckedIndexedAccess` makes every index a `T | undefined`; fail loudly instead. */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`expected an element at index ${index}`);
  return value;
}

interface TestWord {
  text: string;
  startMs: number;
  endMs: number;
  speaker?: string;
}

interface TestSegment {
  startMs: number;
  endMs: number;
  text: string;
  words: TestWord[];
  speaker?: string;
}

/** `exactOptionalPropertyTypes`: an absent speaker is an absent key, never `undefined`. */
function w(text: string, startMs: number, endMs: number, speaker?: string): TestWord {
  return { text, startMs, endMs, ...(speaker !== undefined ? { speaker } : {}) };
}

/** A segment whose span is derived from its words, the way a real adapter builds one. */
function seg(words: TestWord[]): TestSegment {
  const first = at(words, 0);
  const last = at(words, words.length - 1);
  return {
    startMs: first.startMs,
    endMs: last.endMs,
    text: words.map((word) => word.text).join(' '),
    words,
  };
}

/** A segment carrying only text, as DeepInfra's non-verbose responses do. */
function textSeg(text: string, startMs: number, endMs: number): TestSegment {
  return { startMs, endMs, text, words: [] };
}

describe('formatTimestamp', () => {
  it('writes SRT with a comma and WebVTT with a dot', () => {
    expect(formatTimestamp(3_723_456, ',')).toBe('01:02:03,456');
    expect(formatTimestamp(3_723_456, '.')).toBe('01:02:03.456');
  });

  it('pads zero out to a full field rather than emitting "0:0:0,0"', () => {
    expect(formatTimestamp(0, ',')).toBe('00:00:00,000');
    expect(formatTimestamp(0, '.')).toBe('00:00:00.000');
  });

  it('does not roll an exact hour boundary into the wrong hour', () => {
    expect(formatTimestamp(3_599_999, ',')).toBe('00:59:59,999');
    expect(formatTimestamp(3_600_000, ',')).toBe('01:00:00,000');
    expect(formatTimestamp(3_600_001, ',')).toBe('01:00:00,001');
    expect(formatTimestamp(7_200_000, ',')).toBe('02:00:00,000');
  });

  // The whole reason `transcript.ts` insists on integer milliseconds: `14.3 * 1000`
  // is 14299.999999999998, and a formatter that truncates writes 14,299.
  it('does not drift on 14300 ms, however it was computed', () => {
    expect(formatTimestamp(14_300, ',')).toBe('00:00:14,300');
    expect(formatTimestamp(14.3 * 1000, ',')).toBe('00:00:14,300');
    expect(formatTimestamp(14_299.6, ',')).toBe('00:00:14,300');
  });

  it('clamps a negative time to zero instead of writing a minus sign', () => {
    expect(formatTimestamp(-1, ',')).toBe('00:00:00,000');
    expect(formatTimestamp(-5_000, '.')).toBe('00:00:00.000');
  });

  it('grows the hour field past 99 hours rather than wrapping', () => {
    expect(formatTimestamp(360_000_000, ',')).toBe('100:00:00,000');
  });
});

describe('layoutLines', () => {
  it('leaves a cue that fits on one line alone', () => {
    expect(layoutLines(['short', 'enough'], 42, 2)).toEqual(['short enough']);
  });

  // The failure this guards is cosmetic but instantly readable as a bug: a
  // greedy fill puts 19 characters above 2.
  it('balances the two lines instead of filling the first one greedily', () => {
    const words = ['aaaa', 'bbbb', 'cccc', 'dddd', 'ee'];
    expect(layoutLines(words, 20, 2)).toEqual(['aaaa bbbb', 'cccc dddd ee']);
    expect(layoutLines(words, 20, 2)).not.toEqual(['aaaa bbbb cccc dddd', 'ee']);
  });

  it('honours maxLines === 1 by never breaking at all', () => {
    expect(layoutLines(['aaaa', 'bbbb', 'cccc'], 5, 1)).toEqual(['aaaa bbbb cccc']);
  });

  // Truncating here would silently delete a transcribed word, which is worse
  // than a line one character over the style guide.
  it('keeps a single over-long word whole', () => {
    const long = 'Pneumonoultramicroscopicsilicovolcanoconiosis';
    expect(long.length).toBeGreaterThan(20);
    expect(layoutLines([long], 20, 2)).toEqual([long]);
    expect(layoutLines(['short', long], 20, 2)).toEqual(['short', long]);
    expect(layoutLines([long, 'short'], 20, 2)).toEqual([long, 'short']);
  });
});

describe('resegment', () => {
  const FIVE_LETTER = [
    'alpha', 'bravo', 'delta', 'gamma', 'hotel', 'india',
    'kilos', 'lemon', 'mango', 'novas', 'oscar', 'pears',
  ];

  it('respects maxCharsPerLine × maxLines as the per-cue budget', () => {
    // 12 words of 5 characters, 100 ms apart: nothing but the character budget
    // can close a cue here, so the split point is proof the budget is applied.
    const words = FIVE_LETTER.map((text, i) => w(text, i * 400, i * 400 + 300));
    const cues = resegment([seg(words)], { maxCharsPerLine: 20, maxLines: 2 });

    expect(cues).toHaveLength(2);
    for (const cue of cues) {
      expect(cue.lines.length).toBeLessThanOrEqual(2);
      for (const line of cue.lines) expect(line.length).toBeLessThanOrEqual(20);
      expect(cue.lines.join(' ').length).toBeLessThanOrEqual(20 * 2);
    }
    expect(at(cues, 0).lines).toEqual(['alpha bravo delta', 'gamma hotel india']);
    expect(at(cues, 1).lines).toEqual(['kilos lemon mango', 'novas oscar pears']);
  });

  it('splits on a silence at least gapSplitMs long, and not on a shorter one', () => {
    const words = [w('one', 0, 300), w('two', 400, 700), w('three', 1500, 1800)];
    // 100 ms between "one" and "two", 800 ms between "two" and "three".
    const split = resegment([seg(words)], { gapSplitMs: 700 });
    expect(split.map((cue) => cue.lines)).toEqual([['one two'], ['three']]);

    // Same words, a threshold the 800 ms silence no longer reaches.
    const merged = resegment([seg(words)], { gapSplitMs: 2000 });
    expect(merged.map((cue) => cue.lines)).toEqual([['one two three']]);
  });

  it('splits on a speaker change even mid-segment', () => {
    const words = [w('hello', 0, 300, 'A'), w('there', 400, 700, 'A'), w('hi', 800, 1100, 'B')];
    const cues = resegment([seg(words)]);

    expect(cues).toHaveLength(2);
    expect(at(cues, 0).lines).toEqual(['hello there']);
    expect(at(cues, 0).speaker).toBe('A');
    expect(at(cues, 1).lines).toEqual(['hi']);
    expect(at(cues, 1).speaker).toBe('B');
  });

  it('never emits a cue shorter than minDurationMs when nothing follows it closely', () => {
    // 200 ms and 150 ms of audio: both would flash unreadably without the floor.
    const segments = [seg([w('Hi.', 0, 200)]), seg([w('Yes.', 5_000, 5_150)])];

    const defaults = resegment(segments);
    expect(defaults).toHaveLength(2);
    for (const cue of defaults) {
      expect(cue.endMs - cue.startMs).toBeGreaterThanOrEqual(DEFAULT_SEGMENTATION.minDurationMs);
    }

    const slower = resegment(segments, { minDurationMs: 1_500 });
    for (const cue of slower) expect(cue.endMs - cue.startMs).toBeGreaterThanOrEqual(1_500);
  });

  // The one place the floor yields: `applyTiming` enforces the gap *after* the
  // extension, so a cue whose neighbour starts 900 ms later is trimmed back
  // rather than allowed to overlap it. Pinned deliberately — an implementation
  // that reordered those two passes would silently start overlapping cues.
  it('lets the minimum gap win over the minimum duration when they conflict', () => {
    const cues = resegment([seg([w('Hi.', 0, 200)]), seg([w('Yes.', 900, 1_100)])]);

    expect(cues).toHaveLength(2);
    expect(at(cues, 0).endMs).toBe(900 - DEFAULT_SEGMENTATION.minGapMs);
    expect(at(cues, 0).endMs).toBeLessThan(at(cues, 1).startMs);
  });

  it('interpolates timings for a segment the engine gave no words for', () => {
    const cues = resegment([textSeg('Hello world, this is a test.', 0, 4_000)], {
      maxCharsPerLine: 12,
      maxLines: 1,
    });
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.flatMap((cue) => cue.lines).join(' ')).toBe('Hello world, this is a test.');
  });
});

/**
 * The table the "no word is ever lost" property runs over.
 *
 * Word loss is the one `resegment` bug a user cannot detect from the output —
 * the subtitles read fine, they are just missing a sentence — so it is checked
 * as a property over several shapes rather than by asserting one expected
 * result. Each entry exercises a different reason a cue closes.
 */
const TRANSCRIPTS: readonly { name: string; segments: TestSegment[]; options: Partial<SegmentationOptions> }[] = [
  {
    name: 'word-timed narration with sentence punctuation',
    segments: [
      seg([
        w('The', 0, 200), w('quick', 220, 500), w('brown', 520, 900), w('fox.', 920, 1_400),
        w('It', 1_600, 1_750), w('jumped', 1_780, 2_200), w('over', 2_220, 2_500),
        w('the', 2_520, 2_650), w('lazy', 2_680, 3_000), w('dog.', 3_020, 3_400),
      ]),
      seg([
        w('Then', 4_500, 4_800), w('it', 4_820, 4_900), w('ran', 4_920, 5_200),
        w('away,', 5_220, 5_600), w('quickly.', 5_620, 6_200),
      ]),
    ],
    options: {},
  },
  {
    name: 'text-only segments, timings interpolated',
    segments: [
      textSeg('This segment carries no word timings at all.', 0, 3_000),
      textSeg('Neither does this one, which follows a long silence.', 6_000, 10_000),
    ],
    options: {},
  },
  {
    name: 'two speakers alternating inside one segment',
    segments: [
      seg([
        w('Are', 0, 200, 'Ann'), w('you', 220, 400, 'Ann'), w('ready?', 420, 800, 'Ann'),
        w('Almost.', 850, 1_400, 'Bob'),
        w('Good,', 1_500, 1_800, 'Ann'), w('then', 1_820, 2_000, 'Ann'), w('go.', 2_020, 2_300, 'Ann'),
      ]),
    ],
    options: {},
  },
  {
    name: 'a word far longer than one line',
    segments: [
      seg([
        w('Diagnosed', 0, 600),
        w('with', 620, 800),
        w('Pneumonoultramicroscopicsilicovolcanoconiosis', 820, 2_400),
        w('today.', 2_420, 2_900),
      ]),
    ],
    options: { maxCharsPerLine: 12, maxLines: 2 },
  },
  {
    name: 'a long silence before every single word',
    segments: [
      seg([w('One', 0, 400), w('two', 3_000, 3_400), w('three', 8_000, 8_400), w('four', 15_000, 15_400)]),
    ],
    options: {},
  },
  {
    name: 'a monologue against deliberately cramped options',
    segments: [
      seg(
        'a b c d e f g h i j k l m n o p q r s t u v w x y z'
          .split(' ')
          .map((text, i) => w(text, i * 120, i * 120 + 100)),
      ),
    ],
    options: { maxCharsPerLine: 8, maxLines: 1, maxDurationMs: 2_000, minDurationMs: 300 },
  },
];

/** What went in: the engine's words, or the tokens `interpolateWords` would make. */
function inputWords(segments: readonly TestSegment[]): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment.words.length > 0) out.push(...segment.words.map((word) => word.text));
    else out.push(...segment.text.split(/\s+/).filter((token) => token.length > 0));
  }
  return out;
}

/** What came out: every rendered line of every cue, flattened back to words. */
function cueWords(cues: readonly Cue[]): string[] {
  return cues
    .flatMap((cue) => cue.lines)
    .join(' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

describe('resegment — properties that must hold for every transcript', () => {
  for (const entry of TRANSCRIPTS) {
    it(`loses no word: ${entry.name}`, () => {
      const cues = resegment(entry.segments, entry.options);
      expect(cueWords(cues)).toEqual(inputWords(entry.segments));
    });

    it(`emits no overlapping cues: ${entry.name}`, () => {
      const opts: SegmentationOptions = { ...DEFAULT_SEGMENTATION, ...entry.options };
      const cues = resegment(entry.segments, entry.options);
      for (let i = 0; i < cues.length - 1; i++) {
        const cue = at(cues, i);
        const next = at(cues, i + 1);
        expect(cue.endMs).toBeGreaterThanOrEqual(cue.startMs);
        expect(cue.startMs).toBeLessThanOrEqual(next.startMs);
        expect(cue.endMs).toBeLessThan(next.startMs);
        // The guarantee `applyTiming` actually makes: back off to `minGapMs`
        // before the next cue, unless that would leave nothing on screen.
        expect(cue.endMs).toBeLessThanOrEqual(Math.max(cue.startMs + 1, next.startMs - opts.minGapMs));
      }
    });

    it(`never exceeds maxDurationMs: ${entry.name}`, () => {
      const opts: SegmentationOptions = { ...DEFAULT_SEGMENTATION, ...entry.options };
      for (const cue of resegment(entry.segments, entry.options)) {
        expect(cue.endMs - cue.startMs).toBeLessThanOrEqual(opts.maxDurationMs);
      }
    });
  }
});

describe('toSrt / toVtt', () => {
  const CUES: readonly Cue[] = [
    { startMs: 0, endMs: 1_500, lines: ['Hello there.'] },
    { startMs: 1_580, endMs: 3_600, lines: ['This is the second cue,', 'on two lines.'] },
  ];

  it('numbers cues from 1 and separates them with a blank line', () => {
    const expected =
      '1\n' +
      '00:00:00,000 --> 00:00:01,500\n' +
      'Hello there.\n' +
      '\n' +
      '2\n' +
      '00:00:01,580 --> 00:00:03,600\n' +
      'This is the second cue,\n' +
      'on two lines.\n';
    expect(toSrt(CUES)).toBe(expected);
  });

  it('puts the mandatory WEBVTT header above the same body, with dots', () => {
    const expected =
      'WEBVTT\n' +
      '\n' +
      '1\n' +
      '00:00:00.000 --> 00:00:01.500\n' +
      'Hello there.\n' +
      '\n' +
      '2\n' +
      '00:00:01.580 --> 00:00:03.600\n' +
      'This is the second cue,\n' +
      'on two lines.\n';
    expect(toVtt(CUES)).toBe(expected);
  });

  it('prefixes only the first line of a cue with its speaker, and only on request', () => {
    const spoken: readonly Cue[] = [
      { startMs: 0, endMs: 1_500, lines: ['Hello there.'], speaker: 'Ann' },
      { startMs: 1_580, endMs: 3_600, lines: ['This is the second cue,', 'on two lines.'], speaker: 'Bob' },
    ];
    const expected =
      '1\n' +
      '00:00:00,000 --> 00:00:01,500\n' +
      'Ann: Hello there.\n' +
      '\n' +
      '2\n' +
      '00:00:01,580 --> 00:00:03,600\n' +
      'Bob: This is the second cue,\n' +
      'on two lines.\n';
    expect(toSrt(spoken, { includeSpeakers: true })).toBe(expected);
    // Default is off, so a diarized transcript exported without the switch is
    // byte-identical to an undiarized one.
    expect(toSrt(spoken)).toBe(toSrt(CUES));
  });

  it('handles an empty cue list without producing a malformed file', () => {
    expect(toSrt([])).toBe('');
    expect(toVtt([])).toBe('WEBVTT\n\n');
  });
});


describe('resegment — cue length, the Netflix-style rules', () => {
  /** Words with plausible timings, so the gap rule never fires by accident. */
  function timed(text: string, msPerWord = 300): { startMs: number; endMs: number; text: string; words: { text: string; startMs: number; endMs: number }[] }[] {
    const parts = text.split(/\s+/).filter((w) => w.length > 0);
    const words = parts.map((word, i) => ({ text: word, startMs: i * msPerWord, endMs: (i + 1) * msPerWord - 10 }));
    return [{ startMs: 0, endMs: parts.length * msPerWord, text, words }];
  }

  /**
   * The exact sentence from docs/bugs/0003, verbatim.
   *
   * 83 characters, which passed the old `maxCharsPerLine * maxLines` budget of
   * 84 — and has no legal two-line split at all, so the layout fell through to
   * a greedy fill and drew three lines.
   */
  const THREE_LINE_SENTENCE =
    'This video is for beginner video editors who waste hours on tasks that could be done';

  it('never draws more lines than maxLines', () => {
    const cues = resegment(timed(THREE_LINE_SENTENCE), DEFAULT_SEGMENTATION);
    for (const cue of cues) {
      expect(cue.lines.length).toBeLessThanOrEqual(DEFAULT_SEGMENTATION.maxLines);
    }
  });

  it('never draws a line longer than maxCharsPerLine', () => {
    const cues = resegment(timed(THREE_LINE_SENTENCE), DEFAULT_SEGMENTATION);
    for (const cue of cues) {
      for (const line of cue.lines) {
        expect(line.length).toBeLessThanOrEqual(DEFAULT_SEGMENTATION.maxCharsPerLine);
      }
    }
  });

  it('keeps every word while splitting to fit', () => {
    const cues = resegment(timed(THREE_LINE_SENTENCE), DEFAULT_SEGMENTATION);
    const out = cues.map((c) => c.lines.join(' ')).join(' ').replace(/\s+/g, ' ').trim();
    expect(out).toBe(THREE_LINE_SENTENCE);
  });

  it('does not leave a one-word cue at the end', () => {
    // The orphan: a full cue plus a single trailing word. It is folded back in,
    // or the pair is rebalanced — either way nothing flashes alone.
    const text = 'Well that is actually a brand new effect in Premiere since the September update';
    const cues = resegment(timed(text), DEFAULT_SEGMENTATION);
    const last = cues[cues.length - 1];
    expect(last).toBeDefined();
    if (last !== undefined) {
      expect(last.lines.join(' ').split(/\s+/).length).toBeGreaterThan(1);
    }
  });

  it('will not re-join two cues that a real pause separated', () => {
    // The guard that a naive orphan merge breaks: the boundary exists because
    // the speaker stopped, and a cue spanning the silence is a worse defect
    // than a short one.
    const segments = [
      {
        startMs: 0,
        endMs: 4000,
        text: 'one two three four five six seven eight nine ten yes',
        words: [
          ...'one two three four five six seven eight nine ten'.split(' ').map((text, i) => ({
            text,
            startMs: i * 200,
            endMs: i * 200 + 150,
          })),
          // A two-second silence, well past gapSplitMs, then one short word.
          { text: 'yes', startMs: 4000, endMs: 4200 },
        ],
      },
    ];
    const cues = resegment(segments, DEFAULT_SEGMENTATION);
    expect(cues.length).toBeGreaterThan(1);
    const last = cues[cues.length - 1];
    expect(last?.lines.join(' ')).toBe('yes');
  });
});
