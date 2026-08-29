/**
 * The one transcript shape every engine and every provider is converted into.
 *
 * **All time in this file is integer milliseconds.** Every engine speaks a
 * different dialect — whisper.cpp emits centiseconds in `t0`/`t1`, Deepgram and
 * ElevenLabs emit fractional seconds, sherpa-onnx emits fractional seconds with
 * a different rounding — and the conversion happens exactly once, at the
 * adapter boundary. Nothing downstream of an adapter ever sees a float second.
 *
 * The reason is the same one that governs frame math elsewhere: `14.3 * 1000`
 * is `14299.999999999998` in binary floating point, and a subtitle exporter
 * that floors it loses a millisecond on every cue. Rounding once, at the edge,
 * where the engine's own precision is still known, keeps every later stage
 * exact.
 */

/** A single recognized word, with the timings the engine gave for it. */
export interface Word {
  /** The word as it should be rendered, including any punctuation attached to it. */
  text: string;
  startMs: number;
  endMs: number;
  /** 0..1. Present only where the engine reports a per-word confidence. */
  confidence?: number;
  /** Diarization label, e.g. `"0"` or `"speaker_1"`. Present only when diarizing. */
  speaker?: string;
}

/**
 * One utterance-sized chunk of the transcript.
 *
 * A segment is what the *engine* considered one unit — a Whisper decode window,
 * a Deepgram paragraph, an ElevenLabs speaker turn. It is deliberately NOT a
 * subtitle cue: cues are derived later by `resegment` in `subtitles.ts`, which
 * applies reading-speed and line-length rules a recognizer knows nothing about.
 */
export interface Segment {
  startMs: number;
  endMs: number;
  text: string;
  /** Empty when the engine reports no word-level timings. Never null. */
  words: Word[];
  speaker?: string;
}

export interface Transcript {
  /**
   * ISO-639-1 where the engine gives one, otherwise whatever tag it reported,
   * lowercased. `null` when the engine reports nothing — which is different
   * from "und": we do not invent a language we were not told.
   */
  language: string | null;
  /** 0..1. Only ElevenLabs and Deepgram's detect_language report this. */
  languageConfidence?: number;
  /** Media duration as measured by ffprobe, not as claimed by the engine. */
  durationMs: number;
  segments: Segment[];
  /** How this was produced, for the UI and for the exported JSON header. */
  source: TranscriptSource;
  /** ISO-8601, stamped when the job completed. */
  createdAt: string;
}

export interface TranscriptSource {
  /** `local` or the provider id. */
  kind: 'local' | 'cloud';
  /** Engine or provider id, e.g. `whisper-cpp`, `deepgram`. */
  engineId: string;
  /** Model id as sent to the engine, e.g. `large-v3-turbo`, `nova-3-general`. */
  modelId: string;
  /** Human label for the UI, e.g. `Whisper large-v3-turbo (local)`. */
  label: string;
}

/** Every word of every segment, in order. Cheap enough to call per export. */
export function allWords(transcript: Transcript): Word[] {
  const out: Word[] = [];
  for (const segment of transcript.segments) out.push(...segment.words);
  return out;
}

/** True when at least one segment carries word timings worth re-segmenting on. */
export function hasWordTimings(transcript: Transcript): boolean {
  return transcript.segments.some((s) => s.words.length > 0);
}

/** The distinct speaker labels, in first-appearance order. Empty when not diarized. */
export function speakers(transcript: Transcript): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const segment of transcript.segments) {
    const labels = segment.words.length > 0
      ? segment.words.map((w) => w.speaker)
      : [segment.speaker];
    for (const label of labels) {
      if (label === undefined || seen.has(label)) continue;
      seen.add(label);
      order.push(label);
    }
  }
  return order;
}

/**
 * Clamp and repair a transcript coming out of an adapter.
 *
 * Engines do produce nonsense at the edges: whisper.cpp can emit a final
 * segment whose `t1` runs past the end of the audio when the last window was
 * padded, and a hallucinated tail segment often has `start === end`. Repairing
 * here rather than in each adapter means one place to look when a cue lands in
 * the wrong second.
 */
export function normalizeTranscript(transcript: Transcript): Transcript {
  const limit = Math.max(0, Math.round(transcript.durationMs));
  const clamp = (ms: number): number => Math.min(Math.max(0, Math.round(ms)), limit || Math.round(ms));

  const segments: Segment[] = [];
  for (const segment of transcript.segments) {
    const text = segment.text.trim();
    const words = segment.words
      .map((w): Word => ({
        ...w,
        text: w.text,
        startMs: clamp(w.startMs),
        endMs: Math.max(clamp(w.endMs), clamp(w.startMs)),
      }))
      .filter((w) => w.text.length > 0);
    // A segment with no text and no words carries nothing; a segment with text
    // but a zero-length span is kept, because the text is still the transcript.
    if (text.length === 0 && words.length === 0) continue;
    const startMs = clamp(segment.startMs);
    const endMs = Math.max(clamp(segment.endMs), startMs);
    segments.push({ ...segment, text, words, startMs, endMs });
  }

  segments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return { ...transcript, segments };
}
