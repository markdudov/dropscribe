# DropScribe

**Drop an audio or video file on the window and get a transcript back.** A
desktop app for macOS and Windows that can run entirely on your own machine —
no account, no subscription, and nothing leaving the computer.

<!--
  SCREENSHOT GOES HERE.

  Drop the file at `docs/screenshot.png` (the main window with a couple of
  finished jobs in the queue, light theme, 1600×1000 or larger), then delete
  this comment and uncomment the line below:

  ![The DropScribe window with a finished queue](docs/screenshot.png)
-->

---

## What DropScribe is

Most speech-to-text tools are either a web service you upload your file to and
hope for the best, or a command line you have to assemble yourself. DropScribe
is the third option: an ordinary desktop app where you drag the files in, watch
the queue move, and export the result in whatever format you actually needed.

It works in two ways, and you can switch between them at any time:

- **locally** — Whisper or Parakeet run on your machine, the file is uploaded
  nowhere, and no internet connection is needed (except once, to download the
  model);
- **in the cloud with your own key** — when you want speed, diarization
  (splitting by speaker), or a specific model only a provider offers. You pay
  that provider directly; DropScribe is not in the middle and takes no cut.

It accepts audio and video. Internally everything goes through a bundled ffmpeg
that produces a 16 kHz mono WAV — which is why the same MKV, MP4, MP3, M4A or
WAV behaves identically no matter what codec it was recorded with.

## Features

- Drag and drop many files at once; a queue with progress, cancellation and
  retry for each job individually.
- Six local models behind two engines (Whisper and Parakeet), chosen according
  to whether you need speed, accuracy, or a small memory footprint.
- **Fully offline local transcription.** Whisper large-v3, Whisper
  large-v3-turbo and NVIDIA Parakeet TDT 0.6B v3 all run through vendored
  whisper.cpp binaries, with Metal acceleration on macOS. Once the weights are
  on disk, a local job makes no outbound request of any kind.
- Cloud providers with your own key: DeepInfra, Deepgram, ElevenLabs and
  OpenRouter. Each key gets a **Test connection** button, and the per-provider
  model picker appears only after the key validates — a key that fails the test
  is never stored.
- Export to TXT, Markdown, SRT, WebVTT, JSON and CSV, from the row of the job
  it belongs to. Exporting opens the containing folder, so you can see where the
  file went.
- Subtitles are segmented by the professional rules rather than chopped
  mechanically at sentence boundaries.
- Automatic language detection; Whisper covers around 99 languages, Parakeet 25
  European ones, Bulgarian included.
- Cloud keys are encrypted through Electron's `safeStorage` and kept in
  **Keychain** on macOS and **Credential Manager** on Windows, never in a config
  file in the clear.

## Install

