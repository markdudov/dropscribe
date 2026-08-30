# Bug log

One file per solved non-trivial bug, named `NNNN-slug.md` — a four-digit
sequence number and a short hyphenated slug, for example
`0001-parakeet-timestamps-ten-times-too-long.md`. Numbers are allocated in
order, never reused, and never renumbered once written; the slug can be as
scrappy as it needs to be, because the number is what anything links to.

## Why this directory exists

Not for accountability, and not as a changelog. It exists because **the most
dangerous thing in this codebase is a fix that looks unnecessary.**

Half the engine layer looks wrong on first reading. A CLI with no JSON flag. A
model catalogue that pins `.bin` files in a repository whose name ends in
`-GGUF`. A CI workflow that compiles binaries a project could apparently just
download. A word confidence that takes the minimum instead of the mean. Every
one of those looks like an oversight, every one is load-bearing, and every one
would be deleted inside five minutes by a future session tidying up — unless
something on disk says what happens when you do.

`docs/` explains why the *design* is the way it is. This directory explains why
a specific line of code that appears redundant is not, and — the part nobody
writes down and everybody needs — **which wrong explanations were ruled out
along the way**. A bug entry that records only the answer is half an entry. The
hypotheses that were tried and disproved are what stop the next person from
spending an afternoon re-disproving them.

## The Iron Law

> **No fix ships without a proven root cause, and no fix ships without a failing
> test written first.**

Both halves, every time.

**Proven, not guessed.** "It probably is X" is not a root cause. "It went away
when I changed X" is not a root cause either — that is a correlation, and it is
the single most common way a bug gets closed and then reappears under a new
symptom. A root cause is proven when you can state the mechanism *and*
demonstrate it against the real system: instrument it, print the value, run the
binary, read the response body, produce the failure on demand. The engine layer
in particular punishes guessing, because whisper.cpp's C API and its CLI's JSON
writer disagree about units, and both are documented on the internet.

**A failing test first.** Written before the fix, and observed to fail *for the
reason the root cause predicts* — not merely to be red. A test that passes both
before and after proves nothing about the fix; a test that fails for a different
reason than the diagnosis means the diagnosis is wrong and the fix is a
coincidence. This is also the only thing that stops the fix from being quietly
undone later: the entry says why, and the test enforces it.

If you cannot write the failing test, you do not yet understand the bug well
enough to fix it. Stop and go back to the first half of the law.

## When an entry is required

Write one, in the same change as the fix, when **any** of these is true:

- the root cause was **not** where the symptom appeared — a wrong number in a
  subtitle traced back to a units mismatch three modules away;
- the fix looks **wrong, redundant or arbitrary** to a reader who does not know
  the story: a magic constant, a re-check of something already checked, a flag
  that seems to do nothing, an `if` that guards a case that "cannot happen";
- the **obvious fix was wrong**, and the shipped one is the second or third
  attempt;
- the bug came from an **external system's real behaviour differing from its
  documentation** — an API returning 200 where it documents 401, a CLI flag that
  is silently ignored, a field whose unit is not what the schema says;
- the bug was a **data-loss or a correctness** bug, however small the diff:
  dropped words, shifted timings, a transcript exported with the wrong language
  tag, a key written somewhere it should not be;
- it took **more than about an hour** to find, whatever the eventual diff size.
  The hour was spent on the diagnosis, and the diagnosis is the artefact worth
  keeping.

## When an entry is *not* required

Do not write one for:

- a typo, a rename, a formatting change, a lint fix;
- a bug caught **before** it was committed — that is just the work;
- a change with an obvious cause and an obvious fix, where reading the diff a
  year from now tells the whole story on its own;
- a dependency bump, unless the upgrade broke something and *that* is the bug;
- a feature that was simply never implemented. Missing is not broken.

When it is genuinely borderline, write it. A short entry nobody needed costs
five minutes; a missing entry costs the next person the whole afternoon that was
already spent once.

## House rules

- **Write it the moment the fix is confirmed working**, in the same turn — not
  at the end of the week, when what you actually tried has already blurred into
  what you eventually concluded. The wrong hypotheses are the perishable part.
- **One bug, one file.** Two symptoms with one root cause are one entry; one
  symptom with two independent causes is two entries that link to each other.
- **Quote the user's words** for the symptom, verbatim, in whatever language
  they used. Their phrasing is how the next person will search for it.
- **Name the test.** File and test name, so the reader can run it.
- Add the row to the index below in the same commit.
- Never delete or rewrite an entry to make it tidier. If it turns out to be
  wrong, add a correction *to it*, dated, and say what the new measurement was.
  This log is a record, not a monument.

## Index

| # | Bug | Area | Root cause | Fixed |
| --- | --- | --- | --- | --- |
| [0001](./0001-cue-ran-past-the-end-of-the-media.md) | A subtitle cue ran past the end of the media | shared/subtitles | `resegment` was never given the media duration to clamp against | 2026-08-29 |
| [0002](./0002-upload-encoder-was-not-in-the-vendored-ffmpeg.md) | A cloud upload failed instantly with "Encoder not found" | ffmpeg | the vendored macOS ffmpeg has neither `libopus` nor `libmp3lame`, and both rungs of the fallback asked for them | 2026-08-29 |

| [0003](./0003-subtitle-cues-drew-three-lines.md) | Subtitle cues drew three lines, and ended mid-phrase | shared/subtitles | the accumulator counted characters where it had to ask whether the cue could be drawn | 2026-08-29 |
| [0004](./0004-collapsed-word-timings-made-one-millisecond-cues.md) | Cues one millisecond long, two of them sharing an interval | shared/subtitles | whisper stacks a run of words on one timestamp, and the gap pass crushed cues to `startMs + 1` rather than keep their floor | 2026-08-29 |
| [0005](./0005-a-third-line-on-the-carried-words.md) | A cue drew a third line at the shipped defaults | shared/subtitles | `flushAtBestBreak` carries words over, and the fit question from 0003 was never asked again about the carry | 2026-08-30 |
| [0006](./0006-the-chosen-model-was-never-written-down.md) | Opening a file from Finder said there was nothing to transcribe with | ui/store | `setTarget` never persisted `defaultTarget`, which is the only thing main reads when a file arrives from outside the window | 2026-08-30 |
| [0007](./0007-two-runs-under-one-job-id.md) | Try again could start a second run while the first was still dying | transcribe/queue | `retry()` and `pump()` decided on `job.status`, which goes terminal before the child process does | 2026-08-30 |

<!--
Rows go newest-last, so the numbers read in order. One line each:
| [0001](./0001-some-slug.md) | Timestamps ten times too long | engines/parakeet | `t0`/`t1` are centiseconds, not ms | 2026-09-01 |
-->
