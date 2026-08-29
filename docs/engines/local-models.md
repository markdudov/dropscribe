# Local models

How DropScribe runs Whisper and Parakeet on the user's own machine: what the two
binaries are, exactly how they are invoked, what comes back out of each of them,
and how the weights get onto disk in a state the engines will accept.

This is the *design* document. Its companion,
[`verification.md`](./verification.md), is the *measurement log* — every claim
below that sounds surprising is a claim that was measured there, and where the
two disagree the measurement wins. Where either disagrees with
`electron/engines/`, the code wins; read it.

---

## 1. Both engines are the same runtime

`electron/shared/models.ts` lists six models across two `EngineId`s,
`whisper-cpp` and `parakeet-cpp`. Behind those two ids are two executables —
`whisper-cli` and `parakeet-cli` — and both of them are built from the same
whisper.cpp tree at tag **b4938**, against the same ggml, with the same Metal /
CPU backend. `parakeet-cli` is not a third-party tool that happens to sit next to
whisper; since b4938 it ships *in the box*, out of the same `cmake --build`.

That single fact is what the whole local stack is arranged around:

- **one runtime** to compile, notarize on macOS and sign on Windows;
- **one model format** — GGML `.bin` — so `model-store.ts` has one download
  path, one integrity check and one delete;
- **one acceleration story**, ggml's Metal backend, configured in one place;
- **one upstream** to track for releases, CVEs and licence text;
- and therefore **no ONNX Runtime anywhere in this application**.

### sherpa-onnx would have worked, and was rejected anyway

This needs saying plainly, because a future session that discovers sherpa-onnx
and thinks "that solves Parakeet" is rediscovering an option that was already on
the table and already turned down.

sherpa-onnx v1.13.6 was downloaded, unpacked and evaluated. It genuinely
delivers: prebuilt CLI bundles for `osx-arm64`, `osx-x64` and `win-x64` — which
is more than upstream whisper.cpp offers for macOS, where nothing is published
and `.github/workflows/engines.yml` has to compile from source — plus an
official `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` model and a large fleet of
extra tools (diarization, VAD, punctuation). Nothing about it failed.

It was rejected on structure, not capability. Every line of the table above
would have become two:

| Adopting sherpa-onnx adds | The evidence |
| --- | --- |
| A second runtime to package and sign | its `lib/` carries `libonnxruntime.dylib`, `libsherpa-onnx-c-api.dylib` and `libsherpa-onnx-cxx-api.dylib` per platform, against a whisper.cpp build whose `otool -L` lists nothing but OS frameworks |
| A second model format | an encoder / decoder / joiner / tokens quartet instead of one `.bin`, so `model-store.ts` grows multi-file downloads, multi-file integrity checks and multi-file deletion |
| A second acceleration story | ONNX Runtime execution providers, configured and debugged separately from ggml's Metal backend |
| A second upstream | two release cadences, two CVE surfaces, two licence notices in `licenseNoticePath()` |

One engine family is the reason there is no ONNX Runtime in this app. That is
the whole trade, and it was made deliberately.

---

## 2. The exact invocations

Both binaries are handed a **16 kHz mono 16-bit WAV** and nothing else.
`LocalRunRequest` has no media path on purpose: by the time an engine runs,
`ffmpeg.ts` has already extracted the audio, because the dropped file is usually
a video container that neither binary can demux. `parakeet-cli` reports
`supported audio formats: flac, mp3, ogg, wav` — no MP4, no MKV, no MOV.

### whisper-cli

```
whisper-cli -m <modelPath> -f <wavPath> -oj -ojf -of <tmp base> -np -pp -t <threads> -l <lang|auto> [-tr]
```

| Flag | Why it is there |
| --- | --- |
| `-oj` | write JSON |
| `-ojf` | **full** JSON — this is what puts the `tokens` array in the file, and the per-token `p` inside it. Without it there are no word timings and no confidences |
| `-of <base>` | whisper appends `.json` itself. The base is a `randomUUID()` path in the system temp dir, never beside the media: the source may be on a read-only mount or a network share, and a failed run must not leave litter in the user's movie folder. The file is `rm -f`'d in a `finally` |
| `-np` | no banner, no per-segment echo. Progress still reaches stderr |
| `-pp` | print progress — the only progress signal this binary has |
| `-t` | threads, see below |
| `-l` | the user's language, or the literal `auto` |
| `-tr` | appended only when the job asks to translate; makes whisper decode into English instead of the spoken language |

