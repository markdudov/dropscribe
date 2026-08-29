# DropScribe — design specification

| | |
|---|---|
| **Date** | 2026-08-29 |
| **Status** | Approved for implementation. Supersedes nothing. |
| **Repo** | `markdudov/dropscribe`, public, MIT |
| **Target** | v1.0, macOS (arm64 + x64) and Windows (x64) |
| **Author** | Mark-Antoniy Dudov |

## How to read the evidence markers

Every non-obvious factual claim in this document carries its provenance, because
the three kinds are not equally trustworthy and a reader six months from now
cannot tell them apart by tone.

- **[measured]** — observed by running the thing on the author's machine on
  2026-08-29. The whisper.cpp JSON shape, the `parakeet-cli` flag list, and the
  engine build number are of this kind.
- **[probe]** — obtained by an HTTP request to the live third-party API or by
  reading its live machine-readable spec on 2026-08-29. Endpoint existence, auth
  header names, error-body shapes and model catalogues are of this kind.
- **[unverified]** — believed, but not confirmed by either of the above. Usually
  because it needed a credential we do not have, or because the only source is a
  vendor's prose documentation, which we have repeatedly caught contradicting
  its own spec.

An unmarked statement is a design decision made in this document, not a fact
about the world.

---

## 1. The problem

Transcription is a solved problem that is still annoying to actually use. The
good local models exist and run fast on a laptop, but reaching them means a
Python environment, a CLI, and a manual `ffmpeg` incantation for every file that
isn't already a 16 kHz mono WAV. The good cloud APIs exist and are cheap, but
each one has a different auth header, a different multipart field name, a
different response shape and a different set of undocumented limits, so using
two of them means writing the integration twice.

Meanwhile the actual task is: *here is a video file, give me the words in it.*

DropScribe is the smallest honest thing that closes that gap. You drag a file
onto a window. It transcribes. You get an SRT.

The two design commitments that follow from that framing, and that everything
below is downstream of:

1. **Nothing is installed at run time except a model.** No Python, no ONNX
   Runtime, no user-supplied `ffmpeg` on `PATH`. The app ships every binary it
   executes.
2. **The user's key is the user's key.** There is no DropScribe account, no
   proxy, no server. The app is a client for services the user already pays for,
   and it has nowhere to send a key even if it wanted to.

---

## 2. Constraints

| Constraint | Consequence |
|---|---|
| Two platforms: macOS and Windows | Every vendored binary needs two (really three, counting mac arm64/x64) builds, each signed. No platform-specific feature may be load-bearing. |
| Public repo, MIT | No secrets in the tree. No non-redistributable binaries. The licence of every vendored artefact and every model weight has to be stated and compatible. |
| The user brings the key | Key storage is a local-security problem, not an account problem. Key *testing* has to work before the key is trusted enough to save. |
| Media files are large | A 2-hour film is gigabytes. Nothing may load a whole file into memory, and every long operation needs a progress signal and a cancel path. |
| Local inference is memory-bound | Whisper large-v3 wants ~3.4 GB resident. Default job concurrency is 1, not `cpus().length`. |
| The engines only eat 16 kHz mono WAV | Every input goes through ffmpeg first, always, even when it is already a WAV — the branch that decides "this one doesn't need converting" is a source of bugs that costs more than the conversion. |
| Electron's renderer is hostile territory | It parses filenames, provider JSON and transcript text. It must never hold a key, a raw path it can act on, or the ability to name a URL. |

---

## 3. Requirements, as the owner gave them

Reproduced as stated, then annotated. Nothing here was inferred.

> **R1.** Drag and drop.

> **R2.** Local models: Whisper V3 Turbo, Whisper V3 Large, and Parakeet V3.

Upstream those are `openai/whisper-large-v3-turbo`, `openai/whisper-large-v3`
and `nvidia/parakeet-tdt-0.6b-v3`. The catalogue uses the upstream names. The
implementation adds a 5-bit quantized variant of each Whisper model and an F16
Parakeet, because the unquantized large-v3 is a 3.1 GB download and a 3.4 GB
resident set, which is not a reasonable *only* option on an 8 GB machine. The
three the owner asked for remain the three that are recommended by default.

> **R3.** Cloud providers: DeepInfra, Deepgram, ElevenLabs and OpenRouter, each
> with the user's own key, a connection test, and model selection **after** a
> successful test.

The ordering in that sentence is a spec, not a UI preference: the model picker
does not exist until the key has proved itself. `ProviderState.models` is empty
until `lastTest.ok`, and `saveProviderKey` runs the test first and stores
nothing if it fails.

> **R4.** macOS and Windows.

Linux is not a target. `AppInfo.platform` admits `'linux'` because
`process.platform` does, not because we ship for it. An unsigned Linux build
will probably work and is explicitly unsupported.

> **R5.** Public repo.

MIT, at `github.com/markdudov/dropscribe`.

### Requirements the owner did not state but that R1–R5 imply

- **R6.** Subtitle output. "Give me the words in a video" means SRT and WebVTT
  in practice, which means a re-segmenter, which means word-level timings
  wherever the engine will give them.
- **R7.** A queue. Drag-and-drop of *one* file is a demo; people drop folders.
- **R8.** Cancellation. A 2-hour local job the user cannot stop is a hang.

---

## 4. Stack decisions

Each subsection states what was chosen, what the serious alternative was, and
the specific fact that decided it. Decisions with no serious alternative are not
listed.

### 4.1 Electron 43, not Tauri v2

**Chosen: Electron 43 + React 18 + TypeScript, built by electron-vite, packaged
by electron-builder.**

Tauri v2 is the better answer on the merits that get written about: a Tauri
build of this app would be perhaps 10 MB instead of perhaps 90 MB, would use a
system webview instead of shipping Chromium, and would put the ffmpeg and engine
orchestration in Rust where the audio ecosystem is genuinely stronger. The
research pass for this project assumed Rust throughout and evaluated `symphonia`
0.6.1, `rubato` 5.0.0 and the `sherpa-onnx` / `transcribe-cpp` crates in detail.

It was rejected on one fact that outweighs all of that: **the owner already
ships a cross-platform Electron media application, and its ffmpeg vendoring,
code-signing, notarization and release pipeline already work.** Those three
things — a redistributable ffmpeg for macOS arm64, a notarization flow that
survives a hardened-runtime binary spawning child processes, and a working
signed-installer release — are the parts of this project most likely to eat a
week each. They are already paid for on the Electron side and would be paid for
again on the Tauri side.

The macOS ffmpeg problem is the sharpest illustration, and it is stack-independent:
there is no redistributable prebuilt ffmpeg for macOS arm64 at all **[probe]** —
BtbN publishes no macOS builds, evermeet.cx is x86_64-only and builds with
`--enable-nonfree` (which nobody may redistribute), and osxexperts.net ships a
GPL build under an "educational purposes only" disclaimer. Whoever ships this
app builds its own LGPL ffmpeg. The owner has already done that once.

Secondary, real, but not decisive:

- The transcript re-segmenter, the subtitle exporters and the whole data model
  are pure logic that the renderer and the test suite both need. In Electron
  they are one TypeScript file compiled by both projects. In Tauri they would be
  either duplicated in Rust and TypeScript or pushed entirely behind IPC.
- Tauri v2's system-webview model means the renderer is WebKit on macOS and
  WebView2 on Windows, i.e. two rendering engines to test. Electron is one.

