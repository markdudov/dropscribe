# 0004 — Cues one millisecond long, two of them sharing an interval

## Symptom

A 110-second recording of one sentence repeated sixty times, transcribed with
Whisper large-v3-turbo, exported to SRT:

```
7
00:00:59,920 --> 00:00:59,921
sentence number one, this
is sentence number one,

8
00:00:59,920 --> 00:00:59,921
this is sentence number one,
```

Two cues, one millisecond each, with identical timings, against a configured
`minDurationMs` of 1000. Three separate invariants broken at once: the minimum
duration, the uniqueness of an interval, and ordering — cue 11 began before
cue 10 had ended.

A one-millisecond cue does not render. Two cues sharing an interval is worse
than either alone: a player stacks them, drops one, or refuses the file.

## How it was found

Not by reading the code. By generating a deliberately repetitive recording,
running it through the real app, and checking every cue in the exported SRT
against every rule the settings claim to enforce. The static review running at
the same time did not find it, and would not have: nothing about the code looks
wrong until you know what the engine hands it.

## Root cause

Thirty-two of that transcript's sixty words came back with
`startMs === endMs`, and words 12 through 23 all carried the **same** instant,
59920 ms. Whisper's DTW alignment collapses on highly repetitive audio and
stacks a run of words on one point.

The engine is not at fault and cannot be fixed here: a recogniser is allowed to
be unsure where a word sits. What was at fault is that every timing rule in
`applyTiming` is written for words that advance, and the gap pass in particular:

```ts
const latestEnd = next.startMs - opts.minGapMs;
if (cue.endMs > latestEnd) cue.endMs = Math.max(cue.startMs + 1, latestEnd);
```

When the next cue starts on the same millisecond, `latestEnd` lands *before*
this cue's own start. The `cue.startMs + 1` floor then fires — and a cue the
extension pass had just widened to a readable second is crushed back to one
millisecond. The floor was there to stop a negative duration, and it did, by
abandoning `minDurationMs` without saying so.

## The fix

Two parts, and the split matters.

**Repair the input at the boundary.** `spreadCollapsedRuns` distributes a run of
words sharing one timestamp across the space up to the next word that carries a
different start — or, for a run that reaches the end of its segment, into the
silence before the next segment begins. Once the words advance again, every
rule downstream does exactly what it was written to do.

This is why the repair is not in the rules. Teaching `minDurationMs`, the
reading-speed floor and the gap pass each to tolerate stacked input would mean
three places that have to keep agreeing about a case none of them is really
about.

**Stop the gap pass trading the floor away.** When the next cue genuinely comes
later, the gap still wins over the minimum duration — that is deliberate, and
pinned by a test that predates this bug. When the next cue starts at or before
this one, there is no gap to honour; the cue keeps its floor and a following
pass moves the next cue out of its way. Moving a cue later keeps it readable and
keeps it in order. The alternatives are crushing it, which was this bug, and
dropping it, which loses the words.

## The second cue this uncovered

The same run also produced a final cue of 120 ms: a sign-off landing in the last
fraction of a second of the file, whose end the media clamp from
[0001](./0001-cue-ran-past-the-end-of-the-media.md) cut to the media end while
its start stayed put.

The floor cannot be met by moving that end — there is nothing after the end of
the media. It can be met by moving the **start** earlier, into silence the cue
is not competing with anything for, bounded by the previous cue's end plus the
minimum gap. That is what a subtitler does, and it is what the timing rules
already do everywhere else.

## Do not undo

- The repair runs **before** anything reads a timestamp, not inside the rules.
- The media clamp still runs last, and still nothing may end after the media.
  0001 is not weakened: the new pass moves starts, never ends.
- `Math.max(cue.startMs + 1, latestEnd)` must not come back. It looks like a
  harmless guard against a negative duration and is the whole of this bug.

## Test

`test/subtitles.test.ts`:

- `cues built from words the engine stacked on one instant` — minimum duration,
  no duplicate intervals, strict ordering, still within the media.
- `a cue that the media clamp would leave too short to read` — reaches the floor
  by starting earlier, still ends exactly at the media end, does not reach back
  into the cue before it.
