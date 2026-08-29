# 0002 — The upload encoder was not in the vendored ffmpeg

## Symptom

A cloud job failed the instant it started. The queue row went to `Compressing`,
stayed at **0:00**, and turned red with:

```
DropScribe could not compress "<file>.mp4". ffmpeg said: Error opening output
files: Encoder not found
```

macOS, arm64. A 5:16 file. DeepInfra selected as the provider. Reproducible on
every cloud job and every input, including files that had transcribed cleanly
through a local model minutes earlier. Nothing about the input mattered — the
run never got as far as reading it.

## Root cause

`compressForUpload` in `electron/ffmpeg.ts` asked for `-c:a libopus` and, on any
encoder-shaped complaint, retried with `-c:a libmp3lame`. **The vendored macOS
ffmpeg has neither.**

It is not a Homebrew build and not `ffmpeg-static`. It is the author's own build,
made for SilenceTrimmer — a video editor — and configured for exactly the three
things a video editor needs:

```
--enable-libx264 --enable-libx265 --enable-libzimg
```

and nothing else. No `--enable-libopus`, no `--enable-libmp3lame`, no
`--enable-libvorbis`. It has **no external audio encoder at all**.

Measured directly against the binary that ships, on 2026-08-29:

```bash
./vendor/bin/darwin-arm64/ffmpeg -hide_banner -encoders | grep -E ' (libopus|libmp3lame|libvorbis|aac|flac|opus) '
```

| encoder | macOS build (`n7.1.5`, ours) | Windows build (BtbN) |
| --- | --- | --- |
| `libopus`     | **MISSING** | present |
| `libmp3lame`  | **MISSING** | present |
| `libvorbis`   | **MISSING** | present |
| `aac` (native)  | present | present |
| `flac` (native) | present | present |
| `opus` (native, non-`lib`) | present, and unusable — see **Do not undo** | present |

So the fallback chain had two rungs and **both were missing**. ffmpeg reports
that as `Error opening output files: Encoder not found`, which reads like a code
bug and was a packaging assumption: the module was written against an ffmpeg
nobody had checked we ship.

## Why it was hard / what was wrong first

**It never reproduced on Windows.** The BtbN build genuinely does carry
`--enable-libopus --enable-libmp3lame --enable-libvorbis` — that is not folklore,
the configure line was read straight out of `ffmpeg.exe` and is quoted in full in
[../engines/verification.md](../engines/verification.md). Cloud uploads on
Windows took the first branch, produced Opus at 12 kbps, and had never once
touched the fallback. Two platforms, one hard-coded encoder, and only one of them
ever complained.

**Local transcription was unaffected throughout**, which is worse than it sounds.
`extractWav16k` uses `-c:a pcm_s16le`, which every ffmpeg build in existence has.
So the app spawned the vendored ffmpeg constantly, successfully, minutes before
each failure. "ffmpeg works" was simultaneously true and completely misleading,
and it sent the search at the cloud path first — the provider, the upload, the
temp file, the abort signal — rather than at the binary that had just been
working.

The comment in `compressForUpload` also argued, reasonably, that detecting the
encoder by *trying* beats parsing `ffmpeg -encoders`, because the real conversion
answers the question for free on the happy path. That is true when the fallback
exists. It stops being true when neither rung of the ladder does, and the
"detection" turns into two doomed processes and an error message about output
files.

**The first instinct was to hard-code `aac`.** Every build has it; the failure
would have gone away that afternoon. It is wrong for the other platform: on
Windows, where `libopus` is right there, aac at 32 kbps is roughly **three times**
the bytes of Opus at 12 kbps, and file size on this path is entirely the user's
upload time. That fix would have moved the bug from "macOS is broken" to "Windows
is quietly three times slower to upload a film", which is the kind of regression
nobody files.

## The fix

`compressForUpload` no longer names an encoder in advance. `availableEncoders()`
runs `ffmpeg -encoders` once and caches the promise at module scope for the life
of the process — the answer is a property of the *build*, so a second run could
only ever return the same set — and `chooseUploadEncoding()` picks the first row
of `UPLOAD_ENCODINGS` that the build actually reports. The table is ranked by
bytes on the wire for 16 kHz mono speech:

| | encoder | bitrate | container |
| --- | --- | --- | --- |
| 1 | `libopus` | 12k | `.ogg` |
| 2 | `libvorbis` | 24k | `.ogg` |
| 3 | `libmp3lame` | 32k | `.mp3` |
| 4 | `aac` | 32k | `.m4a` |

The last row is what makes the table total in practice: `aac` is ffmpeg's own
native encoder and is in every configuration there is. Windows keeps taking row
one exactly as before; macOS now lands on row four and produces a file instead of
an error.

Because the container is no longer known before the encoder is, the signature
changed with it: `compressForUpload` takes an `outBase` **without** an extension
and returns `{ path, encoding }`. That closes a second, quieter defect the old
code had documented and lived with — on the fallback path it wrote MP3 bytes into
whatever name the caller had chosen, `.ogg` included, and relied on every
provider sniffing content rather than trusting the name.

Measured on 171.2 s of 16 kHz mono speech, and extrapolated to a two-hour film:

| encoding | bytes | effective kbps | 2-hour film |
| --- | --- | --- | --- |
| `aac` 32k, `.m4a`  | 710 269 | 33.2 | **28.5 MB** |
| `aac` 24k, `.m4a`  | 533 245 | 24.9 | 21.4 MB |
| `flac`             | 3 436 590 | 160.6 | **137.8 MB** |

`libopus` at 12 kbps, where it is available, is about a third of `aac` 32k.