What we accept in exchange, stated plainly: a ~90 MB installer before models, a
Chromium security-update treadmill, and a renderer that must be locked down by
hand (see §8) rather than being sandboxed by default.

### 4.2 whisper.cpp for *both* engines, not sherpa-onnx for Parakeet

**Chosen: `whisper-cli` and `parakeet-cli`, both from whisper.cpp build b4938
[measured]. One engine family, one model format, no ONNX Runtime anywhere in
the app.**

This reverses the research pass's own recommendation, and the reason is worth
recording because the research was not wrong when it was written. Evaluating
"run Parakeet TDT v3 locally with no Python" in isolation produces two credible
answers **[probe]**: `sherpa-onnx` 1.13.6 (official first-party bindings,
prebuilt static libs, trivial to build) or `transcribe.cpp` 0.2.2 (GGUF, MIT,
Metal on Apple Silicon, ~149× realtime on an M4 Max versus ~30× for a tuned
ONNX-Runtime CPU path). Both are packaged for Node with per-platform optional
dependencies. Either would work.

Both were rejected by a fact measured after the research: **since b4938,
whisper.cpp ships `parakeet-cli` alongside `whisper-cli` [measured].** That
collapses the problem. Choosing sherpa-onnx would have meant, concretely:

- A second inference runtime in the bundle (ONNX Runtime, ~1.27.1, with its own
  per-platform binaries) beside the GGML one that Whisper already requires.
- A second model format. sherpa-onnx wants an encoder/decoder/joiner/tokens
  quartet; the istupakov ONNX export fuses decoder and joint into one file and
  the two layouts are **not interchangeable** **[probe]**. Meanwhile Whisper
  wants a single GGML `.bin`. The model store would have needed per-engine
  multi-file download, multi-file integrity checking, and a repair path for a
  half-written 2.44 GB external-weights sidecar.
- A second set of native artefacts to sign and notarize on two platforms.
- A second class of failure to diagnose in a bug report.

Against that, one engine family means: one binary vendoring script, one
`.bin`-per-model download, one integrity check, one progress convention to
parse, one set of licences to notice. `EngineId` is `'whisper-cpp' |
'parakeet-cpp'` and the difference between them is entirely inside two adapter
files.

Also rejected, for completeness: `parakeet-mlx` (macOS-only *and* Python-only —
disqualified twice over **[probe]**), and hand-writing a TDT greedy decoder
against raw ONNX Runtime (2–4 weeks, and the exact class of bug — zero-skip
stalls dropping words — that shipped in sherpa-onnx as issue #2605 and was fixed
only in September 2025 **[probe]**).

The cost of this choice is real and is recorded in §13: `parakeet-cli` emits no
JSON and takes no language flag **[measured]**, so the Parakeet adapter parses
human-readable segment lines rather than a structured document.

### 4.3 ffmpeg as a vendored subprocess, not a linked library and not the user's

**Chosen: a purpose-built LGPL `ffmpeg` and `ffprobe`, vendored per platform,
invoked over argv and pipes.**

Three alternatives, all rejected:

- **Link libav\* into the app.** ffmpeg.org's legal page frames the entire LGPL
  obligation chain — dynamic linking, matching source, prominent attribution,
  EULA language, no reverse-engineering prohibition — around *linking* **[probe]**.
  Shipping the standalone executable and talking to it over a pipe is conveying
  a separate unmodified program, which is the position HandBrake, Audacity and
  Shotcut rely on. DropScribe is MIT and open-source, so this matters less than
  it would for a closed app, but there is no reason to take on the harder
  argument for zero benefit.
- **Use whatever `ffmpeg` is on `PATH`.** Makes the app's behaviour a function
  of the user's machine. A GPL build, a nonfree build, a five-year-old build and
  no build at all all present identically until a job fails.
- **Decode in-process instead of shipping ffmpeg.** This was the research
  pass's hybrid recommendation and it is stack-specific: it depended on Rust's
  `symphonia`. In Node there is no equivalent, and `symphonia` itself cannot
  decode Opus, WMA, or AVI, and cannot handle AC-3/E-AC-3/DTS/TrueHD — which is
  the audio track of the majority of real films **[probe]**.

