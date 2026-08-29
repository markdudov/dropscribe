# Architecture overview

## What the app is

A desktop app that takes media files you drop on it and gives you back the words
in them — as a transcript, as subtitles, as JSON — using either a model running
on your own machine or an API you already pay for.

Three constraints shape everything below.

**The source file is enormous and the renderer must never touch it.** A feature
film is gigabytes; nothing outside the main process ever holds one, and nothing
anywhere holds one whole. What crosses into the renderer is a job row, a
progress percentage and — once, at the end — a transcript.

**Every binary the app executes ships with it.** No Python, no ONNX Runtime, no
`ffmpeg` on `PATH`. A homebrew ffmpeg is a *different build* with a different
codec set, and the extraction step has to produce the same 16 kHz mono WAV on
every machine or the engines quietly disagree between users. Only the model
weights are fetched at run time, and only when the user asks.

**The user's key is the user's key.** There is no account, no proxy, no server
of ours anywhere in the picture. The app is a client for services the user
already has, and it has nowhere to send a key even if it wanted one.

## Process model

```
┌─ Main process (Node) — owns all truth ────────────────────────────────────┐
│  electron/main.ts        window, menu, IPC registration, startup sweep     │
│  electron/path-policy.ts the allowlist every renderer-named path must pass │
│  electron/binaries-runtime.ts   where the vendored executables actually are│
│  electron/ffmpeg.ts      ffprobe + ffmpeg: probe / extract / compress      │
│  electron/transcribe/    the queue — the only place a Job ever changes     │
│  electron/engines/       whisper-cli · parakeet-cli   (whisper.cpp b4938)  │
│  electron/providers/     DeepInfra · Deepgram · ElevenLabs · OpenRouter    │
│  electron/services/      credentials · settings · model-store · temp · log │
│  electron/shared/        PURE — no node, no electron. Both projects use it │
└───────────────────────────────────────────────────────────────────────────┘
        ▲  jobs:updated · models:updated       │  window.dropscribe.*
        │  (the only two main → renderer)      ▼
┌─ contextBridge — electron/preload.ts (CommonJS) ──────────────────────────┐
│  exposeInMainWorld('dropscribe', api) — one object, and only this one     │
│  its type is DropScribeApi in electron/api-types.ts                       │
│  webUtils.getPathForFile — the only way a dropped File becomes a path     │
└───────────────────────────────────────────────────────────────────────────┘
        ▲                                      │
        │                                      ▼
┌─ Renderer (sandboxed, context-isolated) ──────────────────────────────────┐
│  src/ui/store/     zustand — a MIRROR of main's jobs and models           │
│  src/ui/           drop zone · job list · model manager · provider setup  │
│  src/ui/i18n/      the closed set of strings the app can say (en, bg)     │
│  src/core/         pure renderer-side helpers                             │
│  @shared/*         the same pure modules main uses — exports, subtitles,  │
│                    transcript, languages, media-extensions                │
│                                                                           │
│  Has NOT: node, fs, net, an API key, or a path it can act on directly     │
└───────────────────────────────────────────────────────────────────────────┘

Main, and only main, reaches anything outside the app:

  spawn ─▶  ffmpeg · ffprobe             argv arrays, never a shell string;
                                         progress on stdout (-progress pipe:1)
  spawn ─▶  whisper-cli · parakeet-cli   run where they sit in binDir();
                                         progress and tokens on stderr
  https ─▶  api.deepinfra.com · api.deepgram.com ·
            api.elevenlabs.io · openrouter.ai
                                         the user's own key, in a header
  https ─▶  huggingface.co               model weights, on demand, hash-checked
```

The renderer runs with `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`. It reaches the outside world only through `window.dropscribe`,
whose shape is declared once in `electron/api-types.ts` and compiled by **both**
TypeScript projects — see [ipc-and-security.md](ipc-and-security.md).

The preload is CommonJS because a sandboxed preload cannot be ESM. That is a
platform constraint expressed in `electron.vite.config.ts`, not a style choice,
and the comment there says so.

## The life of one job

