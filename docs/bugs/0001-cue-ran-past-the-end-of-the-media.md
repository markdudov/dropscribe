# 0001 — A subtitle cue ran past the end of the media

## Symptom

An integration check that pushed a real transcription all the way through to SRT
produced this as the last cue of a **5.414 s** clip:

```
2
00:00:02,580 --> 00:00:05,463
Приложението трябва да
разпознае думите правилно.
```

The cue ends 49 ms after the video does. Nothing in the app complained; the file
looked perfectly well-formed.

## Root cause

`applyTiming` in `electron/shared/subtitles.ts` enforces two floors by *extending*
a cue's `endMs`: `minDurationMs`, so a one-word cue is not an unreadable flash,
and the reading-speed floor `ceil(chars / maxCharsPerSecond * 1000)`.

The final segment ended at 5320 ms and carried 49 characters. At the default 17
characters per second that demands 2883 ms of screen time, so the cue was
extended from 2580 → 5463.

`resegment` was never told where the media ends. It receives segments and style
preferences, and neither carries a duration — so there was no value it could have
clamped against even in principle. The bug is an absent input, not a wrong
calculation.

## Why it was hard / what was wrong first

It is invisible from inside the module. Every unit test of `resegment` passes: the
cue satisfies minimum duration, reading speed, the inter-cue gap and the
line-length rules. The output is correct against every rule the function knows
about. It only becomes wrong when compared against a fact the function was never
given.

The first instinct was to cap the extension at the previous segment's `endMs` —
i.e. never extend a cue at all. That is worse: it reintroduces the sub-second
flash that `minDurationMs` exists to prevent, and it would shorten *every* cue in
the file to fix a defect that only ever affects the last one.

The second instinct was to clamp inside `normalizeTranscript`, which does know
`durationMs`. Wrong layer: it runs before segmentation, so the extension happens
afterwards and undoes the clamp.

## The fix

`SegmentationOptions` gained an optional `mediaDurationMs`. When present,
`applyTiming` clamps as its **last** step — after the extension pass and after the
gap pass — and drops any cue that begins at or after the end of the media (which
is what a hallucinated tail segment on trailing silence looks like).
`cuesFor` in `electron/shared/exports.ts` passes `transcript.durationMs`, which is
the ffprobe measurement, not the engine's own idea of the length.

## Why this fix and not the obvious one

The clamp is **last** deliberately. Clamping before the gap pass would let a pass
that only ever shortens run on an already-clamped value, and clamping before the
extension pass would let the extension push the cue straight back out.

`mediaDurationMs` is **optional** rather than required so the pure segmentation
tests, which have no media behind them, keep calling `resegment` with style
options alone. `undefined` means "do not clamp" — the honest answer when the
caller genuinely does not know.

The duration comes from **ffprobe**, never from the engine. whisper.cpp's final
segment routinely runs past the end of the audio because the last decode window
is zero-padded; clamping against the engine's own numbers would clamp against
the very value that is wrong.

## Test

`test/subtitles.test.ts` — a transcript with `durationMs: 5414` whose last segment
ends at 5320 ms with enough text to trigger the reading-speed extension. Without
the fix the last cue ends at 5463; with it, at 5414. A second case asserts a cue
starting after the duration is dropped rather than clamped to zero length.

## Do not undo

The clamp looks redundant next to `normalizeTranscript`, which already clamps
segments to `durationMs`. It is not: `resegment` runs *after* normalization and
extends cues past what it was given. Removing this because "the transcript is
already clamped" restores the bug exactly.