A stock static ffmpeg is 100+ MB (BtbN's win64 LGPL zip is 141.6 MB **[probe]**).
A `--disable-everything` audio-only build re-enabling only the demuxers,
decoders and the `pcm_s16le` + `libopus` encoders this app uses is roughly
3–5 MB **[unverified — forum-sourced figure, must be confirmed against an
actual build before the size budget is trusted]**. Built without `--enable-gpl`
and without `--enable-nonfree`, so it is LGPL and redistributable. AC-3, DTS and
TrueHD decoders are native LGPL ffmpeg code and do **not** trigger GPL — only
the external GPL libraries (libx264/libx265) and `--enable-nonfree` do **[probe]**.

`ffmpeg-sidecar`-style auto-download is explicitly forbidden in this codebase:
it resolves to gyan.dev GPLv3 builds on Windows and evermeet.cx GPL+nonfree
builds on macOS **[probe]**, and it hardcodes a stale macOS arm64 URL. Binaries
come from `scripts/fetch-binaries.mjs` against pinned URLs and pinned SHA-256s,
or they do not come at all.

### 4.4 One WAV per job, no client-side chunking in v1

**Chosen: ffmpeg produces exactly one 16 kHz mono WAV for the local path and
exactly one ~12 kbps Opus-in-Ogg file for the cloud path. Neither is split.**

The alternative — a VAD-aligned chunk map, transcribe chunks in parallel, stitch
with per-chunk offsets — is the right answer at scale and is what WhisperX does
**[probe]**. It is out of scope for v1 for two reasons. Locally, whisper.cpp
already does its own 30-second windowing internally and ships a built-in Silero
v6.2.0 VAD behind `--vad` **[probe]**, so client-side chunking buys progress
granularity and nothing else. For the cloud, 12 kbps mono Opus puts a 2-hour
film at about 10.8 MB, which is far inside every limit any of the four providers
document.

The cost is a real, bounded failure mode: Deepgram returns `504 Gateway Timeout`
after **10 minutes of server-side processing** (20 for its Whisper models)
**[probe]**, and that is wall-clock processing time, not audio duration, so no
client-side duration cap can reliably avoid it. Recorded as a risk in §13 with
chunking named as the v2 fix.

Ogg rather than WebM deserves a note, since the research recommends WebM: that
recommendation is specific to OpenAI, whose accepted-format list omits bare
`.ogg` **[probe]**. OpenAI is not one of our four providers. DeepInfra's
OpenAI-compatible endpoint lists `ogg`, ElevenLabs lists OGG and OPUS, and
Deepgram documents Opus **[probe]**. Ogg is smaller to mux and adequate for all
four. The fallback if a provider rejects it is `-c:a aac -b:a 24k -f mp4`
(~21.6 MB for two hours).

---

## 5. Architecture

### 5.1 Processes

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ RENDERER  — Chromium, sandbox: true, contextIsolation: true              │
 │                                                                          │
 │   React 18 · Tailwind 3 · zustand 5 · lucide-react                       │
 │   Drop zone │ Job list │ Model manager │ Provider settings │ Preview     │
 │                                                                          │
 │   Has: a mirror of main's job list, kept in step by events.              │
 │   Has NOT: node, fs, net, any API key, any path it can act on directly.  │
 └───────────▲──────────────────────────────────────┬───────────────────────┘
             │ jobs:updated                          │ window.dropscribe.*
             │ models:updated                        │
 ┌───────────┴──────────────────────────────────────▼───────────────────────┐
 │ PRELOAD  — CommonJS (a sandboxed preload cannot be ESM), contextBridge   │
 │                                                                          │
 │   contextBridge.exposeInMainWorld('dropscribe', api)   — one object      │
 │   ipcRenderer.invoke for everything except files:authorize (sendSync)    │
 │   webUtils.getPathForFile — the ONLY way a dropped File becomes a path   │
 └───────────▲──────────────────────────────────────┬───────────────────────┘
             │                                       │
 ┌───────────┴───────────────────────────────────────▼──────────────────────┐
 │ MAIN  — Node, owns all truth                                             │
 │                                                                          │
 │   main.ts .............. window, menu, IPC handler registration          │
 │   path-policy.ts ....... the allow-list every path must pass             │
 │   binaries-runtime.ts .. where the vendored executables live             │
 │   ffmpeg.ts ............ probe / extractWav16k / compressForUpload       │
 │   transcribe/queue.ts .. the state machine; owns every Job               │
 │   engines/ ............. whisper-cpp.ts, parakeet-cpp.ts                 │
 │   providers/ ........... deepinfra, deepgram, elevenlabs, openrouter     │
 │   services/ ............ credentials, settings, model-store              │
 │   shared/ .............. PURE. No node, no electron. Compiled by both.   │
 └──────┬───────────────────────────┬───────────────────────┬───────────────┘
        │ spawn                     │ spawn                 │ https
        ▼                           ▼                       ▼
 ┌──────────────┐          ┌──────────────────┐    ┌──────────────────────┐
 │ ffmpeg       │          │ whisper-cli      │    │ api.deepinfra.com    │
 │ ffprobe      │          │ parakeet-cli     │    │ api.deepgram.com     │
 │              │          │  (whisper.cpp    │    │ api.elevenlabs.io    │
 │ argv + pipes │          │   b4938)         │    │ openrouter.ai        │
 │ stderr→prog. │          │ stdout/stderr    │    │ huggingface.co (dl)  │
 └──────────────┘          └──────────────────┘    └──────────────────────┘
```

### 5.2 The one-way flow of a job

```
  drop ──► webUtils.getPathForFile ──► files:authorize (sendSync)
                                            │
                                     path-policy.authorize()
                                       is it a media extension?
                                       is it a readable file?
                                            │ yes → recorded
                                            ▼
                                   jobs:enqueue(paths, target)
                                            │
                              ┌─────────────▼─────────────┐
                              │  queue: status 'queued'   │
                              └─────────────┬─────────────┘
                                            ▼  assertAuthorized(path)
                                  'preparing' ── ffprobe → durationMs
                                            │
                     ┌──────────────────────┴──────────────────────┐
                     ▼ local                                 cloud ▼
            extractWav16k → tmp .wav               compressForUpload → tmp .ogg
                     │                                              │
            engineFor(id).run()                        adapterFor(id).transcribe()
            whisper-cli / parakeet-cli                 multipart POST + own key
                     │                                              │
                     └──────────────────┬───────────────────────────┘
                                        ▼
                            normalizeTranscript()   ← the ONLY ms boundary
                                        ▼
                            'done', transcript attached
                                        ▼
                       auto-export per OutputSettings.formats
                                        ▼
                              jobs:updated → renderer
```

Two properties of that diagram are load-bearing and are asserted as invariants:

1. **`normalizeTranscript` is the single funnel.** Every engine and every
   provider converts its own time units to integer milliseconds inside its own
   adapter, and then the result passes through `normalizeTranscript` exactly
   once. Nothing downstream ever sees a float second. This exists because the
   single most expensive bug in this problem domain is a silent unit error:
   whisper.cpp's C API reports centiseconds, Deepgram and ElevenLabs report
   fractional seconds, and a 10× error looks entirely plausible on a 20-second
   test clip and crams a film's subtitles into its first twelve minutes.
2. **The renderer is downstream of `path-policy` and never upstream of it.** A
   path the renderer names that main has not itself authorized is refused, not
   sanitized.

---

## 6. Subsystems

Each entry gives the module's one responsibility, its exact interface, and — the
part that matters — what it is forbidden to do.

### 6.1 `electron/shared/*` — the pure core

```ts
// transcript.ts
export interface Word { text: string; startMs: number; endMs: number; confidence?: number; speaker?: string }
export interface Segment { startMs: number; endMs: number; text: string; words: Word[]; speaker?: string }
export interface Transcript { language: string | null; languageConfidence?: number; durationMs: number;
                              segments: Segment[]; source: TranscriptSource; createdAt: string }
export function normalizeTranscript(t: Transcript): Transcript;
export function allWords(t: Transcript): Word[];
export function hasWordTimings(t: Transcript): boolean;
export function speakers(t: Transcript): string[];

// subtitles.ts
export function resegment(t: Transcript, o: SegmentationOptions): Cue[];
export function toSrt(cues: Cue[]): string;
export function toVtt(cues: Cue[]): string;
export function formatTimestamp(ms: number, style: 'srt' | 'vtt'): string;
export function layoutLines(words: TimedWord[], o: SegmentationOptions): string[];

// exports.ts
export function renderTranscript(t: Transcript, f: ExportFormat,
  o: { segmentation: SegmentationOptions; includeSpeakers: boolean; sourceName: string }): string;
export function exportFileName(sourceName: string, f: ExportFormat): string;
export function contentTypeFor(f: ExportFormat): string;
```

**Responsibility:** every transformation that is a function of data alone.

**Forbidden:** importing from `node:` or `electron`. This is enforced by
`tsconfig.web.json`, which lists `electron/shared/**/*` in the renderer's
`include`; a stray `import { readFile } from 'node:fs'` fails the web typecheck.
The rule exists so the renderer can preview an export without a round trip and
so the test suite can exercise the interesting logic in jsdom with no Electron
at all.

A recognizer's segments are not subtitle cues, and `resegment` is the boundary
between the two. Whisper emits ~30-second decode windows, Deepgram emits
paragraphs, ElevenLabs emits speaker turns; none of them know that 42 characters
per line and 17 characters per second is the intersection of the BBC and Netflix
guidelines. Exporters therefore never write segments directly.

### 6.2 `electron/binaries-runtime.ts`

```ts
export type BinaryName = 'ffmpeg' | 'ffprobe' | 'whisper-cli' | 'parakeet-cli';
export function binDir(): string;
export function binaryPath(name: BinaryName): string;   // appends .exe on win32
export function engineReport(): { name: string; path: string; present: boolean }[];
export function enginesReady(): boolean;
export function licenseNoticePath(): string;
```

**Responsibility:** know where the four vendored executables are — under
`process.resourcesPath/bin` when packaged, under
`vendor/bin/<platform>-<arch>/` in development — and answer honestly when one is
missing.

`enginesReady()` and `engineReport()` are surfaced all the way to `AppInfo` for
one reason: a missing binary must produce a clear statement in the UI at launch,
not an `ENOENT` inside a job forty minutes later.

### 6.3 `electron/path-policy.ts`

```ts
export function authorize(absolutePath: string): boolean;
export function isAuthorized(absolutePath: string): boolean;
export function assertAuthorized(absolutePath: string): void;  // throws a user-facing Error
export function authorizeAll(paths: string[]): string[];       // the accepted subset
```

**Responsibility:** be the only place a filesystem path becomes usable. A path
enters through a native dialog or a drop, is checked (media extension, exists,
is a readable regular file) and is recorded. Every consumer calls
`assertAuthorized` before touching it.

**Forbidden:** accepting a path the renderer merely asserted. The renderer is
the process that parses untrusted content; treating a string from it as a
filesystem capability is how a rendering-engine bug becomes an arbitrary-file-read.

### 6.4 `electron/ffmpeg.ts`

```ts
export interface MediaInfo { durationMs: number; hasAudio: boolean; sampleRate: number | null;
                             channels: number | null; codec: string | null; bytes: number }
export function probe(filePath: string): Promise<MediaInfo>;
export function extractWav16k(filePath: string, outPath: string,
  ctx: { signal: AbortSignal; onProgress?: (fraction: number) => void; durationMs?: number }): Promise<void>;
export function compressForUpload(filePath: string, outPath: string,
  ctx: { signal: AbortSignal; durationMs?: number }): Promise<void>;
```

**Responsibility:** turn anything into the one shape the next stage accepts.

The extraction command is, in substance **[probe]**:

```
ffmpeg -hide_banner -nostdin -loglevel error -y -i INPUT \
       -vn -sn -dn -map 0:a:0 -ac 1 -ar 16000 -c:a pcm_s16le -f wav OUT.wav
```

Every flag earns its place. `-nostdin` stops ffmpeg from consuming the parent
process's stdin, which is a classic subprocess hang. `-vn -sn -dn` drop the
video, subtitle and data streams — on a film that is 99% of the bytes.
`-map 0:a:0` picks the first audio track *deterministically*, because a film MKV
routinely carries three to five. `-ac 1` uses ffmpeg's proper ITU downmix matrix
rather than a naive channel average; on 5.1 audio, dialogue lives in the front-
centre channel, and averaging six channels equally attenuates it to a sixth and
floods it with score — the worst possible ASR input **[probe]**. `-ar 16000`
resamples through libswresample with anti-aliasing.

For the cloud path, the same pipeline ends in `-c:a libopus -b:a 12k -vbr on
-application voip -f ogg`.

Progress comes from parsing `-progress`-style output against the `durationMs`
the caller already has. When duration is unknown, progress is `null`, not
guessed — see §9.

**Forbidden:** `-c copy` slicing of compressed audio, and `-count_frames` /
`-count_packets` on a probe (it forces a full file scan and takes minutes on a
film **[probe]**).

### 6.5 `electron/engines/*`

```ts
export interface LocalRunRequest { wavPath: string; modelPath: string; durationMs: number;
                                   language: string | null; translate: boolean; threads: number }
export interface LocalRunContext { signal: AbortSignal; onProgress: (percent: number) => void }
export interface LocalEngine { readonly id: EngineId; run(r: LocalRunRequest, c: LocalRunContext): Promise<Transcript> }
export function engineFor(id: EngineId): LocalEngine;
```

**`whisper-cpp.ts`.** Invokes **[measured]**:

```
whisper-cli -m MODEL -f FILE.wav -l auto -oj -ojf -of OUTBASE -pp -np
```

and reads `OUTBASE.json`, whose shape is **[measured]**:

```
{ systeminfo, model, params,
  result: { language },
  transcription: [ { timestamps: {from, to},
                     offsets:    {from, to},
                     text,
                     tokens: [ { text, timestamps, offsets: {from, to}, id, p, t_dtw } ] } ] }
```

Three measured details the adapter depends on:

- **`offsets.from` / `offsets.to` are already integer milliseconds.** They are
  not centiseconds. The centisecond unit that bites everyone is in whisper.cpp's
  *C API* (`whisper_full_get_segment_t0`), which the JSON writer has already
  converted. Multiplying by 10 here is the bug, not the fix.
- **A token's `text` carries its own leading space**, and a token that begins
  with a space starts a new word. That is the entire word-splitting rule.
- **Special tokens appear inline** as `[_BEG_]`, `[_TT_123]` and friends and must
  be dropped before assembling words. `p` is a 0..1 confidence and maps to
  `Word.confidence`.

Progress arrives on **stderr**, not stdout, as
`whisper_print_progress_callback: progress =  42%` **[measured]**.

`language: null` becomes `-l auto`; `translate: true` becomes `-tr`; `threads`
becomes `-t`.

**`parakeet-cpp.ts`.** Invokes **[measured]**:

```
parakeet-cli -m MODEL -f FILE.wav -ps -np
```

The complete option list is `-t/--threads`, `-m/--model`, `-f/--file`,
`-ng/--no-gpu`, `-dev/--device`, `-ps/--print-segments`, `-otxt`, `-of`, `-np`
**[measured]**. Three absences drive the design:

- **No JSON output.** With `-ps` the binary prints segment lines on stdout in
  whisper.cpp's bracket form, `[00:00:00.000 --> 00:00:05.040]  text`, and the
  adapter parses those. If `-ps` yields nothing, the adapter falls back to the
  plain transcript text as one segment spanning the whole file — a degraded but
  correct result rather than an error.
- **No language flag.** Parakeet v3 is multilingual over 25 European languages
  and detects on its own. `LocalRunRequest.language` is therefore *ignored* by
  this engine, and the UI disables the language selector when a Parakeet model
  is the target rather than silently discarding the user's choice.
- **No translate flag.** `translate: true` is likewise unsupported and disabled
  in the UI.
- **No word timings and no progress callback.** Progress is synthesized as
  `lastSegmentEndMs / durationMs` as segment lines stream in, which is honest
  and monotonic. `Segment.words` is empty, and `hasWordTimings()` returning
  false is what tells `resegment` to fall back to segment-level cue boundaries.

**Forbidden in both:** feeding the engine anything but the WAV `ffmpeg`
produced. Both binaries accept mp3/flac/ogg directly, but the source is usually
a video container neither can demux, and a code path that is only exercised by
a minority of inputs is a code path that is broken.

### 6.6 `electron/providers/*`

```ts
export interface CloudRequest { apiKey: string; modelId: string; filePath: string;
                                durationMs: number; options: CloudOptions }
export interface CloudContext { signal: AbortSignal; onProgress: (percent: number | null, stage: string) => void }
export interface ProviderAdapter {
  readonly id: ProviderId;
  testKey(apiKey: string, signal: AbortSignal): Promise<KeyTestResult>;
  listModels(apiKey: string, signal: AbortSignal): Promise<ProviderModel[]>;
  transcribe(request: CloudRequest, ctx: CloudContext): Promise<Transcript>;
}
export function adapterFor(id: ProviderId): ProviderAdapter;
```

Four providers, four genuinely different APIs. The adapter boundary is what
makes a fifth provider a one-file change. **No adapter may leak its own response
types past this interface.**

`testKey` is required to be *free* — no inference, no credits — because the
button that calls it is a button the user will press repeatedly while pasting.
Per provider, verified live on 2026-08-29:

| | Auth header | Free key test | Model list |
|---|---|---|---|
| **DeepInfra** | `Authorization: Bearer <key>` **[probe]** | `GET /v1/openai/models` **[probe]** | `GET https://api.deepinfra.com/models/list`, filter client-side on `type === 'automatic-speech-recognition'` and drop `deprecated` **[probe]** |
| **Deepgram** | `Authorization: Token <key>` — *not* `Bearer` **[probe]** | `GET /v1/auth/token`, status only **[probe]** | `GET /v1/models` (public, no auth), filter `stt[]` on `batch === true` **[probe]** |
| **ElevenLabs** | `xi-api-key: <key>`, no prefix **[probe]** | `GET /v1/user/subscription`, zero credits **[probe]** | not discoverable from `/v1/models` (TTS only); read the `model_id` enum from the public `openapi.json`, fall back to `['scribe_v2','scribe_v1']` **[probe]** |
| **OpenRouter** | `Authorization: Bearer <key>` **[unverified]** | `GET /api/v1/key` **[unverified]** | `GET /api/v1/models`, filter to audio-input models **[unverified]** |

Four traps, each of which would produce a plausible-looking wrong result, and
each of which the adapters are specified to avoid:

1. **DeepInfra's `GET /v1/openai/models` returns HTTP 200 with the full catalogue
   when the `Authorization` header is absent — and also when it is present but
   malformed, e.g. lacking the literal `Bearer ` prefix [probe].** A key
   validator that builds the header wrongly reports *every* string, including
   the empty one, as a valid key. The adapter asserts header construction
   explicitly and treats only 200-with-well-formed-header as valid, 401 as
   invalid.
2. **Deepgram's `GET /v1/models` needs no auth at all [probe]** and must never be
   used as a key test for the same reason. Conversely, `GET /v1/projects` can
   return 401 `INSUFFICIENT_PERMISSIONS` for a key that transcribes perfectly
   well, because Deepgram keys carry scopes **[probe]** — so a `/v1/projects`
   failure alone never marks a key invalid.
3. **Deepgram's `name` field is not what you pass as `?model=`.** Four different
   models are named `general`; `canonical_name` (`nova-3-general`,
   `nova-2-general`, …) is the value the API accepts **[probe]**. And the API
   default is `base-general`, the oldest tier, so `model` is always sent
   explicitly **[probe]**.
4. **`diarize` is deprecated in favour of `diarize_model`, and Deepgram rejects
   a request that sets both [probe].** The adapter emits exactly one of them.

Response parsing is defensive by specification, not by taste, because in three
of the four cases the vendor's own published schema is wrong:

- Deepgram's OpenAPI omits `punctuated_word` from
  `results.channels[].alternatives[].words[]` and types `start`/`end`/
  `confidence` as strings where the live API emits numbers **[probe]**. Strict
  codegen from that spec produces a broken client, so adapters are hand-written.
- DeepInfra's two endpoints are **not** interchangeable: the OpenAI-compatible
  one returns words as `{word,start,end}` with `language` as a full English name
  (`"english"`), the native one returns `{start,end,text}` with an ISO code
  (`"en"`) **[probe]**. The adapter targets the OpenAI-compatible endpoint and
  is written against that shape only. It must send
  `response_format=verbose_json`, because the default `json` returns *only*
  `{"text": "..."}` — no segments, no words, no duration **[probe]**.
- ElevenLabs returns a different top-level shape for multichannel
  (`{transcripts: [...]}` with no top-level `text`) **[probe]**. We never set
  `use_multi_channel`, so the parser branches on the presence of `transcripts`
  and errors clearly rather than silently producing an empty transcript.
  `tag_audio_events` defaults to **true** **[probe]** and is explicitly sent as
  false, or the transcript comes back seasoned with `(footsteps)`.

**OpenRouter is the weakest link in this section and is marked as such.** The
research pass probed DeepInfra, Deepgram and ElevenLabs against live endpoints
and did not probe OpenRouter at all. Everything in its row above is
**[unverified]**. OpenRouter is primarily a chat-completion router; audio
reaches it as an `input_audio` content part on a multimodal model rather than
through a dedicated transcription endpoint, which means it returns text with no
timings at all. The v1 adapter therefore produces a single `Segment` spanning
the file, `hasWordTimings()` is false, and subtitle output from OpenRouter is
correspondingly coarse. This is a documented limitation, not a defect, and §13
carries it as an open risk with the mitigation.

### 6.7 `electron/services/credentials.ts`

```ts
export function getKey(id: ProviderId): string | null;
export function setKey(id: ProviderId, key: string): void;
export function clearKey(id: ProviderId): void;
export function hasKey(id: ProviderId): boolean;
export function keyPreview(id: ProviderId): string | undefined;   // "…a91f"
```

**Responsibility:** hold four secrets, encrypted at rest with Electron's
`safeStorage` — Keychain-backed on macOS, DPAPI on Windows — in a file under
`userData`. The API is synchronous because `safeStorage.encryptString` /
`decryptString` are.

`keytar` was rejected: it is a native module (one more thing to rebuild per
Electron version, per platform, and to sign) and it is deprecated. `safeStorage`
ships with Electron.

**Forbidden:** returning a key to the renderer. `ProviderState` carries
`hasKey` and a four-character `keyPreview`, never the key. A key crosses the IPC
boundary in exactly one direction, once, when the user types it.

### 6.8 `electron/services/settings.ts` and `model-store.ts`

```ts
export function getSettings(): Settings;
export function saveSettings(patch: Partial<Settings>): Settings;
export function getProviderRecord(id: ProviderId): { models: ProviderModel[]; selectedModelId?: string; lastTest?: KeyTestResult };
export function saveProviderRecord(id: ProviderId, patch: Partial<{ models: ProviderModel[]; selectedModelId: string; lastTest: KeyTestResult }>): void;
export function clearProviderRecord(id: ProviderId): void;

export function modelsDir(): string;
export function modelPath(modelId: string): string;
export function isInstalled(modelId: string): boolean;
export function listModelStates(): ModelState[];
export function download(modelId: string, onUpdate: (state: ModelState) => void): Promise<void>;
export function cancelDownload(modelId: string): void;
export function deleteModel(modelId: string): void;
```

Settings and the per-provider record are separate because they have different
lifetimes: settings are user intent, the provider record is a cache of what a
successful test discovered. `clearProviderRecord` on key removal means the model
list cannot outlive the key that produced it.

The model store downloads to a `.part` file and renames on success, verifies
**both** the pinned byte count and the pinned SHA-256 before the rename, and
deletes the partial on any failure. A half-written 1.6 GB GGML file loaded by
`whisper-cli` surfaces as an opaque native-side crash, which is the single worst
error message this app could produce; it is cheaper to re-download.

The pinned sizes and hashes in `LOCAL_MODELS` are read from Hugging Face's own
LFS metadata via its API **[measured — read on the author's machine on
2026-08-29, but the values originate from Hugging Face, not from hashing a local
download; a hash computed from bytes you already trusted proves nothing]**.
`scripts/verify-model-catalogue.mjs` re-reads them in CI so a silent re-upload
upstream is caught by a build rather than by a user.

### 6.9 `electron/transcribe/queue.ts`

```ts
export interface JobQueue {
  enqueue(paths: string[], target: TranscribeTarget): Job[];
  list(): Job[];
  cancel(id: string): void;
  retry(id: string): void;
  remove(id: string): void;
  clearFinished(): void;
  onUpdate(callback: (job: Job) => void): () => void;
  shutdown(): void;
}
export function createQueue(): JobQueue;
```

**Responsibility:** own every `Job`, run at most `Settings.maxConcurrentJobs` of
them, and emit an update on every state change.

Concurrency defaults to **1**. `cpus().length` is the obvious alternative and is
wrong: Whisper large-v3 wants ~3.4 GB resident, so four parallel jobs is a
machine that swaps. The setting exists for users who know their own hardware.

Cancellation is an `AbortSignal` threaded from `cancel()` through ffmpeg and the
engine or adapter down to `child.kill()` / `fetch`'s abort. `'cancelled'` is a
distinct status from `'failed'` so the UI does not report an error the user
caused deliberately.

`shutdown()` kills every child process and deletes every temp file. Temp WAVs
are large — a 2-hour film is about 230 MB at 16 kHz mono s16 — and leaking them
across a crash is a real complaint.

**Known v1 limitation, deliberate:** the queue is in memory. A finished
`Job.transcript` does not survive quitting the app. What persists a transcript
is the automatic export on completion, driven by `OutputSettings.formats`. The
default for that field must therefore be non-empty; v1 ships `['srt', 'txt']`.

---

## 7. Data model

### 7.1 In memory

```
Transcript ──has──▶ Segment[] ──has──▶ Word[]
    │                                    └─ text, startMs, endMs, confidence?, speaker?
    ├─ language: string | null      (null means "the engine told us nothing" — not "und")
    ├─ languageConfidence?          (only ElevenLabs and Deepgram detect_language report it)
    ├─ durationMs                   (from ffprobe, never from the engine's own claim)
    ├─ source: { kind, engineId, modelId, label }
    └─ createdAt: ISO-8601

Transcript ──resegment()──▶ Cue[]  ──toSrt()/toVtt()──▶ string
             (reading-speed, line-length and gap rules the recognizer knows nothing about)

Job ──▶ { id, filePath, fileName, bytes, durationMs | null, target,
          status, progress: { percent: number | null, stage: string },
          transcript?, error?, startedAt?, finishedAt? }

TranscribeTarget = { kind: 'local'; modelId }
                 | { kind: 'cloud'; providerId; modelId }
```

Four rules govern this model and none of them are negotiable:

1. **All time is integer milliseconds.** Conversion happens at the adapter
   boundary, exactly once, with `Math.round` and never truncation. `14.3 * 1000`
   is `14299.999999999998` in binary floating point, and an exporter that floors
   it loses a millisecond per cue.
2. **`Segment.words` is `[]`, never `null`.** An engine that gives no word
   timings gives an empty array, and `hasWordTimings()` is the single predicate
   downstream code branches on.
3. **Optional means absent.** Under `exactOptionalPropertyTypes`, an optional
   field is spread conditionally (`...(x !== undefined ? { x } : {})`) and never
   assigned `undefined`. `speaker` absent and `speaker: undefined` are different
   things and only the first is legal.
4. **`durationMs` is ffprobe's, not the engine's.** Engines report the duration
   of what they decoded, which after VAD or a truncated read is not the duration
   of the file.

### 7.2 On disk

| Path | Contents | Format |
|---|---|---|
| `<userData>/settings.json` | `Settings` + per-provider records | JSON, plaintext, no secrets |
| `<userData>/credentials.json` | four API keys | `safeStorage`-encrypted blobs, base64 |
| `<userData>/models/<fileName>` | GGML model weights | pinned by size + SHA-256 |
| `<userData>/tmp/<jobId>.wav` \| `.ogg` | extracted audio | deleted on job completion and on shutdown |
| `<resources>/bin/…` | ffmpeg, ffprobe, whisper-cli, parakeet-cli | vendored, read-only |
| `<resources>/THIRD-PARTY-NOTICES.txt` | licences | reachable from the About panel |

Transcripts are not stored in `userData`. They are written where the user asked
for them — beside the source file, or in `OutputSettings.outputDir`.

---

## 8. Security model

The threat this app actually faces is not a targeted attacker. It is: a
malicious or malformed media file, a hostile provider response, and a
supply-chain substitution of a binary or a model. The renderer is where the
first two are parsed, so the renderer is the thing that is contained.

**Renderer containment.** `contextIsolation: true`, `sandbox: true`,
`nodeIntegration: false`, `webSecurity` on. The preload is CommonJS because a
sandboxed preload cannot be ESM — that is a platform constraint, not a style
choice. `contextBridge.exposeInMainWorld` publishes exactly one object,
`window.dropscribe`, typed by `DropScribeApi`. A `Content-Security-Policy` of
`default-src 'self'` is served with the renderer HTML. `will-navigate` and
`setWindowOpenHandler` deny everything.

**No arbitrary URL opening.** `openExternal` takes an `ExternalLinkId` —
`'repo' | 'issues' | \`provider-key:${ProviderId}\` | \`provider-docs:${ProviderId}\`` —
and main resolves the id to a URL from `PROVIDERS`. The renderer never supplies
a URL string. The alternative, `openExternal(url: string)`, turns any renderer
compromise into an arbitrary-URL opener, which on desktop reaches
`file://`, custom schemes, and whatever a helper app registered.

**No arbitrary path access.** Covered in §6.3. The one synchronous IPC channel
in the app, `files:authorize`, exists because a `drop` handler must decide
whether to accept within the event, and `sendSync` is the only way to do that.
It is the narrowest possible sync surface: one string in, one boolean out.

**Keys.** Encrypted at rest via `safeStorage`. Never sent to the renderer.
Never logged, never interpolated into an error message, never placed in a URL
that gets logged — including query strings, since URLs end up in logs and crash
reports far more often than headers do. `JobError.detail` carries provider error
bodies and ffmpeg stderr and is explicitly specified as redacted: adapters strip
any `Authorization` / `xi-api-key` header value before an error escapes.
`testProviderKey` deliberately does *not* save, so a mistyped key never reaches
the keychain at all.

**Network egress** is the four provider hosts, plus `huggingface.co` for model
downloads. No analytics, no telemetry, no update check in v1. The local
transcription path makes zero network requests once the model is on disk, and
that is a property worth stating in the README because it is the reason some
people will use this app.

**Supply chain.** Vendored binaries are fetched by `scripts/fetch-binaries.mjs`
from pinned URLs and verified against pinned SHA-256s; `vendor/bin/` is
gitignored, so the repo contains hashes rather than binaries. Model weights are
pinned the same way and re-verified in CI. Both are the same mechanism because
both are the same risk.

**What is explicitly not defended against:** a user who pastes a key into a
machine that is already compromised, and a malicious model file the user
downloads manually into `<userData>/models/`. Both are outside a local-first
app's control.

---

## 9. Error handling

```ts
export interface JobError {
  message: string;     // user-facing, shown verbatim
  detail?: string;     // engine stderr / provider body, behind a disclosure, redacted
  retryable: boolean;  // true when retrying unchanged could plausibly work
}
```

`message` is written for a person and shown as-is, which means it may not
contain a stack trace, a file path with a home directory in it, or a URL. It
says what failed and what to do. `detail` is for the bug report.

**Retryability is classified, not guessed.** HTTP 429 and 5xx, connection
resets, and DNS failures are retryable. 401, 402, 403 and 422 are not — retrying
a bad key produces a second bad key. Deepgram's 429 is treated as an ordinary
condition with exponential backoff and jitter rather than as an error, because
DeepInfra explicitly warns that a busy model returns 429 even under the
documented concurrency limit and that autoscaling resolves it **[probe]**.

**Provider error bodies come in incompatible shapes and the parser handles all
of them.** This is not defensive over-engineering; it was measured:

- Deepgram uses **three** shapes depending on the endpoint **[probe]**:
  `/v1/listen` returns legacy `{err_code, err_msg, request_id}`, `/v1/projects`
  returns modern `{category, message, details, request_id}`, and
  `/v1/auth/token` returns `text/plain` `Invalid credentials.`. Every response
  carries a `dg-request-id` header, which is logged because Deepgram's support
  triage depends on it.
- ElevenLabs and DeepInfra both use a top-level `detail`, but `detail` is an
  **object** for auth and runtime errors and an **array** of
  `{loc, msg, type}` for 422 validation errors **[probe]**. Code that assumes
  a string crashes on the validation path, which is exactly when you need the
  message.

**Progress is honest or absent.** `JobProgress.percent` is `number | null`, and
`null` is used rather than a fabricated value whenever the stage cannot measure
itself. The two real cases: a VBR MP3 with no Xing/VBRI header gives both
ffprobe and every in-process prober an extrapolated and possibly badly wrong
duration **[probe]**, so progress and any cost estimate degrade to
indeterminate; and cloud transcription is opaque after upload completes, so
`onProgress(null, 'Transcribing')` is what the adapter reports.

**Missing binaries fail loudly and early.** `enginesReady()` is false at launch
and the UI says which binary is missing and where it was expected, rather than
letting the first job die on `ENOENT`.

**Cancellation is not an error.** `'cancelled'` is its own terminal status.
`isTerminal()` covers `'done' | 'failed' | 'cancelled'`.

**Failure isolation.** One job's failure never touches another's. A provider
that stops responding fails its own jobs and leaves the local queue running.

---

## 10. Testing strategy

Vitest, two projects: **jsdom** for `electron/shared/**` and `src/**`, **node**
for main-process modules. No test in the suite makes a network call or spawns an
engine.

**Tier 1 — the pure core, tested exhaustively.** `electron/shared/` is where
the logic that can be wrong quietly lives, and it is testable with no Electron
at all. Priority order:

1. `formatTimestamp` and every millisecond conversion. Boundary cases at 0,
   at exactly 1000 ms, at an hour, and at a value whose float second
   representation is inexact. This is the highest-value test in the repo: the
   10× and 100× unit errors are silent, look plausible on a short clip, and are
   found by a user watching a film with subtitles crammed into the first twelve
   minutes.
2. `resegment` against reading-speed, line-length, max/min duration and
   gap-split rules, including the no-word-timings path that Parakeet and
   OpenRouter take.
3. `toSrt` / `toVtt` byte-exactness, including CRLF, cue numbering and the WebVTT
   header.
4. `normalizeTranscript`: out-of-range timestamps clamped to duration,
   zero-length hallucinated tail segments dropped, ordering restored.
5. `exportFileName`: `movie.mp4` + `srt` → `movie.srt`, and names containing
   dots, no extension, and Windows-illegal characters.

**Tier 2 — adapters, tested against recorded fixtures.** Every engine and every
provider gets a checked-in fixture of a real response body and a test asserting
the exact `Transcript` it produces. The fixtures are the specification of the
formats in §6.5 and §6.6 in executable form: a whisper.cpp JSON with special
tokens and leading-space word boundaries; a `parakeet-cli` `-ps` stdout capture
with the bracket timestamps; a Deepgram body with `punctuated_word` present
where its own OpenAPI says it is not; an ElevenLabs body with `type: 'spacing'`
and `type: 'audio_event'` entries among the words. Error-shape fixtures for all
three of Deepgram's error bodies and both of ElevenLabs' `detail` shapes.

**Tier 3 — main-process units in the node project.** `path-policy` rejects
non-media extensions, non-existent paths and directories, and
`assertAuthorized` throws for anything not previously authorized. `model-store`
rejects a file whose SHA-256 or byte count does not match and leaves no `.part`
behind. `credentials` round-trips through a `safeStorage` double and never
returns a key from a `ProviderState`.

**CI.** GitHub Actions on macOS and Windows: `npm run typecheck` (both
projects), `npm run lint` (`--max-warnings=0`, with `no-explicit-any` as an
error), `npm test`. `scripts/verify-model-catalogue.mjs` runs on a schedule
rather than per-commit, since it depends on a third party being up.

**What is deliberately not tested in v1, and why:** live provider calls (they
need credentials CI must not hold, and they cost money per run); end-to-end
Electron driving (Playwright against a signed Electron build is a project of its
own); real transcription accuracy (WER against a corpus is a model property, not
an app property). The manual release checklist covers these: one real file
through each of the three local models and each of the four providers, on both
platforms, before a tag.

---

## 11. Packaging and distribution

**Build.** `electron-vite` produces three bundles — main (ESM), preload (CJS,
forced by the sandbox), renderer. `npm run build` typechecks both TypeScript
projects first, because a type error that only surfaces in a packaged app is a
type error found by a user.

**Artefacts.**

| Platform | Targets | Notes |
|---|---|---|
| macOS arm64 | `.dmg`, `.zip` | Hardened runtime, signed, notarized, stapled |
| macOS x64 | `.dmg`, `.zip` | Same |
| Windows x64 | NSIS `.exe` | Signed **[unverified — certificate procurement is not yet done]** |

The `.zip` alongside the `.dmg` on macOS exists for future auto-update wiring
and for users who scriptedly install.

**Vendored binaries** live in `vendor/bin/<platform>-<arch>/`, are fetched by
`scripts/fetch-binaries.mjs` (a `postinstall` step) against pinned URLs and
SHA-256s, and are gitignored. `electron-builder` places them in
`Resources/bin` via `extraResources`, which is also why they do not need
`asarUnpack` — they are never inside the asar.

macOS specifics that are easy to get wrong: each vendored executable must be
signed with the same identity and with entitlements permitting a hardened-runtime
process to spawn it; the app needs `com.apple.security.cs.allow-jit` only for
Chromium, not for the engines; and notarization must include the binaries, not
just the app shell. Metal-accelerated inference in `whisper-cli` requires no
entitlement.

**Models are not bundled.** The recommended Whisper turbo model alone is 1.6 GB,
and large-v3 is 3.1 GB. Shipping them would quadruple an installer that most
users would then not use, since a cloud-only user needs no model at all. They
are downloaded on demand into `<userData>/models/`, resumable, verified, and
deletable from the UI.

**Licensing obligations, which are real work and not boilerplate:**

- **ffmpeg (LGPL v2.1).** Ship the LGPL text; publish the exact `configure` line
  and a matching source tarball or a written offer; credit FFmpeg in the About
  panel and on the download page. Built without `--enable-gpl` and without
  `--enable-nonfree` **[probe]**.
- **whisper.cpp (MIT)** and **Whisper weights (MIT)**: attribution.
- **Parakeet TDT 0.6B v3 (CC-BY-4.0)**: attribution to NVIDIA is a *condition of
  the licence*, and it attaches to the weights themselves, so it follows them
  through the GGML conversion **[probe]**. It appears in the About panel.
- All of the above are assembled into `THIRD-PARTY-NOTICES.txt`, reachable from
  the app via `licenseNoticePath()` and `getLicenses()`.

**Auto-update is not wired in v1** (§12). `electron-updater` is present in
`dependencies` from the scaffold; it is dead weight until v2 and is called by
nothing. Releases in v1 are GitHub Releases that the user downloads.

---

## 12. Out of scope for v1

Each of these was considered and cut. The reason matters more than the fact,
because "not yet" and "not ever" are different answers.

**Realtime microphone capture.** Not ever, in this app. DropScribe's premise is
a file that already exists. Live dictation is a different product with a
different UI, different latency requirements and a different model tier —
Parakeet v3 is offline-only in every backend, and true streaming means
`parakeet-unified-en-0.6b`, which is English-only and throws away the entire
multilingual reason for choosing v3 **[probe]**.

**Streaming partial results into the UI.** Not yet. Both engines can emit
segments as they go and the queue could forward them, but the transcript data
model, the auto-export and the re-segmenter all assume a complete transcript.
Partial results would mean a second, mutable path through all three. The
progress percentage carries the "it is working" signal in v1.

**Translation between arbitrary language pairs.** Not ever, here. What v1
supports is what the engines support: translation *to English*, via
`whisper-cli -tr` and the equivalent provider flag. Arbitrary pairs mean a
translation model, which is a second class of model, a second download, a second
licence and a second quality axis. Users who want French→German should run the
transcript through a translator.

**A transcript editor.** Not yet, and it is the most likely v2 feature. An
editor means an undo stack, a persistence format, dirty-state handling on quit,
and word-level selection tied to timings — a larger surface than everything in
§6 combined. v1 renders a preview and exports; corrections happen in the user's
subtitle editor of choice.

**Auto-update.** Not yet. It requires a signed update feed, a code-signing
certificate on Windows we do not yet have **[unverified]**, and a rollback story.
A wrong auto-update is worse than no auto-update.

Also out of scope, less prominently: local speaker diarization (neither
`whisper-cli` nor `parakeet-cli` diarizes **[measured]**, so diarization is a
cloud-only capability in v1 and the toggle is disabled for local targets); batch
folder watching; a CLI; Linux packaging; and any per-provider tuning knob beyond
`CloudOptions` (`language`, `diarize`, `wordTimestamps`, `translate`).

---

## 13. Open risks

Ordered by expected cost, not by likelihood.

**R-1 · `parakeet-cli`'s output format is a human-readable string, not a
contract.** With `-ps` it prints `[00:00:00.000 --> 00:00:05.040]  text` on
stdout **[measured]**, and there is no JSON alternative. A future whisper.cpp
build can change that line without it being a breaking change to anything they
promise. *Mitigation:* the parser is fixture-tested against the exact b4938
output; it tolerates whitespace variation; when zero lines parse it falls back
to treating stdout as one whole-file segment rather than failing; the vendored
binary is pinned by SHA-256 so the format cannot change without a deliberate
version bump on our side.

**R-2 · Parakeet produces no word timings through this path.** `-ps` gives
segment-level bracket timestamps only **[measured]**, and Parakeet's timestamps
are token-level (BPE subword) even where a backend exposes them **[probe]**.
Subtitles re-segmented from segment boundaries are visibly worse than ones
re-segmented from word boundaries. *Mitigation:* `hasWordTimings()` is false and
`resegment` takes its documented degraded path; the UI states which models give
word timings before the user picks one; Whisper remains the recommended default.

**R-3 · Deepgram's 10-minute processing ceiling versus our no-chunking
decision.** Requests exceeding 10 minutes of *server-side processing* (20 for
Whisper models) return 504 **[probe]**, and because it is wall-clock processing
time rather than audio duration, no client-side length cap avoids it reliably.
Deepgram does not store transcripts and has no fetch-result-later endpoint
**[probe]**, so a 504 loses both the transcript and the money. *Mitigation for
v1:* classify 504 as retryable, say so in the error message, and name the
condition explicitly ("Deepgram timed out processing a file this long"). *Fix in
v2:* VAD-aligned chunking with per-chunk offset stitching, which is also the fix
for R-4.

**R-4 · DeepInfra documents no maximum file size or duration anywhere.**
Searched across its full 310 KB OpenAPI spec, its docs index and its per-model
documentation: nothing **[probe]**. It is therefore **[unverified]** whether our
~10.8 MB two-hour upload is inside the limit. *Mitigation:* the Opus encode
keeps us an order of magnitude below every documented cap in the industry, so
the practical risk is low; a 413 is classified retryable-after-chunking and the
error message says so.

**R-5 · OpenRouter is the one provider that was never probed.** Its auth header,
its key-test endpoint, its model list and its audio request shape are all
**[unverified]**, and the likely mechanism — audio as an `input_audio` content
part on a chat-completions call — returns plain text with no timings.
*Mitigation:* implement it last, against a live key, and treat the first
implementation as provisional; ship it producing a single whole-file segment
with `hasWordTimings()` false; state in the provider blurb that OpenRouter gives
text without timings. If a live probe shows the audio path is not viable at all,
OpenRouter ships as text-only or is cut, and that is a decision the owner makes
with data rather than one this document guesses at.

**R-6 · The renderer has no sanctioned way to turn a dropped `File` into a
path.** Electron 32 removed the non-standard `File.path`; the replacement,
`webUtils.getPathForFile(file)`, is available only in the preload. `DropScribeApi`
as currently written exposes `authorizePath(path: string)` but nothing that
produces that string. *Mitigation:* the contract must grow one method —
`pathForFile(file: File): string`, implemented in the preload over
`webUtils.getPathForFile` — or the preload must install the `dragover`/`drop`
listeners itself. This is a genuine gap in the interface as specified, it blocks
R1, and it is recorded here rather than resolved silently in an implementation.

**R-7 · There is no redistributable prebuilt ffmpeg for macOS arm64.** BtbN
publishes no macOS builds; evermeet.cx is x86_64-only and `--enable-nonfree`
(nobody may redistribute it); osxexperts.net is GPL-with-x265 under an
"educational purposes only" disclaimer **[probe]**. Any plan that says "download
a static ffmpeg" fails on the single most likely platform for this app.
*Mitigation:* build our own LGPL audio-only ffmpeg in CI for all three targets,
publish the configure line and the source, pin the resulting binaries by
SHA-256. The owner's existing Electron media app has already solved this once,
which is §4.1's decisive argument.

**R-8 · Vendor documentation contradicts vendor specs, repeatedly.** ElevenLabs'
OpenAPI says 5.0 GB while its own capabilities page says 3 GB **[probe]**;
Deepgram's docs say 100 concurrent pre-recorded requests while its rate-limit
reference says 50 **[probe]**; DeepInfra lists three mutually inconsistent sets
of supported audio formats across three of its own pages **[probe]**. *Mitigation:*
design to the *most conservative* number in every case, never codegen a client
from a published spec, and keep the fixture tests as the real contract.

**R-9 · Model catalogue drift.** A Hugging Face re-upload changes the SHA-256
and every download starts failing integrity verification. *Mitigation:*
`scripts/verify-model-catalogue.mjs` on a schedule turns that into a CI failure
we see before users do, and the failure mode is a refused download with a clear
message rather than a corrupt model.

**R-10 · Whisper large-v3 on a modest machine.** 3.1 GB download, ~3.4 GB
resident **[measured — catalogue figures]**, and a real-time factor that makes a
two-hour film a long wait. *Mitigation:* `LocalModel.approxRamMb` drives a
pre-flight warning against actual system memory; the quantized 5-bit variants
are in the catalogue precisely for this; turbo is the recommended default and
large-v3 is presented as the deliberate slow-and-accurate choice.

**R-11 · Electron's update treadmill.** Accepted, not mitigated. Shipping
Chromium means shipping its CVEs, and with no auto-update in v1 (§12) a user on
an old build stays on it. This is the cost side of §4.1 and it is stated so that
v2's auto-update work is understood as security work rather than convenience
work.
