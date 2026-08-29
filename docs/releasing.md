# Releasing DropScribe

There are two release lifecycles in this repository and they move at completely
different speeds.

**App releases** are tagged `v0.1.0`, `v0.2.0`, and so on. They are what users
download. Cutting one is a version bump, a tag push, and then waiting for CI.

**Engine releases** are tagged `engines-<upstream-ref>`, for example
`engines-b4938`. They exist only to hold the whisper.cpp binaries that app
releases pin. They are cut when whisper.cpp is bumped — a handful of times a
year at most — and never as part of a normal app release.

Most releases touch only the first. If you have not changed
`vendor/binaries.json`, skip straight to [Cutting a version](#cutting-a-version)
and ignore everything about engines.

---

## Before you bump

None of this is automated, on purpose: a release note written by a script reads
like one.

1. **Move `CHANGELOG.md`'s `[Unreleased]` section into a new version heading**
   with today's date, and fix the two link definitions at the bottom — the
   `[Unreleased]` compare link now points at the new tag, and the new version
   gets its own release link.
2. **Rewrite `RELEASE_NOTES.md`.** This file is the body of the GitHub release,
   verbatim. It is not the changelog: the changelog is for someone deciding
   whether to upgrade, `RELEASE_NOTES.md` is for someone who has never heard of
   this app and just clicked a download link. It must still carry the unsigned
   build warning — see [The words about the missing signature](#the-words-about-the-missing-signature).
3. **`npm run lint && npm run typecheck && npm test`** locally. CI runs these
   too, but finding out after the tag exists means either a broken release or a
   deleted tag, and deleted tags are worse than they sound once anyone has
   fetched them.
4. **Smoke test a real transcription on both platforms**, from a packaged build
   (`npm run pack`), not from `npm run dev`. Development runs read binaries out
   of `vendor/bin/<platform>-<arch>/`; packaged runs read them out of
   `Resources/bin`. Those are different code paths in `electron/binaries-runtime.ts`
   and only one of them is what users get.

## Cutting a version

```bash
npm version 0.1.1          # bumps package.json + package-lock.json, commits, tags v0.1.1
git push --follow-tags     # pushes the commit and the tag together
```

`npm version` refuses to run on a dirty tree, which is a feature — it means the
changelog edits above are already committed.

> If your git is configured to sign commits or tags with a hardware key,
> `npm version` will block on the touch prompt without printing anything about
> it. The tag is being made; put your finger on the key.

Pushing the tag is the trigger. Nothing else starts a release, and pushing to
`main` never does.

## What the tag sets off

`.github/workflows/release.yml` fires on `v*` tags. It is three jobs: two that
build, one that publishes.

### The macOS runner

Runs on Apple silicon and produces **both** Mac artifacts — an arm64 dmg and an
x64 dmg — from a single checkout.

- `npm ci`, whose `postinstall` runs `node scripts/fetch-binaries.mjs` and fills
  `vendor/bin/darwin-arm64/` with the four binaries that platform needs
  (`ffmpeg`, `ffprobe`, `whisper-cli`, `parakeet-cli`), each verified against the
  SHA-256 pinned in `vendor/binaries.json`.
- `node scripts/fetch-binaries.mjs` again, this time for `darwin-x64`, filling
  `vendor/bin/darwin-x64/`. This second run is the whole subject of the next
  section and is the step most likely to be quietly lost in a refactor.
- `npm run build` (typecheck, then electron-vite).
- `electron-builder --mac --arm64 --x64`, which packages each architecture with
  the matching `vendor/bin/darwin-<arch>` directory mapped into
  `Resources/bin` — the path `binDir()` reads at runtime.
- `node scripts/verify-packaged-binaries.mjs` against each produced app, which
  opens the packaged `Resources/bin` and reads the Mach-O header of every
  binary in it. An arm64 binary inside the Intel dmg fails the job here.

### The Windows runner

Produces the x64 NSIS installer.

- `npm ci`, whose `postinstall` fills `vendor/bin/win32-x64/` — the two `.exe`
  files **and the DLLs they need**, which on Windows is not optional; see
  [Why Windows comes from upstream](#why-windows-comes-from-upstream-dlls-and-all).
- `npm run build`, then `electron-builder --win --x64`.
- The same `verify-packaged-binaries.mjs` pass, reading PE headers instead of
  Mach-O ones.

There is one Windows architecture, so there is no second fetch and no way to get
this wrong the way the Mac job can.

### The publishing job

Waits for both, downloads their artifacts, and creates the GitHub release for the
tag with `RELEASE_NOTES.md` as the body and a `SHA256SUMS` file alongside the
installers. The release is created as a draft if the tag has a pre-release
suffix.

## Why the Mac job fetches binaries twice

`scripts/fetch-binaries.mjs` with no argument fetches for **the host**. That is
correct for `postinstall`, where the only thing anyone wants is a working
development checkout on the machine they are sitting at. It is wrong for a
release.

The Mac job builds both dmgs from one checkout on one arm64 runner. `npm ci` has
already populated `vendor/bin/darwin-arm64/`. If nothing else runs,
`vendor/bin/darwin-x64/` does not exist — and the failure mode is not a build
error. Depending on how the packaging glob resolves, the Intel dmg either ships
no `Resources/bin` at all, or ships the arm64 binaries under an x64 label. Both
produce an app that launches perfectly on an Intel Mac, shows its window, accepts
a dropped file, and then fails every single job at the moment it tries to exec
the transcriber.

It is worth being precise about why nothing upstream of that catches it.
`enginesReady()` and `engineReport()` answer *is the file there*. They do not and
cannot answer *will this file execute on this CPU* — `present: true` is exactly
what a wrong-architecture binary reports. The first honest signal is
`posix_spawn` returning `EBADARCH`, on a user's machine, at the end of the
extract-audio stage.

So: both directories must be populated before `electron-builder` runs, and the
observable invariant is not "the script was called twice" but

```bash
file vendor/bin/darwin-arm64/whisper-cli   # Mach-O 64-bit executable arm64
file vendor/bin/darwin-x64/whisper-cli     # Mach-O 64-bit executable x86_64
```

`vendor/bin/` is gitignored. Nothing is cached between runs. Every release
re-fetches from the pinned URLs and re-checks the pinned hashes, which is what
makes a release reproducible from a tag.

## The unsigned build

There is no Apple Developer ID and no Windows code-signing certificate behind
these builds. That is a deliberate, currently-unfunded position, and it has
concrete consequences that must be described honestly in every release.

### On macOS

The dmg is downloaded by a browser, so it arrives carrying
`com.apple.quarantine`. Because the app is neither signed with a Developer ID nor
notarized, Gatekeeper refuses to open it on a double-click, with a dialog saying
the developer cannot be verified. The user's way through is right-click → **Open**
→ confirm, once; on recent macOS versions even that is refused and the user has to
go to **System Settings → Privacy & Security**, find the message about DropScribe
being blocked, and choose **Open Anyway**.

There is no trick that removes this. `xattr -d com.apple.quarantine` works but
telling users to paste `xattr` commands from the internet is teaching them the
exact habit that gets people compromised, and we are not going to do it.

### On Windows

SmartScreen shows the blue "Windows protected your PC" panel with no publisher
name. **More info** → **Run anyway** gets through it. Unsigned installers also
accumulate SmartScreen reputation per-binary, so this does not improve as the
project ages — each new release starts from zero.

Unsigned also means no auto-update: `electron-updater` is a dependency but is
not wired to a feed, because shipping an unsigned update channel is a worse idea
than shipping no update channel. Users come back to the Releases page by hand,
and the release notes have to say so.

### The words about the missing signature

Put this in `RELEASE_NOTES.md`, adjusted only for what actually changed:

```markdown
## The app is not signed yet

There is no Apple Developer certificate and no Windows code-signing certificate
behind this build, so both operating systems will treat it as an unknown app the
first time you open it.

On macOS, double-clicking will be refused. Right-click the app in Finder and
choose **Open**, then confirm — you only have to do this once. If your version
of macOS refuses even that, open **System Settings → Privacy & Security**,
scroll to the message about DropScribe being blocked, and choose **Open Anyway**.

On Windows, SmartScreen will show a blue "Windows protected your PC" box. Click
**More info**, then **Run anyway**.

Both warnings are about the missing signature, not about anything the app was
caught doing — but that is exactly what a bad actor would also write here. The
source is public, so if you would rather not trust a binary from a stranger, you
can build it yourself.
```

The last paragraph is the one that matters and it is not decoration. Every
unsigned project writes "this warning is harmless"; so does malware. Saying that
out loud, and pointing at the source and at the checksums instead of asking for
trust, is the only version of this notice that is worth printing.

---

## Engine releases (`engines-*`)

### Why we build the macOS binaries ourselves

Upstream whisper.cpp publishes no macOS binaries. Not "publishes ones we do not
like" — the release assets are Windows and mobile framework bundles, and there is
nothing to download for Darwin on either architecture. Somebody has to compile
them, and that somebody is `.github/workflows/engines.yml`.

That is less painful than it sounds, because the macOS builds are self-contained.
A built `whisper-cli` links against Accelerate, Metal, MetalKit, Foundation,
CoreFoundation, `libc++` and `libSystem` — system frameworks, all of them — and
nothing else. ggml and whisper are statically linked in. So a macOS engine
release is four bare executables and no dependency graph to reproduce.

### Dispatching the workflow

When whisper.cpp is bumped, dispatch `.github/workflows/engines.yml` with the new
upstream ref as its input (`b4938`, a tag, or a commit sha). It:

1. Clones whisper.cpp at that exact ref.
2. Builds natively on the arm64 runner, producing `whisper-cli` and
   `parakeet-cli` for `darwin-arm64` with the Metal backend on.
3. Builds again on the same runner with `-DCMAKE_OSX_ARCHITECTURES=x86_64
   -DGGML_METAL=OFF`, producing the `darwin-x64` pair. Metal is off because
   ggml's Metal backend is an Apple-silicon story — an Intel Mac gets CPU plus
   Accelerate — and because leaving it on is what breaks the cross-build at link
   time.
4. Gzips each binary and publishes all four as a release tagged
   `engines-<ref>`, named `whisper-cli-darwin-arm64.gz`,
   `parakeet-cli-darwin-arm64.gz`, `whisper-cli-darwin-x64.gz`,
   `parakeet-cli-darwin-x64.gz`.

Check the produced files before repinning:

```bash
file whisper-cli-darwin-x64     # must say x86_64, not arm64
```

A cross-build that silently falls back to the host architecture is the single
most likely way for this workflow to lie to you.

### Why Windows comes from upstream, DLLs and all

Upstream *does* publish Windows binaries, as `whisper-bin-x64.zip` on each
release. We take that asset rather than building it, and the important part is
that **the two executables are not enough on their own**.

The Windows build is dynamically linked. `whisper-cli.exe` and `parakeet-cli.exe`
need, from the same zip:

- `whisper.dll`, `parakeet.dll`
- `ggml.dll`, `ggml-base.dll`
- the entire `ggml-cpu-*.dll` family — `sse42`, `x64`, `sandybridge`, `haswell`,
  `skylakex`, `icelake`, `cascadelake`, `cannonlake`, `alderlake`

The `ggml-cpu-*` set is not a menu to pick from. ggml probes the running CPU and
loads the best of them at startup; ship only `haswell` and the app dies on
machines that would have loaded `sse42`, in a way that no developer machine will
ever reproduce. Take all nine.

What is deliberately **not** taken: `llama.dll` and `SDL2.dll` (they belong to
`whisper-talk-llama` and the streaming examples, which we do not ship) and every
other `.exe` in the archive. Fifteen files go into `vendor/bin/win32-x64/`; the
rest of the zip is dead weight in an installer.

### Repinning `vendor/binaries.json`

Once the engine release exists, point the manifest at it and re-measure:

```bash
# edit vendor/binaries.json: bump the engines-<ref> URLs, and the upstream
# whisper-bin-x64.zip URL for the Windows entries
npm run binaries:hashes     # node scripts/fetch-binaries.mjs --write-hashes
git diff vendor/binaries.json
```

`--write-hashes` downloads every pinned asset and writes the measured SHA-256
back into the file. Be clear-eyed about what that buys: unlike the model hashes
in `electron/shared/models.ts`, which come from Hugging Face's LFS metadata and
are therefore an independent statement about the file, these hashes are computed
from bytes we just downloaded. They do not prove the binary is good. What they
pin is that **every later build gets the identical bytes** — that CI a year from
now, and any user building from the tag, resolve to exactly what was reviewed
today, and that an asset silently replaced upstream fails loudly instead of
shipping.

Then rebuild, and actually run a transcription with each engine before
committing. Which brings us to the failure modes.

---

## What would go wrong

### Pruning an engines release that a shipped version still pins

`engines-*` releases look like build clutter. They are not: they are load-bearing
for every app tag whose `vendor/binaries.json` names them. Deleting
`engines-b4938` because "we're on the new one now" breaks

- `npm ci` for anyone building `v0.1.0` from source — `postinstall` 404s and the
  install fails outright,
- any CI re-run of an older tag, including a hotfix branch cut from it,
- the reproducibility claim the pinned hashes exist to make.

**Engine releases are append-only.** Never delete one. Before touching any of
them, `git log -p -- vendor/binaries.json` lists every ref this repo has ever
pinned, and every one of those still has a tag pointing at it.

### Bumping whisper.cpp without re-measuring the output shape

The adapters do not use a library. They parse the CLIs' output, and they parse it
against shapes that were measured, not documented:

- `electron/engines/whisper-cpp.ts` reads the `-oj` JSON file and takes
  `transcription[].offsets.from` / `.to` as **integer milliseconds**, token `p`
  as a 0..1 confidence, and word boundaries from tokens whose text begins with a
  space — while dropping `[_BEG_]`-style special tokens. Progress comes off
  **stderr**, from a `whisper_print_progress_callback` line.
- `electron/engines/parakeet-cpp.ts` reads per-token lines from **stderr**, where
  `t0` and `t1` are in **centiseconds** and are multiplied by ten, word
  boundaries come from an explicit `word_start=true|false` field, and the
  word-initial `▁` marker is stripped.

Every one of those is a thing upstream can change without announcing it, and
none of them fails loudly. A field rename gives you an empty transcript. A unit
change gives you a complete, plausible-looking transcript with every timestamp
off by a factor of ten — which survives a casual look at the text pane and only
shows up as subtitles that drift a minute out by the end of the file.

So a whisper.cpp bump is not a version-string edit. Run both engines against a
known sample, diff the parsed transcript against the previous engine's output,
and confirm the first and last timestamps still match the media duration. The
fixtures in `test/` exist for this and must be re-captured whenever the shape
moves. `docs/engines/` records the measured format for each pinned ref; update it
in the same commit.

### Shipping a dmg whose `Resources/bin` is the other architecture

Covered above, and repeated here because it is the failure this whole runbook is
shaped around. It cannot be caught by looking at the app: the Electron binary is
the right architecture, the window opens, the model downloads, and `enginesReady()`
returns true because the files are present. Only exec fails, only on the other
architecture, only on a machine no one on the project is holding.

`scripts/verify-packaged-binaries.mjs` exists for exactly this. It reads the
Mach-O or PE header of every binary inside the packaged `Resources/bin` and
fails the build when the CPU type does not match the artifact being produced. If
it ever starts failing, do not skip it and do not add an exception — it is
reporting the bug it was written to find.

### The model catalogue drifting out from under the pinned hashes

Not a release-workflow failure, but it surfaces at release time. `LOCAL_MODELS`
pins each weight file by exact byte count and SHA-256 from Hugging Face's LFS
metadata. Hugging Face repos are mutable; a re-uploaded `ggml-large-v3-turbo.bin`
turns every first-run download into a hash mismatch, which the app correctly
refuses and the user experiences as "the model won't install".
`scripts/verify-model-catalogue.mjs` re-reads the metadata from the API and is
meant to fail CI before a release rather than after one. If it fails, the fix is
to check what upstream changed and repin deliberately — never to relax the check.
