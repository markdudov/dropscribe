# NNNN — <one-line title, the bug not the fix>

<!--
Copy to `NNNN-slug.md`, fill in every section, delete these comments.
All seven sections are required. A section with nothing to say means the bug is
not understood yet — go back to the Iron Law in ./README.md, not to this file.

Area: <e.g. engines/whisper, providers/deepgram, transcribe/queue, ui/settings>
Fixed: <YYYY-MM-DD>       Commit: <sha, once you have one>
-->

## Symptom

What the user actually saw and said, in their words, quoted. Not the diagnosis
and not a tidied-up restatement — their phrasing is how the next person will
search for this file. Then, underneath, the observable facts: which file, which
model or provider, which platform, and what "wrong" looked like concretely
(a number, a timestamp, an error string, a screenshot description).

If it was intermittent, say how often. If it only happened on one machine or one
file, say which and what was different about it.

## Root cause

The mechanism, stated plainly, and the evidence that it *is* the mechanism.

Not "it seems to be X". Not "changing X made it go away". What was measured,
what the measurement showed, and why that measurement is conclusive — the
command that was run and its output, the value that was printed, the response
body that was read, the byte that was inspected.

If the cause sits in an external system, record the external behaviour here as a
fact with its date, because it can change: which endpoint, which version, what
it actually returned as opposed to what it documents.

## Why it was hard / what was wrong first

**The most valuable section in the file. Do not skip it.**

Every hypothesis that was pursued and disproved, and what disproved it. What
made the real cause hard to see — a misleading error message, a symptom that
appeared in a module far from the fault, a piece of documentation that says the
opposite of what the system does, a coincidence that made a wrong theory look
right for a while.

This is what stops the next person from spending the same afternoon. Write the
dead ends even when they now look foolish; they did not look foolish at the
time, which is exactly the point.

## The fix

What changed, in which files, and how the change addresses the mechanism named
above — not a restatement of the diff, which git already has. One paragraph is
usually right. Note anything the fix deliberately does *not* address and why
(a related failure left alone, a broader refactor not attempted here).

## Why this fix and not the obvious one

The fix that any reasonable person would reach for first, and the specific
reason it is wrong here. If the obvious fix *was* what shipped, say so in one
line — but if it was not, this section is what stops someone from "simplifying"
the shipped fix back into the broken one.

Include the cost of the chosen approach honestly: what it makes worse, slower,
or uglier, and why that price was worth paying.

## Test

The test that fails without the fix and passes with it. Name the file and the
test:

    <path/to/file.test.ts> — "<the test name>"

State what it asserts and, precisely, **how it fails without the fix** — the
expected value against the actual one. A test that merely goes red is not
evidence; a test that goes red *with the number the root cause predicts* is.

If the bug genuinely cannot be covered by an automated test, say why in full,
and give the exact manual reproduction steps instead — command, input file,
expected observation. That is a last resort and needs a reason, not a shrug.

## Do not undo

The specific line, constant, flag, ordering or guard that must survive, and the
one-sentence version of what breaks if it is removed. Written for someone who
finds it during a cleanup, thinks it looks redundant, and has thirty seconds to
decide.

Be concrete and quotable:

> `t0`/`t1` from `parakeet-cli` are centiseconds. The `* 10` is not a bug and is
> not a stray scaling factor. Removing it makes every subtitle ten times too
> short.
