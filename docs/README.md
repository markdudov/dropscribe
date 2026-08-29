# DropScribe documentation

This directory is the map of how DropScribe works and, more importantly, *why it
works that way*. The code says what happens; these files say what the obvious
alternative was and why it was rejected — which is the part a diff cannot carry
and the part that stops the same decision being re-litigated every six months.

## The contract

Three rules govern everything under `docs/`. They are stated in
[`CONTRIBUTING.md`](../CONTRIBUTING.md) as obligations on a pull request; here
they are stated as the shape of the directory.

1. **One file per subsystem, and it explains *why this and not the obvious
   alternative*.** The layout below mirrors the tree — `architecture/` for the
   cross-cutting decisions, `engines/` for the local inference path,
   `providers/` for the cloud path. A page that only restates what the code
   already says is not worth the maintenance it will demand; a page that records
   a rejected alternative pays for itself the first time someone proposes it
   again.
2. **`docs/` is updated in the same change that alters behaviour.** If a user
   could notice the difference — a new export format, a changed default, a
   different error message — some page here is now false. It gets fixed in the
   pull request that made it false, not in a follow-up written by someone
   reconstructing the reasoning from the diff.
3. **Every non-trivial solved bug gets `docs/bugs/NNNN-slug.md`.** Next unused
   number, zero-padded to four digits, slug naming the *cause* rather than the
   symptom. "Non-trivial" means it took more than a minute to find, or it could
   plausibly recur in another adapter, another engine, or on the other platform.

## The files

| File | The question it answers |
| --- | --- |
| [`architecture/overview.md`](architecture/overview.md) | What are the pieces, and what actually happens between a file being dropped on the window and a transcript coming back? |
| [`architecture/ipc-and-security.md`](architecture/ipc-and-security.md) | How does the renderer talk to the main process, and why can it never name a file path, a URL or a key of its own? |
| [`architecture/build-and-packaging.md`](architecture/build-and-packaging.md) | How does a checkout become a `.dmg` and an `.exe`, and where do the vendored binaries live in development versus in a packaged app? |
| [`architecture/state-and-store.md`](architecture/state-and-store.md) | Where does interface state live, what is persisted in settings, and what stays in the main process because the renderer must not hold it? |
| [`engines/local-models.md`](engines/local-models.md) | Which local models exist, how are they downloaded, verified and stored, and how are `whisper-cli` and `parakeet-cli` actually invoked and parsed? |
| [`engines/verification.md`](engines/verification.md) | What was *measured* about whisper.cpp b4938 on real hardware, as opposed to assumed — and which tempting simplification each measurement forbids. |
| [`providers/cloud-providers.md`](providers/cloud-providers.md) | How does each of the four cloud adapters authenticate, test a key, list models, and map its own response shape onto the one `Transcript`? |
| [`releasing.md`](releasing.md) | How is an app release cut, and how does that differ from the much rarer engine release that republishes the whisper.cpp binaries? |
| [`bugs/README.md`](bugs/README.md) | What has already gone wrong here, and how is a new bug note written so the next person recognizes the sibling bug? |
| [`superpowers/specs/2026-08-29-dropscribe-design.md`](superpowers/specs/2026-08-29-dropscribe-design.md) | The approved design specification: every stack and subsystem decision with its alternatives, its evidence marker, and what is deliberately out of scope for v1. |

Start with `architecture/overview.md` if you are new to the tree, and with
`engines/verification.md` before you change anything under `electron/engines/`,
`electron/shared/models.ts` or `.github/workflows/engines.yml` — that file exists
precisely because the code there looks wrong until you know what was measured.

## What is deliberately not here

Four documents live at the repository root rather than under `docs/`, because
they are read by people who have not cloned the tree and GitHub surfaces them
in its own places: [`README.md`](../README.md) (what the app is, and how to
install or build it), [`CONTRIBUTING.md`](../CONTRIBUTING.md) (setup, the three
checks, commit and pull-request conventions), [`SECURITY.md`](../SECURITY.md)
(the threat model and how to report a vulnerability), and
[`CHANGELOG.md`](../CHANGELOG.md) with [`RELEASE_NOTES.md`](../RELEASE_NOTES.md)
(what changed, and the text of the current GitHub release).