1. **The file arrives.** Either from the native picker (`files:open`, which
   returns paths main has already authorized) or from a drop. A dropped `File`
   carries no path in a sandboxed renderer — Electron 32 removed that
   augmentation — so the drop handler asks the bridge for one with
   `pathForFile(file)`, which is not IPC at all: `webUtils` exists only in the
   preload, and the value is already attached to the object. Then it calls
   `authorizePath(path)`, which *is* IPC and is **`sendSync`**, because a `drop`
   handler has to decide inside the event, before the `DataTransfer` is gone.
   That one channel is the whole synchronous surface of the app: one string in,
   one boolean out.

2. **`authorize` vets it** (`electron/path-policy.ts`). Absolute path, media
   extension, `realpathSync`, media extension again *on the resolved path*, a
   `statSync` that must say regular file, and `R_OK`. What is recorded is the
   **real** path, not the string that came in. Anything that fails is not a job:
   the renderer is told how many of its paths were accepted and says so once.

3. **`jobs:enqueue(paths, target)`** hands the accepted paths to
   `createQueue()` in `electron/transcribe/queue.ts`, which re-authorizes them
   (`authorizeAll`), mints a `randomUUID` per job — a counter would restart at 1
   each launch and inherit the scratch directory a crashed session left behind —
   and starts as many as `settings.maxConcurrentJobs` allows. The default is 1,
   because local inference is memory-bound rather than CPU-bound.

4. **ffprobe measures the file.** `probe()` in `electron/ffmpeg.ts` reads
   duration, codec, sample rate and channels, and falls back to a second
   `-select_streams a:0` pass for the containers that carry no duration at all.
   A file with no audio track is refused *here*, in a sentence naming the file,
   rather than two seconds later inside an ffmpeg stream-mapping error. The path
   is re-checked with `assertAuthorized` first: a job can sit behind a feature
   film for an hour, and this is the moment the file is actually opened.

5. **The audio is cut down to what the target can eat**, into a scratch
   directory `jobTempDir(job.id)` under the OS temp root.
   - *Local:* `extractWav16k` → 16 kHz mono 16-bit WAV. Not an optimization —
     whisper.cpp resamples to exactly this internally, so anything else only
     moves the same work into a process with worse error reporting. `-map 0:a:0`
     picks the first audio stream, because letting ffmpeg choose by channel count
     transcribes the 5.1 commentary track of some discs. Progress comes from
     `-progress pipe:1` on stdout and is mapped onto the first 15 % of the job's
     bar.
   - *Cloud:* `compressForUpload` → ~12 kbps mono Opus in Ogg, about 1.6 MB for
     three hours. These APIs charge by audio duration and decode server-side, so
     the only thing size costs is the user's upload time — which is precisely
     what dominates the wall clock on a film. An MP3 fallback covers an ffmpeg
     build without libopus, detected by trying rather than by parsing
     `ffmpeg -encoders`.

6. **The engine or the adapter runs.**
   - `engineFor(model.engine).run(...)` spawns `whisper-cli` or `parakeet-cli`
     from `binDir()` — never a copy elsewhere, because on Windows the `.exe`
     resolves its DLLs from its own directory.
   - `adapterFor(providerId).transcribe(...)` uploads the Opus file with the
     user's key in a header, never in a query string.

   Both are handed the ffprobe duration rather than asked for one, and both
   convert their own time units to integer milliseconds before returning.

7. **`normalizeTranscript` runs.** Each adapter calls it on the way out; the
   queue calls it again after replacing the engine's idea of the duration with
   ffprobe's and stamping `createdAt`. It is idempotent — round, clamp to the
   duration, drop empty segments, sort by start — which is what makes the second
   call free and the invariant below enforceable in one place.

8. **Auto-export.** `renderTranscript` (`electron/shared/exports.ts`) formats the
   transcript into each format in `settings.output.formats`, and the queue writes
   them beside the source or into the configured folder. Writes use the `wx`
   flag and fall back to `name (2).srt`: the queue never overwrites, because the
   file it would destroy is the one the user hand-corrected, `writeFile`
   truncates in place rather than sending anything to the Trash, and there is no
   undo anywhere in this chain. This step runs **after** the job is marked done,
   so a read-only output folder costs the export files and not the transcript.