The output is driven through a file rather than by streaming stdout. Streaming
would avoid the temp file, and it was rejected: whisper's textual stdout carries
no token probabilities and rounds its timestamps to centiseconds. The JSON is
the only place the per-token `p` and the millisecond offsets exist, and both are
what make word-level subtitles possible downstream.

`child.stdin.end()` immediately after spawn — nothing is ever written to the
child, and closing it means a build that decides to read stdin fails fast
instead of hanging the job forever.

**Threads.** `0` in settings means "choose for me": the CPU count, clamped to
8. whisper.cpp's own default is a flat 4 regardless of the machine, which leaves
an M-series laptop idle; the cap exists because past the performance-core count
the efficiency cores join in and the run gets *slower*.

**Cancellation.** `SIGTERM` on abort, escalating to `SIGKILL` after three
seconds. whisper only notices a signal between decode windows and one window of
a large model can run for several seconds — without the escalation a cancelled
job leaves a process holding 1.8 GB resident.

### parakeet-cli

```
parakeet-cli -m <modelPath> -f <wavPath> -ps -np -t <threads>
```

That is the whole command, because that is very nearly the whole binary. Its
measured option set is `-h`, `-t/--threads`, `-m/--model`, `-f/--file`,
`-ng/--no-gpu`, `-dev/--device`, `-ps/--print-segments`, `-otxt`,
`-of/--output-file` and `-np/--no-prints`. **There is no `-oj`, no
`-l/--language`, no `--translate` and no `-pp`.**

`-m` is mandatory here, not optional-with-a-default. The binary's built-in
default is `models/ggml-parakeet-tdt-0.6b-v3.bin`, resolved relative to the
*process working directory* — which for a packaged Electron app is whatever the
OS happened to hand us.

Threads here resolve to `max(1, min(8, cores - 2))` rather than Whisper's plain
`min(8, cores)`: Parakeet is fast enough that the run is over in seconds, and
leaving two cores for the UI is what keeps the window from stuttering during
them. Cancellation is a straight `SIGKILL` for the same reason — there is no
long decode window to wait politely for.

---

## 3. What whisper-cli writes, and how tokens become words

`<base>.json` has five top-level keys: `systeminfo`, `model`, `params`, `result`
and `transcription`. `result` is exactly `{"language":"en"}`. `systeminfo` is
the backend banner — worth pasting into a support ticket, worth nothing to the
parser.

Each entry of `transcription[]`:

```json
{
  "timestamps": { "from": "00:00:00,000", "to": "00:00:05,040" },
  "offsets":    { "from": 0, "to": 5040 },
  "text": " the quick brown fox jumps over the lazy dog…",
  "tokens": [
    { "text": "[_BEG_]", "offsets": { "from": 0,   "to": 0   }, "id": 50364, "p": 0.989719, "t_dtw": -1 },
    { "text": " the",    "offsets": { "from": 10,  "to": 220 }, "id": 264,   "p": 0.415889, "t_dtw": -1 },
    { "text": " quick",  "offsets": { "from": 220, "to": 580 }, "id": 1702,  "p": 0.717194, "t_dtw": -1 }
  ]
}
```

Four rules follow, and the adapter obeys all four:

- **`offsets.from` / `offsets.to` are already integer milliseconds.** Not
  centiseconds, not seconds. whisper's *C API* speaks centiseconds and half the
  reference material online describes that API; the CLI's JSON writer has
  already multiplied by 10. Parse `offsets`; never multiply it, and never
  re-parse the `timestamps` strings, which exist for humans and silently lose
  anything past 99 hours.
- **Special tokens must be dropped.** The first token of every segment is
  `[_BEG_]` with a zero-width span; `[_TT_123]` is the other common one. The
  adapter drops anything wholly wrapped in brackets, which also discards
  `[BLANK_AUDIO]` and `[MUSIC]`. That is a deliberate loss: those annotations
  carry no timing worth keeping and would otherwise be glued onto the front of
  the next real word. A segment whose *entire* text is a bracketed annotation is
  dropped too — a subtitle reading "[BLANK_AUDIO]" during a silence is worse
  than the silence it describes.
- **A token's `text` carries its own leading space, and that space is the word
  boundary.** The measured segment tokenizes `timestamps` as `" timest"` +
  `"amps"`. Joining every token and splitting the result on whitespace produces
  the right string with the wrong timings, because the alignment between a word
  and its offsets is destroyed by the join. So tokens are *accumulated*: a token
  beginning with a space starts a new word, and one that does not extends the
  current one.
- **`p` is a probability in 0..1**, per token. It is not a log-probability; do
  not exponentiate it.

Two extra boundary rules the adapter adds on top:

