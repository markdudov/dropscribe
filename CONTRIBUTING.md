# Contributing to DropScribe

Thanks for being here. DropScribe is a small app with a narrow promise — drop a
media file, get a transcript, with no account and no upload you did not ask for —
and the point of this document is to make it cheap to contribute without eroding
that promise.

If you are opening an issue rather than a pull request, the
[issue forms](.github/ISSUE_TEMPLATE) ask for what is needed; anything vaguer
than a bug belongs in
[Discussions](https://github.com/markdudov/dropscribe/discussions).

---

## Setting up

**Node 22.** Not 20, not 24. electron-vite 5 and the Electron 43 toolchain are
built against Node 22's module resolution, and the failure mode on an older Node
is a confusing ESM error in `scripts/dev.mjs` rather than an honest version
complaint. `nvm use 22` or equivalent, then:

```bash
git clone https://github.com/markdudov/dropscribe.git
cd dropscribe

npm ci                    # not `npm install` — see below
npm run binaries:fetch    # ffmpeg, ffprobe, whisper-cli, parakeet-cli
npm run dev               # electron-vite dev server + the Electron main process
```

`npm ci` rather than `npm install`, because the lockfile pins Electron to an
exact version (`43.4.0`, no caret) and `npm install` is free to drift the rest of
the tree around it. A reproducible dev environment is the only way a "works on my
machine" report is ever worth anything.

`npm run binaries:fetch` downloads the four native binaries the app shells out
to, verifies them against recorded hashes, and drops them in
`vendor/bin/<platform>-<arch>/`, which is gitignored. It runs automatically as a
`postinstall`, so on a clean `npm ci` you usually do not need it — run it by hand
when you installed with `--ignore-scripts`, when the download failed behind a
proxy, or after switching architecture. Nothing about transcription works without
it: `ffmpeg` is what turns whatever container you dropped into the 16 kHz mono
WAV both engines actually consume.

Local models are *not* fetched at setup. They are large, they are per-user, and
the app downloads them on demand into `<userData>/models/` from the Models pane.
For dev you generally want one small quantized model and nothing else.

To exercise a cloud provider you need your own key, entered in the running app's
Settings pane. **Never put a key in a `.env`, a fixture, or a test.** The app
stores keys through Electron's `safeStorage` for a reason, and a key on disk in
the repo is one `git add -A` away from being public forever.

---

## The three checks

```bash
npm test && npm run typecheck && npm run lint
```

All three must pass before a pull request is ready. CI runs exactly these and
nothing weaker, so a green local run means a green CI run.

- **`npm test`** — vitest. Pure logic only: transcript normalization, subtitle
  segmentation, export rendering, path policy, the adapter parsers. Fast, no
  network, no binaries, no Electron.
- **`npm run typecheck`** — `tsc --noEmit` over both project configs (main/preload
  and renderer). The config is strict, with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`, and `any` is an eslint error rather than a style
  preference. If a type is genuinely unknown, use `unknown` and narrow it — the
  provider adapters exist precisely because three different JSON error shapes
  need narrowing in exactly one place each.
- **`npm run lint`** — eslint with `--max-warnings=0`. A warning that is allowed
  to accumulate is a warning nobody reads.

What the three checks cannot do is run ffmpeg on a real file, launch an engine
binary, or make a network call. So they are the floor, not the ceiling: before
you open a PR, put a real file through the path you changed and say so in the
description. The PR template asks which OS, which target and which container,
because that is what a reviewer cannot recover from the diff.

---

## The documentation contract

This is the part most often skipped and the part that decays the repo fastest, so
it is a rule rather than a suggestion.

**A behaviour change updates `docs/` in the same pull request.**

If a user could notice the difference — a new export format, a changed default, a
different error message, a provider option that now does something else — then
some page under `docs/` is now false. Fix it in the PR that made it false. Docs
updated "in a follow-up" describe an app that no longer exists, and the follow-up
is written by someone who has to reconstruct the reasoning from the diff.

**A non-trivial bug fix gets a `docs/bugs/NNNN-slug.md`.**

Take the next unused number in `docs/bugs/`, zero-padded to four digits, and give
the file a slug that names the *cause*, not the symptom:
`docs/bugs/0007-whisper-token-leading-space.md`, not `0007-bad-words.md`.

The note should be short and should answer:

1. **What was observed** — the user-visible symptom, in the words a report used.
2. **What was actually wrong** — the real cause, at the level of the specific
   line or the specific assumption. "whisper.cpp token `text` carries its own
   leading space, and we were trimming before deciding word boundaries."
3. **Why the code was written that way in the first place** — this is the
   valuable part, and the one that stops the bug's siblings. A bug that looked
   reasonable when it was written will look reasonable again to the next person.
4. **How it is now prevented** — usually a regression test; name it.

"Non-trivial" means: it took more than a minute to find, or it could plausibly
recur in another adapter, another engine, or on the other platform. A typo in a
label does not need a file. A rounding error in one adapter's timestamp
conversion absolutely does, because there are five other adapters converting
timestamps.

Every bug fix, trivial or not, also needs a test that fails without the fix.

---

## Commit messages

```
area: imperative summary under ~70 characters

Body, wrapped at 72, explaining WHY. What changed is already in the diff;
what the reviewer cannot reconstruct is the alternative you rejected and
the reason you rejected it.

Fixes #123
```

`area` is the part of the tree you touched, lowercase, slashes allowed:

```
providers/elevenlabs: send enable_logging=false on every request
engines/whisper: treat a leading space as the word boundary
shared/subtitles: round cue ends up, never down
transcribe/queue: cancel the ffmpeg child before the engine child
ui/settings: show only the last four characters of a stored key
docs: document the model download directory
chore(deps): bump the npm minor-and-patch group
build: pin electron to 43.4.0
```

Imperative mood — "add", "fix", "move", not "added" or "fixes". The convention is
"this commit will *fix the leak*", and it keeps `git log --oneline` readable as a
list of changes rather than a diary.

One logical change per commit. A refactor and the bug fix it enables are two
commits, because in six months exactly one of them will need to be reverted.

---

## Finding your way around

Read [`docs/README.md`](docs/README.md) first — it is the map, and it is kept
current as part of the documentation contract above. The one-paragraph version:

- **`electron/shared/`** — the pure core. Transcript and subtitle types,
  segmentation, export rendering, the model and provider catalogues, the media
  extension list. These files **must not import from `node:` or `electron`**:
  the renderer bundles them and the jsdom tests compile them, so a single `import
  'node:path'` here breaks both. This is where most of the interesting logic
  lives and where most tests point.
- **`electron/` (outside `shared/`)** — the main process. Path policy, ffmpeg and
  ffprobe, the local engine runners, the cloud provider adapters, the job queue,
  credential and settings storage. Node and Electron APIs are free to use here.
- **`electron/preload/`** — the only bridge. It exposes one frozen API object over
  `contextBridge`; the renderer has no node integration and no direct `ipcRenderer`.
- **`src/`** — the React renderer. It knows nothing about files, engines or
  providers beyond what the preload API hands it.

Two invariants that cut across everything and are worth internalizing before you
write a line:

1. **All transcript time is integer milliseconds**, converted exactly once at the
   adapter boundary with `Math.round`. Never truncate, and never let a float
   second past an adapter. `electron/shared/transcript.ts` explains the reasoning
   at length.
2. **The main process authorizes every file path** against an allowlist before
   anything opens it. The renderer can ask for a path; it can never assert one.
   A renderer-supplied path that main trusts is the whole attack surface of a
   drag-and-drop app.

---

## Pull requests

Fork, branch, open the PR against `main`. Fill in the template — particularly
what you actually ran the change against. Small and focused merges fast; a PR
that fixes a bug, renames three files and adds a feature will sit.

Contributions are accepted under the [MIT License](LICENSE), the same terms the
project ships under. By contributing you agree your work is licensed that way.

Everyone participating here is bound by the
[Code of Conduct](CODE_OF_CONDUCT.md). Found something that looks like a security
problem? Do not open an issue — [`SECURITY.md`](SECURITY.md) says how to report it
privately.