9. **The scratch directory goes away**, in a `finally`, on every path including
   cancellation — a two-hour film leaves ~230 MB of WAV or ~10 MB of Opus behind
   otherwise. Everything the unhappy paths miss (a crash, a force quit, a lost
   power supply) is collected by `sweepOrphanedTemp()` at the next launch, which
   deletes job directories untouched for 24 hours. An age cutoff rather than
   "delete everything at startup", because a second copy of the app may be forty
   minutes into a film whose WAV lives in the very root being cleared.

Every state change in steps 3–9 goes out as one `jobs:updated` event carrying a
**copy** of the job. The queue never hands out the object it is still mutating:
the renderer's previous and next job would be the same reference, every memoized
selector would see no change, and the row would stop repainting at whatever
percentage it happened to be on.

## Time domains

**All transcript time is integer milliseconds, and the conversion happens
exactly once, at the adapter boundary.** Nothing downstream of an adapter ever
sees a float second.

The reason is arithmetic rather than taste: `14.3 * 1000` is
`14299.999999999998` in binary floating point. An exporter that floors that
loses a millisecond on every cue, and the errors are not symmetric — they
accumulate in the direction of "the subtitle appears too early", forever. Round
once, at the edge, where the engine's own precision is still known, and every
later stage is exact integer arithmetic.

| Source | What it actually speaks | Where it is converted |
| --- | --- | --- |
| `whisper-cli -oj` → `transcription[].offsets.from/to` | **already integer ms** | `engines/whisper-cpp.ts` reads them unscaled. Multiplying by 10 here is the classic mistake — that factor belongs to the C API's `t0`/`t1`, a different interface |
| `whisper-cli` JSON `timestamps` (`"00:00:05,040"`) | strings, for humans | never parsed |
| `parakeet-cli -ps` → `t0`, `t1` | **centiseconds** | `engines/parakeet-cpp.ts`, `× 10` |
| DeepInfra, OpenRouter (`verbose_json`), Deepgram, ElevenLabs | fractional seconds | each adapter under `electron/providers/`, `Math.round(seconds * 1000)` |
| ffprobe `format=duration` / `stream=duration` | fractional seconds | `probe()` in `electron/ffmpeg.ts` |
| `Job.startedAt` / `finishedAt` / `Transcript.createdAt` | wall clock | `Date.now()` / ISO string in the queue — a different clock entirely, and never mixed with media time |

Rules that follow:

- **`normalizeTranscript` in `electron/shared/transcript.ts` is the single
  funnel.** It rounds, clamps every word and segment into `[0, durationMs]`,
  drops segments that carry neither text nor words, and sorts by start. Its
  `Math.round` is deliberate: truncation would bias every timestamp one way.
- **ffprobe owns the duration, not the engine.** Whisper's own figure comes from
  its padded final decode window and runs past the end of the audio. The queue
  is the only party holding both numbers, so it is the one that overwrites.
- **A duration of `0` means "unknown", not "empty".** Some containers do not
  record one and are still perfectly decodable. `normalizeTranscript` treats zero
  as "do not clamp", progress goes indeterminate, and the transcript is still
  right — a better trade than refusing a file ffmpeg can plainly read.
- **Subtitle cue times are formatted from integers**, by `formatTimestamp` in
  `electron/shared/subtitles.ts`. No exporter does its own division.

## Where state lives