- A whitespace-only token has no text but still separates words, so it sets a
  pending-boundary flag consumed by the next token that does have text.
- A word is also closed when the text accumulated so far ends a sentence
  (`[.!?…。！？]` optionally followed by a closing bracket or quote), because the
  token after a full stop frequently arrives *without* the leading space that
  normally marks the boundary. The known cost is decimals: `3` + `.` + `14`
  comes out as `3.` and `14`. Requiring the next token to look like a new
  sentence would fix that and would break on every language that does not
  capitalise, so the cheap rule wins.

### A word's confidence is the MINIMUM token probability

Not the mean. This is the one arithmetic decision in the merge worth defending,
and both engines make the same one.

A word is only as trustworthy as its worst piece. Whisper tokenizes
`" transcription"` as `" trans"` + `"cription"`; if the model was confident
about the prefix and guessing at the suffix, the mean hides that behind a
comfortable-looking number. Three tokens at 1.0 and one at 0.3 average to 0.83,
which reads as "fine" — and it is precisely that word a reviewer needs to see
flagged. The minimum is 0.3, which reads as "look here". Confidence in this app
exists to direct a human's attention, so the aggregate that preserves the
warning is the correct one.

### Language, and progress

`result.language` is the language whisper actually decoded in — detected when
`-l auto` was passed, echoed back when it was not. `auto` and `und` are echoes
rather than detections and both become `null`. The transcript contract is
explicit that a language is never invented: a wrong language tag on an exported
VTT is worse than a missing one, because a player will act on it.

Progress arrives on **stderr**, as `whisper_print_progress_callback: progress =
 42%` — space-padded, and never on stdout, which carries the transcript. A
reader watching the wrong stream sees a job sit at 0% for its whole duration and
then finish, which on a 40-minute file reads as a hung app. Only forward
movement is forwarded (whisper repeats the same percentage for every decode
window), and progress lines are deliberately kept *out* of the retained stderr
tail — a run that fails after twenty minutes has thousands of them, and they
would push the one line that explains the failure out of the buffer.

---

## 4. What parakeet-cli writes: the `-ps` token stream

`parakeet-cli` has no JSON writer, so on paper it looks impoverished. It is not.
With `-ps` it prints, on **stderr**, one line per decoded token:

```
  [51] id= 7883 frame=107 dur_idx= 1 dur_val= 1 p=0.9996 plog=-15.4943 t0= 856 t1= 856 word_start=false "."
  [50] id= 4128 frame=105 dur_idx= 2 dur_val= 2 p=1.0000 plog=-20.8481 t0= 840 t1= 856 word_start=true "▁word"
```

That is richer than the human-readable `[00:00:00.000 --> 00:00:05.040]  text`
segment form, and it is what the adapter parses. The columns are space-padded to
different widths depending on each number's magnitude, so the regex treats every
gap as `\s+` and captures every value rather than slicing by position. stdout,
meanwhile, carries the plain transcript on one line — used only as a fallback.

Four properties of that stream, each measured, each load-bearing:

- **`t0` and `t1` are CENTISECONDS.** Not milliseconds, not seconds. The last
  token of an 8.778 s recording reported `t1= 856`. Multiply by 10 exactly once,
  at the adapter boundary, and everything downstream is integer milliseconds.
- **`word_start` is authoritative.** Do not infer word boundaries from the `▁`
  marker, and do not infer them from spaces — a continuation token like `"cri"`
  has neither. `word_start=true` opens a word; every token after it appends
  until the next one.
- **`▁` (U+2581) is SentencePiece's word-start marker, not a character of the
  word.** It is stripped and replaced with nothing — the space between words is
  implied by `word_start`, so re-inserting one would double it.
- **Punctuation is its own token**, with `word_start=false` and `t0 === t1`.
  Because it is not a word start it attaches to the word before it, which is
  what stops a subtitle cue from ending on a lone full stop.

Word confidence is the minimum `p` across the word's tokens, for the same reason
as Whisper's — see above.

**Segments are derived, not reported.** Parakeet emits no segmentation of its
own, so the adapter groups words on a silence of 700 ms or more, and force-breaks
at 15 s so a monologue still comes apart into readable units. These are *not*
subtitle cues: `resegment()` in `shared/subtitles.ts` builds those later against
the user's line-length and reading-speed settings. What this produces is the
utterance-sized unit the transcript model expects, and the unit a reader sees in
the TXT and Markdown exports.

**Progress is invented, and capped.** There is no progress output of any kind,
so the bar is driven by elapsed time against an assumed real-time factor — 20×
on macOS with Metal, 6× elsewhere — and clamped to 95 %. A bar sitting at 100 %
while the process still works reads as a hang; one that jumps backwards reads as
a failure. Both are worse than a bar that stops short and then completes.

