/**
 * A finished transcript, rendered into each of the six files a user can ask for.
 *
 * This module is pure — no `node:`, no `electron` — because both processes need
 * it. Main writes the auto-export files when a job finishes; the renderer
 * renders the very same string into the preview pane and onto the clipboard. If
 * the preview were produced by a second, renderer-side formatter, the file the
 * user saved would eventually stop matching the text they had just read, and
 * that is exactly the class of bug nobody reports because nobody believes it.
 *
 * Two of the six formats are not written here at all. `srt` and `vtt` go
 * through `resegment()` in `subtitles.ts` first, because a recognizer's
 * segments are not subtitle cues; see that file for why. The other four are
 * documents, and a document wants the engine's own segmentation rather than a
 * reading-speed-constrained one.
 */

import type { ExportFormat } from '../api-types';
import type { Cue, SegmentationOptions } from './subtitles';
import { formatTimestamp, resegment, toSrt, toVtt } from './subtitles';
import type { Segment, Transcript } from './transcript';

export interface RenderOptions {
  /** Cue rules for `srt` and `vtt`. Ignored by the document formats. */
  segmentation: SegmentationOptions;
  /** One switch for all six formats — see `speakerOf` below for why. */
  includeSpeakers: boolean;
  /** The dropped file's name, used as the `md` title. Not a path. */
  sourceName: string;
}

/** Identifies the writer in the exported JSON, so a stray file can be placed. */
const GENERATOR = 'DropScribe';

/**
 * The version of the JSON *shape*, not of the app.
 *
 * A consumer parsing an exported `.json` cares whether `segments[].words[]`
 * exists, not which build produced it — and the app version is unavailable here
 * anyway, since a module the renderer compiles cannot read `package.json`. This
 * number moves only when the shape changes in a way that would break a reader.
 */
const JSON_SCHEMA_VERSION = 1;

/**
 * A silence long enough to start a new paragraph in `txt` and `md`.
 *
 * Without it, an undiarized transcript — which is most of them — renders as one
 * unbroken block from the first word to the last, and a two-hour film becomes a
 * single 90 000-character paragraph. Two seconds is roughly where a human
 * transcriber reaches for the Return key: long enough that an ordinary sentence
 * boundary does not trigger it, short enough that a scene change always does.
 */
const PARAGRAPH_GAP_MS = 2000;

/** The lowest code point that is not a C0 control character. */
const FIRST_PRINTABLE = 0x20;

/** `hh:mm:ss`, for the `md` anchors and the duration line. */
function clock(ms: number): string {
  // `formatTimestamp` is where all time formatting lives; splitting the
  // milliseconds off is cheaper than a second implementation that would
  // eventually disagree with it about rounding. Splitting on the separator
  // rather than slicing eight characters keeps this right past 99 hours, where
  // the hour field grows a third digit.
  return formatTimestamp(ms, '.').split('.')[0] ?? '00:00:00';
}

/**
 * The speaker label for a segment, taken verbatim from the engine.
 *
 * Deliberately not prettified. `"0"` and `"speaker_1"` look wrong at the head of
 * a paragraph, but turning them into `"Speaker 0"` here would mean the `.txt`
 * and the `.srt` of one job disagree about who is talking — `toSrt` renders
 * `cue.speaker` raw, and it lives in a file this one does not own. One label
 * everywhere beats a nicer label in four formats out of six.
 *
 * Word-level labels win over the segment's own, matching `speakers()` in
 * `transcript.ts`. A segment whose words disagree with each other keeps its
 * first word's label; splitting on a mid-segment speaker change is a cue
 * concern, and `resegment` already does it for the subtitle formats.
 */
function speakerOf(segment: Segment): string | undefined {
  return segment.words[0]?.speaker ?? segment.speaker;
}

interface Turn {
  speaker: string | undefined;
  segments: Segment[];
}