| State | Owner | Lifetime | Notes |
| --- | --- | --- | --- |
| Jobs, and the transcripts attached to them | the closure inside `createQueue()` (`electron/transcribe/queue.ts`) | the process | Never persisted. A relaunch is an empty queue, which is honest: the temp files are gone too |
| Authorized paths | a module-level `Set` in `electron/path-policy.ts` | the process | Never pruned — an entry has to outlive a retry hours later, and a path string is a hundred bytes |
| Settings and per-provider model lists | `<userData>/settings.json`, cached in `electron/services/settings.ts` | disk | Written temp-then-rename; loaded with per-field fallback so a downgrade costs one setting, not all of them |
| API keys | `<userData>/credentials.json`, ciphertext only, plus a plaintext `Map` in `electron/services/credentials.ts` | disk / the process | The plaintext cache exists so a queue of files does not prompt for the keychain once per job |
| Model weights | `<userData>/models/`, named by `LocalModel.fileName` | disk | Partial downloads sit beside them as `.part` and survive a cancel on purpose |
| In-flight downloads | the `active` map in `electron/services/model-store.ts` | the process | Progress is emitted at most every 250 ms |
| Scratch audio | `<os tmpdir>/dropscribe/<jobId>/` | one job | Swept at startup with a 24-hour cutoff |
| Running child processes | a module-level `Map` in `electron/ffmpeg.ts`, plus each engine's own child | the process | Registered so `will-quit` and `process.exit` take them with it |
| Whether this ffmpeg build has libopus | a module-scope latch in `electron/ffmpeg.ts` | the process | A property of the build, so it is answered once |
| The log | `<userData>/logs/dropscribe.log` (+ `.1`) | disk | Rotated at 2 MB; every field passes through `redact` |
| Everything the UI draws | one zustand store under `src/ui/store/` | the window | A **mirror**, not an authority — see [state-and-store.md](state-and-store.md) |

## Module map

Every file under `electron/`. The three-line rule for the whole directory: files
in `shared/` may not import `node:` or `electron`, everything else may, and
`api-types.ts` sits with `shared/` on that question because both projects
compile it.

| Path | Responsibility |
| --- | --- |
| `electron/main.ts` | The window, the menu, IPC handler registration, the startup temp sweep, and the shutdown that takes the queue and its children with it |
| `electron/preload.ts` | The single `contextBridge` object, and `webUtils.getPathForFile` for drops |
| `electron/api-types.ts` | `DropScribeApi` and every type that crosses the bridge. Compiled by both projects, so main, preload and the renderer cannot drift |
| `electron/path-policy.ts` | The path allowlist. `authorize` / `isAuthorized` / `assertAuthorized` / `authorizeAll`, all resolving symlinks on both sides |
| `electron/binaries-runtime.ts` | Where the vendored executables are, in dev and packaged, plus `enginesReady()` and the licence-notice path |
| `electron/ffmpeg.ts` | `probe`, `extractWav16k`, `compressForUpload`, the child-process registry, and the argv-not-shell rule |
| `electron/transcribe/queue.ts` | The job state machine. The only file that knows what a job is, owns a temp directory, or decides what a failure means |
| `electron/engines/types.ts` | `LocalEngine` — what the queue sees, so it never learns which binary it is driving |
| `electron/engines/index.ts` | `engineFor(id)`, a `Record<EngineId, …>` so a new engine id is a compile error here |
| `electron/engines/whisper-cpp.ts` | `whisper-cli`: `-oj` JSON in, tokens assembled into words, progress read off **stderr** |
| `electron/engines/parakeet-cpp.ts` | `parakeet-cli`: per-token `-ps` lines off **stderr**, centiseconds ×10, `word_start` taken as authoritative |
| `electron/engines/chunking.ts` | Pure chunk planning and stitching for long inputs. Written, unit-testable and deliberately **not wired into the queue in v1** — see the file header for why Whisper needs it and Parakeet does not |
| `electron/providers/types.ts` | `ProviderAdapter`, plus the shared `abortableFetch` / `assertOk` / `readErrorMessage` / `fileToBlob`, so one broken Wi-Fi produces one error message and not four |
| `electron/providers/index.ts` | `adapterFor(id)`, the same closed-record trick as `engines/index.ts` |
| `electron/providers/deepinfra.ts` | The OpenAI-shaped route, `verbose_json`, and the `Bearer ` prefix that is not optional |
| `electron/providers/deepgram.ts` | Three endpoints, three error dialects, and the `Token` auth scheme rather than `Bearer` |
| `electron/providers/elevenlabs.ts` | Scribe: `xi-api-key`, `enable_logging` as a **query** parameter, `tag_audio_events` turned off |
| `electron/providers/openrouter.ts` | The first-class `/audio/transcriptions` route, base64 JSON upload, `verbose_json` |
| `electron/services/credentials.ts` | `safeStorage` encryption, the refusal to fall back to plaintext, and `keyPreview` |
| `electron/services/settings.ts` | `<userData>/settings.json`: atomic writes, per-field coercion, and the per-provider records |
| `electron/services/model-store.ts` | Resumable, hash-verified model downloads; `.part` files; delete |
| `electron/services/temp.ts` | Per-job scratch directories, the never-throwing cleanup, and the startup sweep |
| `electron/services/logger.ts` | One line format, one rotation policy, and `redact` — the chokepoint that keeps a key out of a file users are asked to attach to issues |
| `electron/shared/transcript.ts` | `Transcript` / `Segment` / `Word` and `normalizeTranscript`. The millisecond invariant lives here |
| `electron/shared/subtitles.ts` | `resegment` and the SRT/WebVTT writers. A recognizer's segments are not cues |
| `electron/shared/exports.ts` | `renderTranscript` for all six formats, and `exportFileName`. Pure, so the preview and the written file are the same string |
| `electron/shared/jobs.ts` | `Job`, `JobStatus`, `JobError`, `TranscribeTarget`, `isTerminal` |
| `electron/shared/models.ts` | The local model catalogue, pinned by byte count and SHA-256 |
| `electron/shared/providers.ts` | The four provider descriptors and `CloudOptions` |
| `electron/shared/languages.ts` | One spelling of every language code, converted at each adapter's edge — the same discipline `transcript.ts` applies to time |
| `electron/shared/media-extensions.ts` | What a drop may be, so the "no" arrives immediately rather than from ffmpeg |

