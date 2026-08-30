# 0005 — A third line, on the words a linguistic break carried over

## Symptom

At the shipped defaults — 42 characters, 2 lines — `resegment` produced:

```
["okay, extraordinarily but",
 "Bundesausbildungsförderungsgesetz",
 "something"]
```

Three lines in a two-line cue. No word here is anywhere near the line width;
the longest is 33 characters. This is not the unavoidable case of a URL that
cannot be broken.

Fuzzing `resegment` at its default settings: **405 cues in 30 000 generated
transcripts** came out with more lines than the limit — roughly one cue in
seventy on text with long words in it.

## Root cause

[0003](./0003-subtitle-cues-drew-three-lines.md) replaced a character count
with `fitsInLines`, so the accumulator asks the question that matters — can
this cue still be *drawn* — before taking another word.

It asks once:

```ts
const wouldNotFit = !fitsInLines([...pending, word].map((w) => w.text), …);
…
else if (wouldNotFit || wouldOverrunTime) flushAtBestBreak();
…
pending.push(word);
```

`flushAtBestBreak` closes the cue at the last sentence or clause end and
**carries the remainder over** into `pending`. Then `pending.push(word)` runs
with no second question. `flushAtBestBreak` chooses where to break by language,
not by what will fit afterwards, so the carry can be long — and carry plus the
word that triggered the split can need three lines where a cue has two.

0003's fix answered half the question. This is the other half.

## The fix

Ask again after the break, and close the carried cue outright if the answer is
still no. Three lines of condition, in the same place the first question is
asked.

## Do not undo

The second check has to be *after* `flushAtBestBreak`, not folded into
`wouldNotFit`. `wouldNotFit` is computed against the cue as it stood before the
break; the carry is a different set of words, and it is the carry that is
wrong.

## Test

`test/subtitles.test.ts` — `a cue whose words were carried over by a linguistic
break`: never draws more lines than a cue has, and keeps every word in order.
Re-fuzzed after the fix: 0 violations in the same 30 000 transcripts, 0 words
lost.