**Fallback.** If `-ps` yields no parseable tokens at all — an older build, or an
upstream change — the plain transcript on stdout becomes a single segment
spanning the whole file. Losing the timings is bad; losing the transcription
would be worse.

---

## 5. Parakeet has no language flag and no translate mode

There is no `-l` and no `--translate` in `parakeet-cli`'s option set. That is
not a gap in the measurement; that is the complete list.

It is also not a defect. Parakeet TDT 0.6B v3 is multilingual across a fixed
set of 25 European languages and performs its own language identification, and
it is transcribe-only — there is no translation task in the model at all.

So the adapter **ignores `request.language` and `request.translate`**. Silently
ignoring a flag is normally a bug, and here it is the honest behaviour, because
the alternative — failing a queued job because a *global* setting says
"translate" — punishes the user for a model capability they never chose. The UI
disables both toggles while a Parakeet model is selected, so the ignored value
is never one the user set with this engine in mind. And `Transcript.language`
comes back `null` rather than guessed from the text: a wrong flag beside a good
transcript is worse than no flag.

The 25 languages are enumerated in `LOCAL_MODELS[].languages` for the Parakeet
entries (`null` for every Whisper entry, which will attempt any of 99). That
list is what lets the UI warn *before* a job produces nonsense on a language the
model was never trained on.

---

## 6. Chunking is for Whisper, and not for Parakeet

`electron/engines/chunking.ts` splits a long recording into ≤30-minute pieces
that each repeat the last 5 s of their predecessor, and stitches the results
back into absolute time. Two things make it necessary, and neither is disk
space:

- **Whisper degrades with length.** It is an encoder-decoder with a 30 s
  attention window and an autoregressive text decoder conditioned on its own
  previous output. Over an hour that conditioning drifts: timestamps slide late,
  and over music or a long silence the decoder falls into a repetition loop and
  emits the same sentence until the audio runs out. Bounding the input bounds
  the blast radius.
- **Cloud providers cap the upload**, so a two-hour film through a twenty-minute
  endpoint has to go in pieces regardless.

**Parakeet is deliberately not chunked.** It is a TDT transducer: it walks the
encoder's frames strictly in order and emits tokens per frame, with no
cross-attention over a decoded prefix and no fixed window to slide. A ten-second
file and a two-hour file decode by exactly the same mechanism, and nothing about
it drifts with length. Chunking it would buy nothing and pay for it in boundary
artefacts.

The overlap exists because a cut is placed by the clock, not by the speech, so
it lands mid-word about as often as not — and a word cut in half is dropped from
*both* sides. Making each chunk start early means the word is whole inside at
least one of them, and `stitch()` removes the duplicates the overlap creates.
Losing text is unrecoverable; duplicated text is a de-duplication problem, and
the design trades the first for the second on purpose. At a seam the **earlier**
chunk's decode wins, because it arrived with the preceding minute in its encoder
window while the later chunk started there cold.

---

## 7. Where the models live, and how they are verified

Weights land in `<userData>/models/`, named by `LocalModel.fileName` — the same
directory `AppInfo.modelsDir` reports and the Settings panel offers to reveal
(hence `modelsDir()` creates it on *read*, not only on write; revealing a
directory that does not exist yet is a dead end the user cannot fix).

Every catalogue entry pins an exact `bytes` and an exact lowercase-hex
`sha256`, both taken from **Hugging Face's own LFS metadata**, not from a file
we downloaded. That distinction is the whole point: a hash computed from bytes
you already trusted proves only that your disk works. Taken from the publisher's
metadata it detects a silently re-uploaded model, which is the case the check
exists for. `scripts/verify-model-catalogue.mjs` re-reads the same endpoint in
CI so drift is caught there rather than by a user with a half-working model.

The download manager (`electron/services/model-store.ts`) is built around one
fact: these files are 550 MB to 3 GB, so a download is not an event the user
waits out. It is something they interrupt, resume tomorrow, and run over a hotel
connection that drops halfway.