The renderer is laid out by directory rather than by file, and the directory is
the contract:

| Path | Responsibility |
| --- | --- |
| `src/index.html` | The renderer entry point named by `electron.vite.config.ts` |
| `src/ui/` | React components — drop zone, job list, transcript preview, model manager, provider settings. Nothing here calls IPC except through the store |
| `src/ui/store/` | The one zustand store and its slices. The only place application state lives; the composition root there is the single import path |
| `src/ui/i18n/` | `en.ts` is the closed set of strings the app can say; `keyof typeof en` is what makes a hole in `bg.ts` a compile error rather than an `undefined` on screen |
| `src/core/` | Pure renderer-side helpers that are not shared with main |
| `src/types/` | Ambient declarations, including the one that puts `window.dropscribe` in scope |
| `src/assets/` | Static assets bundled into the renderer |

The list of *files* under `src/` is deliberately not reproduced here — it moves,
and a stale table is worse than no table. `tsconfig.web.json` and the store's own
documentation are the authorities.


## The header carries two controls and no title

There is no app name in the header. The window is the only window, its content
says what it is, macOS carries the name in the Dock and the menu bar, and Windows
carries it in the native title bar above the row. A word that is never the answer
to a question the user is asking was simply the widest thing on the strip.

Where the two controls sit is a platform question, not a taste one: **they go
opposite the operating system's own window buttons.** macOS draws its traffic
lights top-left, so the target picker and the gear go right; Windows and Linux
draw minimise/maximise/close top-right, so they go left. Reaching for the same
corner as the OS is how a settings gear ends up a few pixels from a close button.

Both rules live in `src/index.css` — `.titlebar-inset` and `.header-controls` —
keyed off a `data-platform` attribute that `src/main.tsx` sets from
`navigator.platform` before React's first frame. Reading it from `getAppInfo()`
instead would leave the layout wrong for the length of an IPC round trip, which
is visible as a jump on every launch. It is CSS rather than a branch in
`App.tsx` because a component that re-orders its own children by platform is one
every future edit has to remember to keep symmetrical, and because
`margin-inline` does the right thing under a right-to-left locale.

Windows keeps its native frame today (only macOS gets `titleBarStyle:
'hiddenInset'`, see `createWindow` in `electron/main.ts`), so its buttons are in
a bar above this row rather than over it. The layout is the one that stays
correct if that ever changes.
