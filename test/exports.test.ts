/// <reference types="vitest/globals" />
/**
 * `electron/shared/exports.ts` — the six files a finished job can turn into.
 *
 * The two formats worth literal expected strings are CSV and SRT. CSV because
 * RFC 4180 quoting is the kind of thing that looks right in a terminal and
 * makes Excel silently eat a column; SRT because the exporter is the last stop
 * before a file a video player either accepts or rejects outright.
 */

import type { ExportFormat } from '../electron/api-types';
import { EXPORT_FORMATS } from '../electron/api-types';
import type { RenderOptions } from '../electron/shared/exports';
import { contentTypeFor, exportFileName, renderTranscript } from '../electron/shared/exports';
import { DEFAULT_SEGMENTATION } from '../electron/shared/subtitles';
import type { Transcript, TranscriptSource, Word } from '../electron/shared/transcript';

const SOURCE: TranscriptSource = {
  kind: 'local',
  engineId: 'whisper-cpp',
  modelId: 'ggml-large-v3-turbo',
  label: 'Whisper large-v3-turbo (local)',
};

/** `exactOptionalPropertyTypes`: absent means the key is missing, never `undefined`. */
function word(text: string, startMs: number, endMs: number): Word {
  return { text, startMs, endMs };
}

const OPTIONS: RenderOptions = {
  segmentation: DEFAULT_SEGMENTATION,
  includeSpeakers: false,
  sourceName: 'My Movie.mp4',
};

const TRANSCRIPT: Transcript = {
  language: 'en',
  durationMs: 12_000,
  segments: [
    {
      startMs: 0,
      endMs: 2_000,
      text: 'Hello there.',
      words: [word('Hello', 0, 900), word('there.', 950, 2_000)],
      speaker: 'Ann',
    },
    {
      startMs: 2_400,
      endMs: 5_000,
      text: 'This is a test.',
      words: [
        word('This', 2_400, 2_800),
        word('is', 2_850, 3_100),
        word('a', 3_150, 3_300),
        word('test.', 3_350, 5_000),
      ],
      speaker: 'Bob',
    },
    {
      startMs: 9_000,
      endMs: 11_000,
      text: 'Goodbye.',
      words: [word('Goodbye.', 9_000, 11_000)],
      speaker: 'Ann',
    },
  ],
  source: SOURCE,
  createdAt: '2026-08-29T12:00:00.000Z',
};

/** Every word of the fixture, in order — the thing no format may lose. */
const EVERY_WORD = ['Hello', 'there.', 'This', 'is', 'a', 'test.', 'Goodbye.'];

/** JSON.parse returns `any`, which is banned; narrow it once, here. */
function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected the rendered JSON to be an object');
  }
  return value as Record<string, unknown>;
}

describe('renderTranscript — every format', () => {
  for (const format of EXPORT_FORMATS) {
    it(`carries every transcribed word into ${format}`, () => {
      const rendered = renderTranscript(TRANSCRIPT, format, OPTIONS);
      expect(rendered.length).toBeGreaterThan(0);
      // The subtitle formats re-wrap sentences across lines and cues, so the
      // check is per word rather than per sentence.
      for (const token of EVERY_WORD) expect(rendered).toContain(token);
    });

    it(`has a content type for ${format}`, () => {
      expect(contentTypeFor(format)).toMatch(/^[a-z]+\/[a-z0-9.+-]+/);
    });
  }

  it('covers the whole ExportFormat union', () => {
    const expected: readonly ExportFormat[] = ['txt', 'md', 'srt', 'vtt', 'json', 'csv'];
    expect([...EXPORT_FORMATS]).toEqual([...expected]);
    expect(new Set(EXPORT_FORMATS).size).toBe(EXPORT_FORMATS.length);
  });

  it('names the same MIME type for each format every time it is asked', () => {
    expect(contentTypeFor('txt')).toBe('text/plain; charset=utf-8');
    expect(contentTypeFor('md')).toBe('text/markdown; charset=utf-8');
    expect(contentTypeFor('srt')).toBe('application/x-subrip; charset=utf-8');
    expect(contentTypeFor('vtt')).toBe('text/vtt; charset=utf-8');
    expect(contentTypeFor('json')).toBe('application/json');
    expect(contentTypeFor('csv')).toBe('text/csv; charset=utf-8');
  });
});

