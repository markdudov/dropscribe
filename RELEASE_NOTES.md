# DropScribe 0.1.2

Drop an audio or video file on the window and get a transcript back. DropScribe
runs Whisper large-v3, Whisper large-v3-turbo and NVIDIA's Parakeet TDT 0.6B v3
locally — entirely offline, GPU-accelerated on Apple silicon — or sends the file
to DeepInfra, Deepgram, ElevenLabs or OpenRouter using your own API key, which
is kept in the operating system's credential store rather than in a settings
file. Transcripts export as TXT, Markdown, SRT, WebVTT, JSON or CSV; the
subtitle formats are rebuilt to real subtitling limits instead of dumping the
recognizer's raw segments on screen. Files queue up, report their progress
individually, and can be cancelled at any point.

macOS and Windows. MIT licensed.

## macOS is signed and notarized; Windows is not

The macOS builds carry an Apple Developer ID signature and a notarization ticket
from Apple, so the dmg opens with a double-click like anything else you install.

The Windows installer is a different story: an Authenticode certificate is a
separate purchase and this project has not made it yet. SmartScreen will show
the blue "Windows protected your PC" panel with no publisher name — click
**More info**, then **Run anyway**. That warning is about the missing signature
rather than about anything the installer was caught doing, which is also exactly
what a bad actor would write here; the source is public, so if you would rather
not trust a binary from a stranger, you can build it yourself.

Reputation accrues per binary on Windows, so this does not improve as the
project ages — every release starts from zero until there is a certificate.

## The first transcription downloads a model

Only the engines ship inside the app. Model weights are downloaded from Hugging
Face the first time you use a given model, so the first run of each one costs a
download — after that it is on disk and everything happens offline. Downloads
report progress and can be cancelled.

| Model | Download |
| --- | --- |
| Whisper large-v3-turbo | 1.5 GB |
| Whisper large-v3-turbo, 5-bit quantized | 547 MB |
| Whisper large-v3 | 2.9 GB |
| Whisper large-v3, 5-bit quantized | 1.0 GB |
| Parakeet TDT 0.6B v3 | 638 MB |
| Parakeet TDT 0.6B v3, F16 | 1.2 GB |

If you are choosing blind: start with **Whisper large-v3-turbo**. It is close to
large-v3 in accuracy at a fraction of the running time. The quantized builds
trade a little accuracy for roughly a third of the disk and memory, and are the
right pick on a machine with 8 GB of RAM. Parakeet is faster still, but only
knows 25 European languages, where Whisper will attempt any of 99.

The cloud providers need no download at all — just a key.

## Supporting the project

DropScribe is free and MIT licensed and stays that way — no paid tier, nothing
held back, nothing phoning home. Keeping the macOS builds signed and notarized
costs money, though, and so does the time. If it saves you work and you would
like to chip in: [PayPal](https://www.paypal.com/paypalme/markdudov) or
[Revolut](https://revolut.me/markdudov). Entirely optional — a good bug report
is worth as much.

## What 0.1.2 fixes

Everything below was found by reviewing the app rather than by anyone hitting
it, and every one of them is written up in full under `docs/bugs/`.

**Chinese, Japanese and Thai now get usable subtitles at all.** Those scripts
put no spaces between words, and the token merge was joining every character
between two full stops into a single "word" — so a sentence became one cue on
one line, at twice the configured width, that vanished six seconds before the
speaker did. Measured on 83 characters of speech: one cue before, two properly
laid-out ones after.

**Long cloud jobs no longer fail after the provider has already charged you.**
Node's HTTP client applies a five-minute ceiling on how long a provider may take
to answer, which nothing in the app asked for and one comment in it explicitly
disclaimed. A provider that transcribes a long recording and answers after five
minutes had its connection destroyed, and you were told to check your internet —
after the work was done and billed, and **Try again** billed it again. Requests
now go through a transport with no such ceiling.

**Opening a file from Finder works.** Downloading a model and choosing it never
wrote that choice down, so double-clicking a video — or Open With, or a file on
the command line — met a dialog saying DropScribe had nothing to transcribe with
and telling you to download a model you already had.

**Setting six lines per subtitle no longer freezes the app.** The line-balancing
search enumerated every possible way of splitting a cue and only then checked
whether the lines fitted. At the default two lines that is instant; at six it
was 842 ms for a single cue, and minutes of an unresponsive window for a long
recording.

**Subtitle timing is honest again.** Repetitive audio makes Whisper stack a run
of words on one instant, and cues built from those came out one millisecond
long, in pairs sharing an interval. A cue cut short by the end of the file now
starts earlier instead of flashing. And a cue can no longer draw a third line.

**Also:** a transcript CSV opens correctly in Excel instead of as mojibake; the
folder for transcripts can only be set through the picker; the auto-written
subtitle file now uses the settings you have rather than the ones you had when
the job started; an export that could not be written says so instead of failing
silently; a number typed in Settings survives pressing Escape; **Refresh models**
refreshes; a key with a stray dash in it says so rather than blaming your
internet; **Try again** is greyed out on a file with no audio track; Parakeet no
longer opens a console window on Windows; and an interrupted job stops leaving
megabytes in the system temp folder that nothing ever cleared.

Nothing about how the app is used has changed, and no setting was renamed or
removed.

## What 0.1.2 is

An early public release. It does not update itself, and it has not yet been run
on every combination of hardware and file that exists. There will be rough
edges, and finding them is the point of putting it out.

To get a new version, come back to the Releases page and download it; nothing in
the app will tell you one exists.

Problems, crashes, a file that transcribes badly, a format that exports wrong:
please open an issue at
<https://github.com/markdudov/dropscribe/issues>. The file's format and
roughly how long it is, the model or provider you ran it through, and your OS
version are usually enough to reproduce it — no need to attach the media itself.
