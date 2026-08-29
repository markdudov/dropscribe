# 0003 — Subtitle cues drew three lines, and ended mid-phrase

## Symptom

An SRT exported from a real transcript opened with:

```
1
00:00:00,120 --> 00:00:04,700
This video is for beginner video
editors who waste hours on tasks
that could be done

2
00:00:04,780 --> 00:00:09,320
in seconds. But even if you're pro
editor, you might still pick up a
thing or two.
```

Three lines per cue, where the setting says two — and the sentence breaks across
the boundary at "that could be / done in seconds", which no subtitler would write.

## Root cause

Two separate faults, one visible and one structural.

**The line count.** `resegment` decided when a cue was full by counting
characters against `maxCharsPerLine * maxLines` — 42 × 2 = 84. That is not the
same question. The first cue's text is **83 characters**, so it passed. But the
break has to fall between words, and this sentence has no two-way split where
both halves are 42 or fewer:

```
This video is for beginner video editors who   -> 44
This video is for beginner video editors       -> 40
  who waste hours on tasks that could be done  -> 43
```

`layoutLines` looked for a balanced legal split, found none, and fell through to
its greedy fallback — which returns however many lines it needs. That fallback
exists so a single word longer than a line is never truncated, and it was doing
exactly what it was written to do. The bug was upstream, in the accumulator that
handed it an unpackable cue.

**The break points.** When a cue ran out of room the accumulator emitted all of
it and started the next one at the next word, wherever that fell. Nothing looked
for a sentence or a clause.

## Why it was hard / what was wrong first

The character budget looks obviously right, and every unit test of `resegment`
passed: the cue satisfied minimum duration, reading speed, the inter-cue gap and
the character budget. It only becomes wrong when you ask a question the function
was not asking — not "how many characters" but "can this be drawn".

The first instinct was to lower the budget, 84 to something like 76, to leave
slack for word boundaries. That is a fudge factor tuned against one sentence: it
would still fail on a sentence with one very long word, and it would split cues
early on every sentence that packs neatly.

The second instinct — after the packing check was in — was to fold a leftover
one-word cue into the one before it. That broke three existing tests, correctly.
A cue boundary that fell on a real silence exists *because* the speaker stopped
there, and merging across it puts a subtitle on screen through a pause the viewer
can hear.

## The fix

`linesNeeded` does a greedy first-fit and returns the line count. Greedy is not
a heuristic here: with the word order fixed, first-fit minimises lines, so the
answer is exact. `fitsInLines` wraps it, and the accumulator asks that instead of
counting characters.

`flushAtBestBreak` closes a full cue at the last sentence end inside it, failing
that the last clause end, carrying the remainder into the next cue. The back-off
is capped at 40 % of the cue so a comma near the start cannot produce a two-word
flash.

`mergeOrphans` folds a trailing fragment shorter than 45 % of a line back into
its neighbour — but only when the result is still legal, the speaker is the same,
and **the gap between them is under `gapSplitMs`**. When the merge would be
illegal, `splitEvenly` rebalances the pair into two ordinary cues instead, with
the boundary time interpolated by character count across their combined span.

## Why this fix and not the obvious one

Lowering the character budget treats the symptom. The packing check answers the
real question and cannot be wrong for a different sentence.

Merging orphans unconditionally is the version that looks complete and is not.
The pause guard is the whole difference between "tidier subtitles" and
"subtitles that lie about when someone stopped talking".

The rebalance interpolates its boundary time by character count, which is an
estimate — by that point the cues no longer carry per-word timings. It is the
honest one available, and the alternative is a defect the viewer sees rather than
one they could measure.

## Test

`test/subtitles.test.ts`, the `resegment — cue length` block. The first three
cases run the verbatim sentence from this entry and assert the line count, the
line length and that no word is lost. `does not leave a one-word cue at the end`
covers the orphan. `will not re-join two cues that a real pause separated` is the
regression guard for the merge — it fails if the gap condition is dropped.

## Do not undo

The greedy fallback in `layoutLines` looks like dead code now that the
accumulator only hands it packable cues. It is not: a single word longer than a
line still reaches it, and its job is to keep that word rather than truncate it.

The 40 % floor in `flushAtBestBreak` and the 45 % orphan threshold look like
magic numbers to tidy away into one constant. They measure different things — one
is how much of a cue may be given back to find a break, the other is how short a
cue has to be before it counts as an orphan — and collapsing them changes both.