describe('renderTranscript — srt and vtt', () => {
  const ONE_SEGMENT: Transcript = {
    language: 'en',
    durationMs: 3_000,
    segments: [
      {
        startMs: 0,
        endMs: 2_000,
        text: 'Hello there.',
        words: [word('Hello', 0, 900), word('there.', 950, 2_000)],
      },
    ],
    source: SOURCE,
    createdAt: '2026-08-29T12:00:00.000Z',
  };

  it('writes a numbered SubRip cue with a trailing blank line', () => {
    const expected =
      '1\n' +
      '00:00:00,000 --> 00:00:02,000\n' +
      'Hello there.\n';
    expect(renderTranscript(ONE_SEGMENT, 'srt', OPTIONS)).toBe(expected);
  });

  it('writes the same cue under a WEBVTT header, with a dot separator', () => {
    const expected =
      'WEBVTT\n' +
      '\n' +
      '1\n' +
      '00:00:00.000 --> 00:00:02.000\n' +
      'Hello there.\n';
    expect(renderTranscript(ONE_SEGMENT, 'vtt', OPTIONS)).toBe(expected);
  });

  // `cuesFor` hands the transcript's own duration to `resegment`, which is the
  // only thing stopping the reading-speed floor from ending a cue after the
  // video does — a file several NLEs refuse to import.
  it('never ends a cue after the media does', () => {
    const short: Transcript = { ...ONE_SEGMENT, durationMs: 1_200 };
    const expected =
      '1\n' +
      '00:00:00,000 --> 00:00:01,200\n' +
      'Hello there.\n';
    expect(renderTranscript(short, 'srt', OPTIONS)).toBe(expected);
  });

  it('prefixes cues with the speaker only when asked', () => {
    const plain = renderTranscript(TRANSCRIPT, 'srt', OPTIONS);
    const spoken = renderTranscript(TRANSCRIPT, 'srt', { ...OPTIONS, includeSpeakers: true });
    expect(plain).not.toContain('Ann:');
    expect(spoken).toContain('Ann: Hello there.');
  });
});

describe('renderTranscript — txt and md', () => {
  it('writes plain text as paragraphs with no timestamps at all', () => {
    const rendered = renderTranscript(TRANSCRIPT, 'txt', OPTIONS);
    expect(rendered).toBe('Hello there.\n\nThis is a test.\n\nGoodbye.\n');
    expect(rendered).not.toContain('00:00');
  });

  it('labels each turn once when speakers are requested', () => {
    const rendered = renderTranscript(TRANSCRIPT, 'txt', { ...OPTIONS, includeSpeakers: true });
    expect(rendered).toBe('Ann: Hello there.\n\nBob: This is a test.\n\nAnn: Goodbye.\n');
  });

  it('opens markdown with the source name and a metadata block', () => {
    const rendered = renderTranscript(TRANSCRIPT, 'md', OPTIONS);
    expect(rendered.startsWith('# My Movie.mp4\n\n')).toBe(true);
    expect(rendered).toContain('- **Engine:** Whisper large-v3-turbo (local)\n');
    expect(rendered).toContain('- **Model:** ggml-large-v3-turbo\n');
    expect(rendered).toContain('- **Language:** en\n');
    expect(rendered).toContain('- **Duration:** 00:00:12\n');
    expect(rendered).toContain('[00:00:00] Hello there.\n');
    expect(rendered).toContain('[00:00:09] Goodbye.\n');
  });

  it('says "not reported" rather than inventing a language tag', () => {
    const rendered = renderTranscript({ ...TRANSCRIPT, language: null }, 'md', OPTIONS);
    expect(rendered).toContain('- **Language:** not reported\n');
  });
});

describe('renderTranscript — csv', () => {
  const QUOTING: Transcript = {
    language: 'en',
    durationMs: 6_000,
    segments: [
      // A comma and a pair of quotes inside the text field.
      { startMs: 0, endMs: 2_000, text: 'He said "hello, world" today', words: [], speaker: 'Ann' },
      // A newline inside the text field, which the exporter collapses rather
      // than quoting — half the tools that claim to read CSV mishandle it.
      { startMs: 2_500, endMs: 5_000, text: 'Line one\nline two', words: [] },
      // All three at once in the speaker field, which is NOT collapsed, so this
      // is the row that proves the quoting itself is RFC 4180.
      { startMs: 5_100, endMs: 6_000, text: 'Fin.', words: [], speaker: 'Ann "The Voice", Jr.\nEsq.' },
    ],
    source: SOURCE,
    createdAt: '2026-08-29T12:00:00.000Z',
  };

  it('quotes per RFC 4180 and separates rows with CRLF', () => {
    const expected =
      // The BOM is part of the contract — see the Excel block at the end of
      // this file. Everything after it is unchanged.
      '\ufeffstart_ms,end_ms,start,end,speaker,text\r\n' +
      '0,2000,00:00:00.000,00:00:02.000,Ann,"He said ""hello, world"" today"\r\n' +
      '2500,5000,00:00:02.500,00:00:05.000,,Line one line two\r\n' +
      '5100,6000,00:00:05.100,00:00:06.000,"Ann ""The Voice"", Jr.\nEsq.",Fin.\r\n';
    expect(renderTranscript(QUOTING, 'csv', OPTIONS)).toBe(expected);
  });

  it('fills the speaker column regardless of includeSpeakers, because a column is data', () => {
    const off = renderTranscript(QUOTING, 'csv', OPTIONS);
    const on = renderTranscript(QUOTING, 'csv', { ...OPTIONS, includeSpeakers: true });
    expect(on).toBe(off);
    expect(off).toContain(',Ann,');
  });
});

