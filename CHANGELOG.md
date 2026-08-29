# Changelog

All notable changes to DropScribe are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.1.0] - 2026-08-29

First public release. Unsigned on both macOS and Windows, and with no
auto-update: new versions have to be downloaded from the Releases page by hand.

### Added

- **Drag-and-drop transcription on macOS and Windows.** Drop one file or a
  hundred onto the window, or pick them from the native dialog. Audio and video
  are both accepted — the engines never see the container, only the 16 kHz mono
  WAV that ffmpeg produces from it, so anything ffmpeg can demux works.
- **Local transcription that never touches the network.** Whisper large-v3 and
  large-v3-turbo (full precision and 5-bit quantized) and NVIDIA Parakeet TDT
  0.6B v3 (Q8 and F16) run through vendored whisper.cpp binaries — `whisper-cli`
  and `parakeet-cli`, both from the same b4938 build — with Metal acceleration
  on Apple silicon. Once the weights are on disk, a local job makes no outbound
  request of any kind.
- **Model downloads on first use.** Weights are fetched from Hugging Face into
  the app's own models directory, pinned by exact byte count and SHA-256 taken
  from Hugging Face's LFS metadata, with progress, cancellation and deletion
  from the model list.
- **Four cloud providers, bring your own key.** DeepInfra, Deepgram, ElevenLabs
  and OpenRouter. Each key can be tested before it is saved — a key that fails
  the test never reaches storage — and each provider carries its own model list
  and its own selected model, so the choice of provider and the choice of model
  are two separate decisions.
- **API keys stored in the operating system's credential store**, not in a
  config file next to the settings.
- **Export to TXT, Markdown, SRT, WebVTT, JSON and CSV.** The subtitle formats
  do not write the recognizer's own segments: cues are rebuilt to professional
  subtitling limits — 42 characters per line, two lines, 17 characters per
  second, seven seconds maximum and one second minimum on screen, with a forced
  break across any audible pause. Export a single job, export many jobs in many
  formats at once, write beside the source file or into a chosen folder, or copy
  the rendered text to the clipboard.
- **A job queue with cancellation and per-file progress.** Every file reports a
  percentage and a named stage — extracting audio, uploading, transcribing —
  and can be cancelled mid-flight, retried, or removed. Concurrency defaults to
  one job at a time, because local inference is bound by memory rather than by
  cores and pretending otherwise only makes both jobs slower.
- **One transcript shape behind every engine and provider**, with word-level
  timings wherever the engine reports them, speaker labels wherever the provider
  diarizes, and all time as integer milliseconds converted exactly once at the
  adapter boundary.
- **English and Bulgarian interface**, with light, dark and system themes.
- **A third-party licence notice** in the app covering the vendored binaries and
  the model weights, whose licences are not this app's licence.

### Security

- API keys are never logged, never serialized into a job record, and never
  placed in an error message or in any URL that gets written down. A provider's
  error body is surfaced to the user only after the key is stripped from it.
- Only paths the user explicitly dropped or chose in a dialog are readable. The
  renderer cannot name an arbitrary file, and cannot name a URL either: external
  links are opened by semantic id, so a compromised renderer cannot turn the
  app into an arbitrary-URL opener.

[Unreleased]: https://github.com/markdudov/dropscribe/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/markdudov/dropscribe/releases/tag/v0.1.0
