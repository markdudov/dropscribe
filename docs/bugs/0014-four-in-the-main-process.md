# 0014 — Four in the main process: a "null", a bad character, a cache, and a race

## `Deepgram could not check the key (HTTP 429). null`

`readErrorMessage` is synchronous and takes an **already-parsed body**. The
Deepgram key test passed it the `Response` object and awaited the result. A
`Response` is a non-null object, so `isRecord` accepts it, none of
`detail`/`err_msg`/`message`/`error` exist on it, and the helper returns `null`
— which the template rendered as the word.

Measured against Deepgram's own dialect
(`{"err_code":"RATE_LIMIT_EXCEEDED","err_msg":"Too many requests."}`), the user
was shown `Deepgram could not check the key (HTTP 429). null` while the sentence
that would have helped sat unread in a stream nobody consumed.

The file already has `readDeepgramError`, which reads and parses the body
properly and is used on the transcription path. The key test now uses it too,
with a written fallback when there is no usable sentence.

## "Check your internet connection" for a key with a dash in it

HTTP header values are Latin-1. A key carrying anything outside that — an en
dash where a hyphen was meant, a Cyrillic `а` that looks exactly like an `a`, a
smart quote — makes `fetch` throw a `TypeError` **while it builds the headers**,
before a socket is opened. `httpJson`'s catch cannot tell that from a dead
network, so OpenRouter reported:

> Could not reach OpenRouter. Check your internet connection.

to somebody whose connection was fine. They then check their router.

`unusableKeyCharacter` runs before the request and names the character and its
position. Verified against the running app:

```
  plain ASCII       -> OpenRouter did not recognise this key…      (the real answer)
  en dash           -> This key contains “–” at position 3…
  Cyrillic а        -> This key contains “а” at position 13…
  accented é        -> OpenRouter did not recognise this key…      (Latin-1: legal, passes through)
```

## A failed write that the app believed had succeeded

`readCipherFile` ends `cipherCache = file; return file` — it hands back the
cache itself. `setKey`'s `file.keys[id] = …` therefore landed in the cache
immediately, and `writeCipherFile`'s own `cipherCache = file` after the rename
was re-assigning the same reference and could protect nothing.

A write that failed — a full disk, a read-only directory — left the app
reporting the key as stored, and every job using it, until a restart read the
truth back off disk. `clearKey` had the mirror problem: the plaintext was
evicted and the entry deleted before the write, so a failed clear showed no key
while the ciphertext was still there, and it came back on the next launch.

Both now build the next state as a copy, so the rename in `writeCipherFile` is
the only commit point — which is what it was always meant to be.

## Remove, then the key comes back

`providers:saveKey` tests the key over the network before storing it, which
takes as long as the provider takes. A `providers:clearKey` landing inside that
window was undone: the clear removed the key and the record, then the save
returned and wrote the key it had been asked about. The user pressed Remove,
watched the row empty, and found the key back a moment later.

Each provider now has a removal counter. The save samples it before its round
trip and refuses to write if it changed, answering "That key was removed while
it was being checked, so it was not saved."

An epoch rather than a promise chain, deliberately: serialising would make
Remove wait behind a save the user has already abandoned — up to half a minute
of a button that does nothing. Last **intent** should win, not last completion.

## What was verified how

The first two were verified against the running app — the Deepgram path by
reading the code that now consumes the body, the OpenRouter one by pasting four
key shapes into the real settings panel and reading back what it said.

The credentials aliasing and the save/clear race were reproduced by the review's
own harness, which loaded the real `main.ts` and `credentials.ts` with only the
`electron` module and the network stubbed, and made the write fail with a
`chmod 0555`. Neither is reproducible from here without a live provider key that
passes `testKey`, and that is stated rather than papered over.
