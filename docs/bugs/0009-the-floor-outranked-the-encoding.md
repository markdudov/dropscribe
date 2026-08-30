# 0009 — The upload ceiling made the upload bigger

## Symptom

`fitBitrate` returned **16k for Opus at every duration**, when Opus is
configured at **12k**:

```
  Opus(12k)   1 min, 17 MiB ceiling -> 16k
  Opus(12k)   5 min                 -> 16k
  Opus(12k)  30 min                 -> 16k
  Opus(12k)  70 min                 -> 16k
  Opus(12k) 120 min                 -> 16k
```

The function exists to shrink an upload under a provider's ceiling. For the
encoding the app prefers, it grew it by a third — on a one-minute file nowhere
near any ceiling.

## Root cause

The function's own doc comment states the rule it broke:

> It never raises the bitrate above the encoding's default. A ceiling is a
> constraint, not a licence to spend more on a short file.

```ts
const chosen = Math.max(MIN_UPLOAD_KBPS, Math.min(preferred, fittedKbps));
```

`MIN_UPLOAD_KBPS` is 16. The floor is applied **last**, so whenever the
encoding's own rate is below it — Opus at 12k — the floor wins and outranks the
encoding. The floor is there to stop the *fitting* producing something
unintelligible, not to raise a rate the encoding chose on purpose.

## Why it survived

Every existing test for `fitBitrate` used AAC, whose 32k is above the floor.
The bug is only reachable through an encoding configured below 16k, and Opus is
the only one — and it is the one the app prefers whenever the bundled ffmpeg
has it (see [0002](./0002-upload-encoder-was-not-in-the-vendored-ffmpeg.md);
the vendored macOS build does not, which is the other reason this stayed
hidden).

## The fix

The floor is clamped to the encoding's own rate before it is applied.

## Test

`test/node/upload-encoder.test.ts` — `fitBitrate with an encoding whose own rate
is below the floor`: never exceeds 12k at 1, 5, 30, 70 or 120 minutes, and still
comes down when the ceiling genuinely bites.
