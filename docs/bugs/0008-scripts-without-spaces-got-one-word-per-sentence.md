# 0008 — Chinese, Japanese and Thai got one "word" per sentence

## Symptom

83 Han characters covering 13.3 seconds of speech — an ordinary spoken clause
chain — came out of the subtitle layer as:

```
  words:            1
  cues:             1
  longest line:     83 characters   (limit 42)
  cue duration:     7000 ms         (clamped)
  speech uncovered: 6.3 s
```

One line at double the configured width, and the subtitle vanishing six seconds
before the speaker stopped.

## Root cause

`wordsFromTokens` in `electron/engines/whisper-json.ts` decides where one word
ends and the next begins from three signals: a leading space on the token, a
whitespace-only token, or sentence-ending punctuation in what came before.

Chinese, Japanese, Thai, Lao, Khmer and Burmese offer none of the three between
words. So every token between two full stops merged into a single `Word`.

Everything downstream is built on words. `resegment` breaks between words,
`layoutLines` balances lines by words, the reading-speed and duration rules are
enforced by moving word boundaries. One word means there is nothing to break,
nothing to balance and no duration to honour — the subtitle layer is inert for
roughly a fifth of the languages the app claims to handle, and the export is a
single unreadable block.

## The fix

A token whose first character is in one of those scripts starts a new word, and
so does a token that follows one. Two lines of condition.

This is not linguistic word segmentation — doing that properly needs a
dictionary per language. It is per-token granularity, which is what the
tokenizer already produced and the merge was throwing away, and it lets a cue
break between characters, which is what CJK subtitling does anyway.

## Measured after

Same 83 characters, same timings:

```
  words:            83
  cues:             2
  longest line:     41 characters   (limit 42)
  lines per cue:    2, 2            (max 2)
  cue durations:    6640, 6560 ms   (max 7000)
  speech uncovered: 0 ms
  text preserved:   true
```

## Do not undo

The condition tests BOTH sides — the incoming token's first character and the
pending word's last. A Han character must not be glued to the one before it,
and a Latin word must not be glued onto a Han character either.

Spaced scripts are unaffected, and there is a test that pins exactly that: the
same English tokens must still produce the same words.

## Test

`test/whisper-json.test.ts` — `tokens in a script that does not space its
words`: Chinese and Japanese produce more than one word, English is unchanged,
and every character survives in order.