/** Consecutive segments by one speaker, uninterrupted by a long silence. */
function groupTurns(segments: readonly Segment[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  let previousEndMs = 0;

  for (const segment of segments) {
    const speaker = speakerOf(segment);
    const continues =
      current !== undefined &&
      current.speaker === speaker &&
      segment.startMs - previousEndMs < PARAGRAPH_GAP_MS;
    if (current === undefined || !continues) {
      current = { speaker, segments: [] };
      turns.push(current);
    }
    current.segments.push(segment);
    previousEndMs = segment.endMs;
  }
  return turns;
}

/** The segment texts of one turn, joined into a single paragraph. */
function turnText(turn: Turn): string {
  return turn.segments
    .map((segment) => segment.text.trim())
    .filter((text) => text.length > 0)
    .join(' ');
}

/**
 * Plain text: paragraphs, a blank line between turns, and no timestamps at all.
 *
 * This is the format people paste into a document, so it carries nothing a word
 * processor would have to be told to ignore. Anyone who wants the timings back
 * has five other formats to choose from.
 */
function toPlainText(transcript: Transcript, includeSpeakers: boolean): string {
  const paragraphs: string[] = [];
  for (const turn of groupTurns(transcript.segments)) {
    const body = turnText(turn);
    if (body.length === 0) continue;
    paragraphs.push(
      includeSpeakers && turn.speaker !== undefined ? `${turn.speaker}: ${body}` : body,
    );
  }
  if (paragraphs.length === 0) return '';
  return `${paragraphs.join('\n\n')}\n`;
}

/**
 * Markdown: a title, a metadata block, then one anchored paragraph per segment.
 *
 * The timestamp comes before the speaker rather than after it so that every
 * paragraph starts at the same column — the anchors form a scannable left
 * gutter, which is the whole reason a reader picks this format over `txt`. The
 * speaker is printed only where it changes: repeating `**Alice:**` on all forty
 * paragraphs of a monologue is noise, and a transcript reader already expects a
 * label to hold until somebody else speaks.
 *
 * The transcript text itself is not markdown-escaped. Escaping every `*` and `_`
 * would mangle legitimate prose to defend against characters that are
 * vanishingly rare in speech, and this file is meant to be read at least as
 * often as it is rendered.
 */
function toMarkdown(transcript: Transcript, options: RenderOptions): string {
  const title = options.sourceName.trim();
  const lines: string[] = [`# ${title.length > 0 ? title : 'Transcript'}`, ''];

  lines.push(`- **Engine:** ${transcript.source.label}`);
  // The model id, not its label: this is the exact string that was sent to the
  // engine, and it is what somebody reproducing this transcript has to repeat.
  lines.push(`- **Model:** ${transcript.source.modelId}`);
  // "not reported" rather than "und" or an empty cell. `transcript.language` is
  // null precisely when the engine told us nothing, and inventing a tag here
  // would undo the care `transcript.ts` takes not to.
  lines.push(`- **Language:** ${transcript.language ?? 'not reported'}`);
  lines.push(`- **Duration:** ${clock(transcript.durationMs)}`);
  lines.push('', '---', '');

  for (const turn of groupTurns(transcript.segments)) {
    let labelled = false;
    for (const segment of turn.segments) {
      const text = segment.text.trim();
      if (text.length === 0) continue;
      const speaker =
        options.includeSpeakers && !labelled && turn.speaker !== undefined
          ? `**${turn.speaker}:** `
          : '';
      if (speaker.length > 0) labelled = true;
      lines.push(`[${clock(segment.startMs)}] ${speaker}${text}`, '');
    }
  }
  return lines.join('\n');
}

/** Transcript → subtitle cues, with the caller's speaker choice winning. */
function cuesFor(transcript: Transcript, options: RenderOptions): Cue[] {
  // `SegmentationOptions` carries its own `includeSpeakers`, but the explicit
  // option is the more specific statement of intent — it describes the export
  // being performed right now, while the segmentation object is a stored
  // preference that happens to have travelled along. The specific one wins.
  return resegment(transcript.segments, {
    ...options.segmentation,
    includeSpeakers: options.includeSpeakers,
  });
}

/**
 * The whole transcript, verbatim, under a two-field header.
 *
 * Two spaces of indentation, because these files get opened in an editor and
 * diffed against one another far more often than they get parsed by something
 * that would rather have them minified. The header sits first so that `head -3`
 * is enough to identify a stray file.
 */
function toJson(transcript: Transcript): string {
  const document = { generator: GENERATOR, version: JSON_SCHEMA_VERSION, ...transcript };
  return `${JSON.stringify(document, null, 2)}\n`;
}

const CSV_HEADER = 'start_ms,end_ms,start,end,speaker,text';

/** RFC 4180: double every quote, and wrap anything containing a delimiter. */
function csvField(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * One row per segment: the machine-readable milliseconds and the human clock.
 *
 * Both are present because the two readers of a CSV want different things — a
 * script wants integers it can subtract, and a person scrubbing a video wants
 * something they can type into a player. The clock uses the WebVTT dot rather
 * than SRT's comma, which would otherwise force all four time columns to be
 * quoted in a comma-separated file for no benefit whatsoever.
 *
 * The speaker column is filled regardless of `includeSpeakers`. That option
 * governs presentation, and a CSV column is data: a consumer who does not want
 * it deletes the column, which is trivial, whereas a consumer who needs it back
 * has to re-run the job.
 *
 * Rows are joined with CRLF, which RFC 4180 mandates and — the reason that
 * actually matters — which Excel requires. Handed bare LF, Excel drops the
 * entire file into row 1.
 */
function toCsv(transcript: Transcript): string {
  const rows: string[] = [CSV_HEADER];
  for (const segment of transcript.segments) {
    const fields = [
      String(segment.startMs),
      String(segment.endMs),
      formatTimestamp(segment.startMs, '.'),
      formatTimestamp(segment.endMs, '.'),
      speakerOf(segment) ?? '',
      // Internal line breaks are collapsed rather than quoted. A quoted newline
      // is legal here, roughly half the tools that claim to read CSV mishandle
      // it, and a segment's internal wrapping carries no meaning worth the risk.
      segment.text.replace(/\s+/g, ' ').trim(),
    ];
    rows.push(fields.map(csvField).join(','));
  }
  return `${rows.join('\r\n')}\r\n`;
}

/** Render a finished transcript into one export format. */
export function renderTranscript(
  transcript: Transcript,
  format: ExportFormat,
  options: RenderOptions,
): string {
  switch (format) {
    case 'txt':
      return toPlainText(transcript, options.includeSpeakers);
    case 'md':
      return toMarkdown(transcript, options);
    case 'srt':
      return toSrt(cuesFor(transcript, options), { includeSpeakers: options.includeSpeakers });
    case 'vtt':
      return toVtt(cuesFor(transcript, options), { includeSpeakers: options.includeSpeakers });
    case 'json':
      return toJson(transcript);
    case 'csv':
      return toCsv(transcript);
    default: {
      // A seventh entry in `EXPORT_FORMATS` fails to compile here rather than
      // silently writing an empty file at runtime.
      const unreachable: never = format;
      throw new Error(`Unsupported export format: ${String(unreachable)}`);
    }
  }
}

/** Drop C0 control characters; a file name may not contain them on any platform. */
function stripControls(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? FIRST_PRINTABLE;
    if (code >= FIRST_PRINTABLE) out += character;
  }
  return out;
}

/**
 * `"My Movie.mp4"` + `"srt"` → `"My Movie.srt"`.
 *
 * Only the final extension is replaced, so `archive.tar.gz` becomes
 * `archive.tar.srt` — which is right, because as far as any file manager is
 * concerned the user's file really is called `archive.tar`. A leading dot is not
 * an extension, so `.env` yields `.env.srt` rather than a file with no name.
 *
 * Sanitizing stops at path separators and control characters and deliberately
 * touches nothing else. The stem comes from a file that already exists in the
 * directory this result will be written to, so every other character in it is by
 * definition legal on this platform; scrubbing colons "for Windows" would rename
 * a Mac user's output away from its source to solve a problem they cannot have.
 * Separators go because the result is joined onto a directory, and a caller who
 * passed a whole path by mistake should get a file beside the source rather than
 * one three levels above it.
 */
export function exportFileName(sourceName: string, format: ExportFormat): string {
  const segments = sourceName.split(/[/\\]/);
  const bare = stripControls(segments[segments.length - 1] ?? '').trim();
  const dot = bare.lastIndexOf('.');
  const stem = dot > 0 ? bare.slice(0, dot) : bare;
  return `${stem.length > 0 ? stem : 'transcript'}.${format}`;
}

/** MIME type for the clipboard, and for any save dialog that asks for one. */
export function contentTypeFor(format: ExportFormat): string {
  switch (format) {
    case 'txt':
      return 'text/plain; charset=utf-8';
    case 'md':
      return 'text/markdown; charset=utf-8';
    case 'srt':
      // Unregistered with IANA, but `application/x-subrip` is what every player
      // and every subtitle site actually sends.
      return 'application/x-subrip; charset=utf-8';
    case 'vtt':
      return 'text/vtt; charset=utf-8';
    case 'json':
      // No charset parameter: RFC 8259 defines JSON as UTF-8, so the parameter
      // is meaningless at best and, by that RFC, is to be ignored anyway.
      return 'application/json';
    case 'csv':
      return 'text/csv; charset=utf-8';
    default: {
      const unreachable: never = format;
      throw new Error(`Unsupported export format: ${String(unreachable)}`);
    }
  }
}