describe('renderTranscript — json', () => {
  it('parses back to exactly the transcript it was given', () => {
    const rendered = renderTranscript(TRANSCRIPT, 'json', OPTIONS);
    const parsed = parseObject(rendered);

    expect(parsed['generator']).toBe('DropScribe');
    expect(parsed['version']).toBe(1);

    const body: Record<string, unknown> = { ...parsed };
    delete body['generator'];
    delete body['version'];
    expect(body).toEqual(TRANSCRIPT);
  });

  it('puts the two header fields first and indents by two spaces', () => {
    const rendered = renderTranscript(TRANSCRIPT, 'json', OPTIONS);
    expect(rendered.startsWith('{\n  "generator": "DropScribe",\n  "version": 1,\n')).toBe(true);
    expect(rendered.endsWith('\n')).toBe(true);
  });
});

describe('exportFileName', () => {
  it('replaces the final extension', () => {
    expect(exportFileName('My Movie.mp4', 'srt')).toBe('My Movie.srt');
  });

  it('treats only the last dot as an extension', () => {
    expect(exportFileName('archive.tar.gz', 'json')).toBe('archive.tar.json');
  });

  it('appends rather than replacing when there is no extension', () => {
    expect(exportFileName('noextension', 'md')).toBe('noextension.md');
  });

  it('does not mistake a leading dot for an extension', () => {
    expect(exportFileName('.env', 'txt')).toBe('.env.txt');
    expect(exportFileName('.mp4', 'srt')).toBe('.mp4.srt');
  });

  it('keeps only the last path component, on either platform separator', () => {
    expect(exportFileName('/Users/mark/Movies/My Movie.mp4', 'vtt')).toBe('My Movie.vtt');
    expect(exportFileName('C:\\Users\\mark\\clip.mov', 'csv')).toBe('clip.csv');
  });

  it('strips control characters a file name may not contain', () => {
    expect(exportFileName('clip\u0000\u001f.mp4', 'srt')).toBe('clip.srt');
  });

  it('falls back to a usable name rather than producing a bare extension', () => {
    expect(exportFileName('', 'srt')).toBe('transcript.srt');
    expect(exportFileName('   ', 'srt')).toBe('transcript.srt');
    expect(exportFileName('/Users/mark/', 'srt')).toBe('transcript.srt');
  });
});

/*
 * ── CSV and Excel ─────────────────────────────────────────────────────────
 *
 * `toCsv`'s own comment commits the format to Excel: rows are joined with CRLF
 * "which RFC 4180 mandates and — the reason that actually matters — which Excel
 * requires. Handed bare LF, Excel drops the entire file into row 1."
 *
 * Excel applies the same literalism to the encoding. Opening a UTF-8 CSV with
 * no byte-order mark, it decodes the bytes as the system's legacy code page, so
 * every non-ASCII character in the transcript arrives as mojibake — "Здравей"
 * becomes "Ð—Ð´Ñ€Ð°Ð²ÐµÐ¹". For an app whose author transcribes Bulgarian, that
 * is most of the output.
 *
 * A BOM is three bytes, every CSV parser worth using skips it, and it is the
 * only thing that makes the file open correctly in the program the format was
 * shaped around.
 */
describe('CSV for the program the format was shaped around', () => {
  const transcript: Transcript = {
    ...TRANSCRIPT,
    language: 'bg',
    durationMs: 2_000,
    segments: [{ startMs: 0, endMs: 2_000, text: 'Здравей, свят', words: [] }],
  };

  it('starts with a byte-order mark', () => {
    expect(renderTranscript(transcript, 'csv', OPTIONS).startsWith('﻿')).toBe(true);
  });

  it('still has the header as its first line, and CRLF rows', () => {
    const csv = renderTranscript(transcript, 'csv', OPTIONS);
    expect(csv.slice(1).split('\r\n')[0]).toBe('start_ms,end_ms,start,end,speaker,text');
    expect(csv).toContain('\r\n');
  });

  it('does not put a mark in any other format', () => {
    // The shared TRANSCRIPT rather than the local fixture: Markdown renders
    // the engine banner, so it needs a transcript with a `source`.
    for (const format of ['txt', 'md', 'srt', 'vtt', 'json'] as const) {
      expect(renderTranscript(TRANSCRIPT, format, OPTIONS).startsWith('﻿')).toBe(false);
    }
  });
});
