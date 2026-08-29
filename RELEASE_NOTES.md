# DropScribe 0.1.1

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

## What 0.1.1 is

An early public release. It does not update itself, and it has not yet been run
on every combination of hardware and file that exists. There will be rough
edges, and finding them is the point of putting it out.

0.1.1 changes nothing about how the app transcribes. What it changes is that the
macOS builds are now signed and notarized, so they open without a fight, and
there is a way to support the project if you want to.

To get a new version, come back to the Releases page and download it; nothing in
the app will tell you one exists.

Problems, crashes, a file that transcribes badly, a format that exports wrong:
please open an issue at
<https://github.com/markdudov/dropscribe/issues>. The file's format and
roughly how long it is, the model or provider you ran it through, and your OS
version are usually enough to reproduce it — no need to attach the media itself.