| Behaviour | Why |
| --- | --- |
| Bytes land in `<fileName>.part`, renamed into place only after the hash matches | a file bearing the catalogue's name is *always* a file the engine can load |
| **The SHA-256 is computed from the bytes as they stream past** | hashing a 3 GB file afterwards is a second full read — about a minute on a spinning disk, and pure waste when the bytes were already in hand |
| An existing `.part` **resumes with an HTTP `Range: bytes=<n>-` request** | the prefix is re-read from local disk to bring the `Hash` back into state (a `Hash` cannot be serialized between runs). Reading 2 GB of disk to avoid re-downloading 2 GB over the network is a trade worth making every time |
| A **200** in reply to a Range request resets the download | a 200 means the server ignored the Range and is sending the whole file. Appending that to the prefix yields a file of the right *length* made of the wrong *bytes* — which the SHA would catch an hour later. Pay for the restart now |
| A **416** drops the `.part` and restarts once | "Range Not Satisfiable" means the remote file is now shorter than our offset, so the partial belongs to a file that no longer exists |
| A `Content-Length` / `Content-Range` total that disagrees with the catalogue fails in the first second | the upstream file was replaced; the SHA is going to fail anyway, and it is kinder to say so before writing gigabytes |
| A short read leaves the `.part` and says "it will resume" | a dropped connection is not corruption |
| A **hash mismatch deletes** the `.part` | unlike a short read, wrong bytes can only ever re-produce the same wrong file |
| **Cancel keeps the `.part`** | "cancel" from someone holding 2.4 GB of a 3 GB file means "not right now", not "throw it away". Deleting it here is the tidier-looking choice and the one that makes people stop trusting a download manager |
| Delete removes **both** the file and any `.part` | otherwise "Delete" frees a fraction of the space the user expected, and a later download silently resumes from bytes they thought they had discarded |
| A second Download click joins the download in flight | rather than opening a second socket onto the same `.part` and interleaving two writers into one file |
| Progress is emitted at most every 250 ms | a 64 KB chunk over a fast link is hundreds of callbacks a second, each an IPC message and a React render |

Redirects are followed explicitly (`redirect: 'follow'`), even though that is
`fetch`'s default, because Hugging Face `resolve` URLs are a 302 to a CDN whose
host changes — and a future refactor to `node:https`, which does *not* follow
redirects, would otherwise download a few hundred bytes of redirect body and
hash them.

`isInstalled()` is "present **and** exactly the catalogue's byte count", checked
on every listing for the price of one `stat`. Existence alone is not enough: the
common failure is an interrupted copy or a full disk, which leaves a short file
that whisper.cpp opens, reads a truncated header from, and dies on with an error
saying nothing about the download. It is not a substitute for the SHA — that
runs once, at download time — but it is the check that can afford to run often.

> **Known discrepancy, and it matters here.** `verification.md` §7 records that
> the two Parakeet entries in `models.ts` carry **correct hashes and wrong byte
> counts** (`669_142_048` against upstream's `668_757_119`, and `1_256_128_672`
> against `1_255_897_319`). Because `isInstalled()` compares sizes, a
> byte-perfect Parakeet download will not register as installed. The hashes are
> the authority; the size fields are the thing to fix. Do **not** "fix" it the
> other way by re-deriving hashes from a local file — see the paragraph above
> for why that check would then be worthless.

---

## 8. The GGUF trap, which cost a download

The community file `handy-computer/parakeet-tdt-0.6b-v3-gguf` (739 508 576
bytes) downloads cleanly and hashes correctly. It is a perfectly valid file.
`parakeet-cli` refuses it:

```
parakeet_model_load: invalid model data (bad magic)
parakeet_init_with_params_no_state: failed to load model
error: failed to load Parakeet model from 'parakeet-q8.gguf'
```

The first four bytes say why:

```
$ head -c 4 parakeet-q8.gguf     | xxd   # 4747 5546   "GGUF"
$ head -c 4 ggml-parakeet-q8.bin | xxd   # 6c6d 6767   "ggml", little-endian
```

Two container formats for the same weights, aimed at two different runtimes.
whisper.cpp's `parakeet-cli` reads the **GGML** one, produced by
`models/convert-parakeet-to-ggml.py` in the whisper.cpp tree and published — and
this is the trap — at a repository named **`ggml-org/parakeet-GGUF`**, whose
usable files all end in `.bin`. A repo called `-GGUF` full of GGML files. That
naming is upstream's, not ours, and it is exactly the thing that makes the
catalogue's `.bin` URLs look like a mistake worth "modernizing".

**Do not repoint the catalogue at the `.gguf` files because the extension looks
newer.** Note also that the sizes are close enough to pass a glance: the wrong
F16 GGUF is 1 255 869 856 bytes against the right F16 `.bin`'s 1 255 897 319, a
0.002 % difference. Eyeballing the size is not a check. The magic number is:

```bash
head -c 4 some-model.bin | xxd   # "ggml" = whisper.cpp;  "GGUF" = wrong runtime
```
