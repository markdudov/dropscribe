# 0010 — Six lines per subtitle froze the app for minutes

## Symptom

Settings → Output → set **Lines per subtitle** to 6 and **Longest on screen**
to 20 s, both inside the fields' own limits. Transcribe a long recording. When
the job finishes, the window stops repainting, Cancel and Remove stop
responding, and no further job starts.

Measured on an M-series Mac:

```
  layoutLines, text that genuinely needs every line it is allowed:
    maxLines=2, 14 words  ->     0.1 ms
    maxLines=4, 28 words  ->     2.7 ms
    maxLines=5, 35 words  ->    47.9 ms
    maxLines=6, 42 words  ->   842.4 ms      for ONE cue

  resegment over 2 minutes of speech:
    2 lines /  7 s  ->     1 ms
    6 lines / 20 s  ->  1118 ms   -> a four-hour recording: over two minutes
```

`writeAutoExports` runs at the end of every job and `srt` is in the shipped
default formats, so this is not something the user has to ask for twice.

## Root cause

`balancedSplit` walked **every** way of cutting a cue's words into exactly n
contiguous lines — C(words-1, n-1) of them — allocating an array at each node,
and checked the characters-per-line constraint only at the leaves. `layoutLines`
calls it for n = 2..maxLines.

The comment above it said "a cue is a couple of dozen words at most", and at the
default two lines that is true and the search is linear. The Output tab offers
six lines and thirty seconds a cue. At those settings a cue holds enough words
to genuinely need all six, so n = 2..5 all fail and n = 6 enumerates C(41,5) ≈
750 000 partitions. All of it on the main process's single thread.

## How it was found, and how it was nearly missed

A reviewer raised it; it was dismissed on a measurement that used short words —
with those, a cue fits in two lines and the search returns immediately. The
input has to be text that genuinely *needs* `maxLines` lines before every n
fails and the last one is searched to exhaustion. The dismissal was the wrong
call on the right instrument: the numbers were real, the input was not
representative.

## The fix

The objective is unchanged — minimise `max(length) - min(length)` across the
lines, subject to every line fitting — and so is every result. Three changes to
how it is reached:

- the running line length is carried down instead of being rebuilt with
  `slice().join()` at every node;
- **a line is abandoned the moment it passes `maxCharsPerLine`**, rather than at
  the leaf. This is the one that matters: it caps the branching factor at the
  number of words that fit on one line, so the tree stops being a function of
  the cue's length;
- a starting point that cannot be completed is remembered, so no dead end is
  explored twice.

## Proof that nothing changed but the speed

The old algorithm was kept alongside the new one and both were run over 4000
random cues — 1 to 22 words, 16 to 49 characters a line, 1 to 4 lines:

```
  identical: 4000
  differing: 0
  old total 239 ms, new total 7 ms
```

## Do not undo

The `break` when a line passes `maxCharsPerLine` is not an optimisation of the
common case; it is what stops the search being exponential. Removing it restores
the freeze.

## Test

`test/subtitles.test.ts` — `laying out a cue that genuinely needs every line it
is allowed`: one cue of 42 words at six lines under 200 ms, and a 300-word
transcript at those settings under 500 ms. The bounds are generous on purpose —
the point is the difference between milliseconds and minutes.