`flac` was measured and is **deliberately not in the table**, even though every
build has it and it would have made the ranking look more complete. At 137.8 MB
for a two-hour film it is roughly five times the aac fallback, and it buys
nothing: these recognizers downsample to 16 kHz mono on arrival, so a lossless
upload spends the user's whole afternoon transmitting detail that is discarded
before a single word is decoded.

The one extra process this costs on the happy path is the price of being right on
both platforms, and it is paid once per app run rather than once per job.

## Why this fix and not the obvious one

Hard-coding `aac` fixes macOS today and wastes about three times the bandwidth on
Windows, where `libopus` is present and better. Hard-coding `libopus` is what we
had. Any hard-coded encoder is wrong on one of the two platforms, because **the
two platforms genuinely do not ship the same ffmpeg** and never have.

The ranking also **self-heals**. The day the macOS binaries in
`markdudov/silencetrimmer-media-binaries` are rebuilt with `--enable-libopus`,
every platform starts taking the first branch — no code change, no version check,
no second table to keep in sync with the manifest. A hard-coded `aac` would still
be there, still shipping three times the bytes, long after the reason for it had
gone away.

## Test

`test/node/upload-encoder.test.ts`. Two of its cases are the regression guard,
and they are the ones to keep:

    UPLOAD_ENCODINGS — "never offers the native opus encoder"
    chooseUploadEncoding — "does not reach for the native opus that build does have"

The first asserts the ranked table contains no row whose codec is `opus`. The
second feeds the selector the **measured** macOS set — `aac`, `flac`, `opus` and
`vorbis` present, no `lib*` audio encoder anywhere — first asserting that the set
really does contain `opus`, so the case cannot pass by accident on a set that
never offered the wrong answer, and then that the chosen codec is not `opus`.
Its neighbour, `"takes aac on a build with only the native encoders"`, pins the
positive half: that same set must resolve to `aac` in an `.m4a`.

`"takes libopus when the build has it"` covers the Windows listing, so the fix
cannot degrade into "pick aac everywhere" wearing a table, and
`"prefers each row over the ones below it"` pins the ranking itself rather than
inferring it from those two endpoints.

Without the fix none of this exists to run: `compressForUpload` asked for
`libopus`, retried `libmp3lame`, and on the macOS set found neither — ending in
the exact `Encoder not found` string quoted under **Symptom**.

## Do not undo

> The native `opus` encoder is in **every** ffmpeg build, including ours, and
> looks like the obvious thing to put at the top of the ranked table. It is not
> usable here. Adding it restores this bug for every macOS user.

Two separate gates, both measured against `vendor/bin/darwin-arm64/ffmpeg` on
2026-08-29. It is flagged experimental and refuses to open at all without
`-strict -2`:

```
The encoder 'opus' is experimental but experimental codecs are not enabled,
add '-strict -2' if you want to use it.
```

and with `-strict -2` it then rejects the sample rate this whole path is built
around:

```
Specified sample rate 16000 is not supported by the opus encoder
Supported sample rates:
  48000
```

`libopus` accepts 16 kHz and resamples internally; the native encoder does not,
and the only way to feed it is to drop `-ar 16000` and upload 48 kHz audio —
three times the samples to send a recognizer that downsamples to 16 kHz on
arrival. `opus` and `libopus` are different encoders that share a name prefix.
Only the `lib` one belongs in the table.


---

## Correction, same day: the fix had a consequence of its own

An adversarial review of this fix found that it traded one wrong cross-module
assumption for another, and the review was right.

The reasoning above says cloud APIs charge by duration and decode server-side,
so bytes only cost upload time. **OpenRouter enforces a hard 17 MiB ceiling**,
checked in `electron/providers/openrouter.ts` before any network call. AAC at the
table's 32 kbps puts a two-hour film at 30,484,315 bytes — measured on a real
two-hour source, encoded by the shipped binary. So the encoder fix, on its own,
took OpenRouter from working to failing for anything over about seventy minutes,
on exactly the platform this entry is about.

Worse in kind than in effect: the number was known in one module and assumed in
another, which is the same species of defect as the original bug. That adapter's
own comment still read "In practice this never bites … 17 MiB is roughly three
and a half hours of speech", describing an Opus encode that macOS never performs.

**The second fix.** `maxUploadBytes` moved onto `ProviderDescriptor` in
`electron/shared/providers.ts`, so the ceiling is declared once and read by both
the adapter that enforces it and the queue that has to encode under it.
`compressForUpload` gained an optional `maxBytes`, and `fitBitrate` lowers the
rate to fit — never above the encoding's own figure, never below 16 kbps, with
12 % headroom for container overhead. Measured after the change:

| audio | chosen bitrate | predicted size | verdict |
| --- | --- | --- | --- |
| 60 min | 32k (unchanged) | 13.7 MB | fits |
| 90 min | 23k | 14.8 MB | fits |
| 120 min | 17k | 14.6 MB | fits — was 30 MB and rejected |
| 180 min | 16k (floor) | 20.6 MB | over the cap; OpenRouter's own message is correct and clear |

Verified by bundling the real `compressForUpload` and running it: a 400 KB
ceiling on the 171 s fixture produced 358,575 bytes, still 16 kHz mono AAC by
ffprobe.

**Do not undo (second):** the floor exists so the app stops shaving quality at
the point where a transcript would start losing consonants. Above the floor,
fitting beats refusing — a slightly thinner encode that arrives beats a perfect
one the provider will not accept. Below it, the file is genuinely too long for
that provider and its own error says so better than a whisper-thin encode that
arrives and transcribes badly.