Download the latest version from
[Releases](https://github.com/markdudov/dropscribe/releases) — `.dmg` for macOS,
`.exe` for Windows.

**macOS builds are signed with an Apple Developer ID and notarized by Apple**,
so the dmg opens with a double-click like anything else you install.

**The Windows installer is not signed.** An Authenticode certificate is a
separate purchase this project has not made, so SmartScreen shows the blue
"Windows protected your PC" panel with no publisher name: **More info → Run
anyway**. Reputation on Windows accrues per binary, so this does not improve as
the project ages — every release starts from zero until there is a certificate.

If that is not acceptable to you — entirely fair — build from source (below).
The result is the same app.

## Local models

Models are not distributed with the app. They are downloaded from Hugging Face
the first time you use one and checked by SHA-256 against a hash recorded in the
code — a corrupted or substituted weight file is not loaded. Downloaded files
live in the app's user directory and are deleted with one button.

All six run through whisper.cpp: from version b4938 onward it ships
`parakeet-cli` alongside `whisper-cli`, so the whole app stands on one engine
family, one weight format (GGML) and one acceleration layer. On macOS that layer
is Metal.

| Model | Engine | Download | Approximate RAM | Weight licence |
| --- | --- | ---: | ---: | --- |
| Whisper large-v3-turbo | whisper.cpp | 1.6 GB | ~1.8 GB | MIT |
| Whisper large-v3-turbo (quantized, q5_0) | whisper.cpp | 574 MB | ~0.8 GB | MIT |
| Whisper large-v3 | whisper.cpp | 3.1 GB | ~3.4 GB | MIT |
| Whisper large-v3 (quantized, q5_0) | whisper.cpp | 1.1 GB | ~1.4 GB | MIT |
| Parakeet TDT 0.6B v3 (quantized, q8_0) | whisper.cpp | 669 MB | ~1.0 GB | CC-BY-4.0 |
| Parakeet TDT 0.6B v3 (F16) | whisper.cpp | 1.26 GB | ~1.7 GB | CC-BY-4.0 |

Which one to pick:

- **Whisper large-v3-turbo** — the sensible starting point. Accuracy close to
  large-v3 at a fraction of the time.
- **The quantized variants** — the same model with 5-bit weights. About a third
  of the disk and memory for a small accuracy cost; on a machine with 8 GB of
  RAM that is the difference between "works" and "swaps".
- **Whisper large-v3** — when the recording is hard: noise, accents, overlapping
  speech. Noticeably slower, and in those cases worth it.
- **Parakeet TDT 0.6B v3** — NVIDIA's multilingual model. Very fast, with
  punctuation, trained on exactly 25 European languages (Bulgarian among them).
  Do not reach for it outside those 25 — unlike Whisper, it does not recognize a
  language it has never seen; it produces nonsense instead.

## Cloud providers

The key is yours and stays yours: you enter it once, the app checks it with a
**Test connection** button before it saves anything at all, and only after a
successful test does it let you choose a specific model from that provider. So
you never reach a failed job because of one mistyped character in a key.

| Provider | What it offers |
| --- | --- |
| **DeepInfra** | Whisper large-v3 and large-v3-turbo, plus Voxtral and Qwen3-ASR. Billed per second of audio. |
| **Deepgram** | Nova-3 and Nova-2. Fast, with strong diarization and 100+ languages. |
| **ElevenLabs** | Scribe v2. 90+ languages, speaker diarization and audio-event tags. |
| **OpenRouter** | One key for many vendors' audio models, routed through a single endpoint. |

Keys are encrypted through Electron `safeStorage` and written to **Keychain** on
macOS and **Credential Manager** on Windows. They are never written to the logs,
never end up in the text of an error, and are never shown back to you in the
interface — after saving you see only the last four characters.

For cloud transcription the file is downmixed to 16 kHz mono and re-encoded
small before upload, which saves bandwidth and time with no perceptible accuracy
cost. Which codec depends on what the bundled ffmpeg can actually produce — Opus
where it is available, otherwise Vorbis, MP3 or AAC — and the bitrate drops
further when a provider caps the upload size. If that does not suit you, use a
local model; then nothing leaves the machine.

## Export

| Format | What for |
| --- | --- |
| **TXT** | Plain text, no timings. |
| **Markdown** | Formatted text, optionally with speaker names. |
| **SRT** | The classic subtitle format, accepted by almost everything. |
| **WebVTT** | Subtitles for web players. |
| **JSON** | The full structure: segments, words, times in milliseconds. |
| **CSV** | For a spreadsheet or further processing. |

Subtitles are not simply the sentences with times in front of them. SRT and
WebVTT go through re-segmentation by the rules real subtitlers use:

- at most **42 characters per line**;
- at most **2 lines** per cue;
- at most **17 characters per second** — a pace that can be read;
- a minimum of **1 second** and a maximum of **7 seconds** per cue;
- breaks at sentence boundaries, and where needed at a comma or a long pause,
  never in the middle of the meaning.

When a cue has to be carried over two lines, the lines are balanced by length
instead of filling the first one to the end — otherwise you get 41 characters
above 3 characters, which a reader perceives as a mistake.

## Build from source

You need **Node 22** or newer.

```sh
git clone https://github.com/markdudov/dropscribe.git
cd dropscribe
npm ci
npm run binaries:fetch
npm run dev
```

`npm ci` installs the dependencies and, through `postinstall`, already pulls the
helper binaries (ffmpeg, ffprobe, `whisper-cli`, `parakeet-cli`) for your
platform and architecture. `npm run binaries:fetch` is the same step run
explicitly — useful if the download was interrupted or you are switching
platforms. Every binary is checked against a recorded hash.

`npm run dev` brings up electron-vite with hot reloading of the interface.

Other useful commands:

```sh
npm run typecheck   # TypeScript, strict mode, no emit
npm run lint        # ESLint, zero warnings
npm test            # vitest
npm run pack        # builds an installer through electron-builder
```

Models are not downloaded at build time — the app fetches them only when you ask
for one.

Contributing? Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[`docs/README.md`](docs/README.md), which is the map of the documentation.

## Supporting the project

DropScribe is free and MIT licensed, and it stays that way. There is no paid
tier, nothing is held back, and nothing phones home.

It does cost money to keep going, though — an Apple Developer membership so the
macOS builds are signed and notarized rather than greeted by a warning, and the
time that goes into them. If it saves you work and you would like to chip in:

- [PayPal](https://www.paypal.com/paypalme/markdudov)
- [Revolut](https://revolut.me/markdudov)

Entirely optional. A good bug report is worth as much.

## Licences

| Component | Licence |
| --- | --- |
| DropScribe (the code in this repository) | **MIT** |
| Whisper weights (large-v3, large-v3-turbo and their quantized variants) | **MIT** |
| Parakeet TDT 0.6B v3 weights | **CC-BY-4.0** |
| Vendored `whisper-cli` / `parakeet-cli` (whisper.cpp, tag `b4938`) | **MIT** |
| Vendored ffmpeg / ffprobe | **GPL-3.0-or-later** |

The ffmpeg that ships with the app is compiled with GPL components, so that
binary is under **GPL-3.0-or-later**. As that licence requires, we offer the
complete corresponding source of the exact build to anyone who asks: the build
scripts, the configure line and the sources live at
[markdudov/silencetrimmer-media-binaries](https://github.com/markdudov/silencetrimmer-media-binaries),
and if what you need is not there,
[open an issue](https://github.com/markdudov/dropscribe/issues) or write to the
author. The exact versions, the build flags and the links to the sources are
also in the licence panel inside the app itself.

Parakeet is under CC-BY-4.0 — if you publish transcripts or derivatives, you owe
attribution to NVIDIA as the author of the model. Whisper and the app's own code
carry no such requirement.

---

Bugs and suggestions: [Issues](https://github.com/markdudov/dropscribe/issues).
If you are reporting a recognition problem, state the model, the language and
the length of the recording — we do not need the file itself.
