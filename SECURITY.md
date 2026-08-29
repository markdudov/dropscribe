# Security Policy

DropScribe runs on your machine, reads files you hand it, and holds API keys that
cost real money. This document says how to report a problem privately, what
counts as one, and — so you can judge for yourself — what the app actually does
with your files and your keys.

---

## Reporting a vulnerability

**Do not open a public issue.** A GitHub issue is world-readable and indexed
within minutes, which turns a report into a disclosure before there is a fix.

Report privately, either way:

1. **Preferred — GitHub private vulnerability reporting.** Go to the
   [Security tab](https://github.com/markdudov/dropscribe/security/advisories)
   and choose *Report a vulnerability*. This opens a private advisory only you
   and the maintainers can read, and it is where the fix and the CVE, if there is
   one, will be coordinated.
2. **Email** — <markantoni66@gmail.com>, subject line starting `DropScribe
   security`. Plain email is fine; if you would rather encrypt, say so in a first
   message with no details and a key will come back.

Useful in a report: what an attacker gains, the DropScribe version and OS, and
the smallest reproduction you have. A crafted media file that triggers it is
worth more than a paragraph describing one — attach it, or link it somewhere
private.

**Do not put an API key in the report.** Not yours, not one you extracted while
testing. If a finding is *about* key handling, describe where the key ended up
(the file, the log line, the process argument) rather than pasting its value. If
you believe a key of yours has leaked, revoke it at the provider first; that is
faster than any fix here.

### What to expect

This is a small project maintained by one person, so the honest numbers:

- **Acknowledgement within 5 days.** If you have heard nothing by then, assume
  the message went missing and ping again.
- **An assessment within 14 days** — whether it is in scope, and how severe.
- **A fix in a release** as fast as severity warrants. Anything that exposes keys
  or executes code is treated as urgent.
- **Credit in the advisory and the release notes**, under whatever name you want,
  unless you would rather stay anonymous.

There is no bug bounty. There is no money in this project to pay one with.

Please give a fix a reasonable window before publishing — 90 days is the usual
courtesy, less if it is being actively exploited, and shorter is negotiable if
you have a deadline.

---

## Scope

**In scope** — anything that breaks one of the guarantees in the next section:

- Reading, exfiltrating or recovering a stored API key from disk, from a log,
  from a crash report, from a process argument list, or from the renderer.
- Any path the renderer can take to read or write a file the user never
  authorized — a bypass of the main-process path allowlist.
- Escaping the renderer's sandbox or context isolation: reaching Node, the
  filesystem, or `ipcRenderer` from renderer-side code.
- Code execution triggered by a media file the user drops — including through the
  bundled `ffmpeg`, `ffprobe`, `whisper-cli` or `parakeet-cli`, and including
  argument or command injection via a crafted filename.
- Anything that sends audio, transcripts or metadata somewhere the user did not
  choose — including a local-only transcription making any network request at all.
- Tampering with the auto-update channel: unsigned or substituted updates,
  downgrade attacks, an unverified download.
- A vulnerable dependency that is genuinely reachable in the shipped app. Say how
  it is reached; an advisory ID alone against a dev-only package is not a finding.
- The binary fetch step (`npm run binaries:fetch`) accepting a binary that does
  not match its recorded hash.

**Out of scope:**

- Vulnerabilities in DeepInfra, Deepgram, ElevenLabs or OpenRouter themselves.
  Report those to them — but do tell us if DropScribe's use of their API makes it
  worse than it needs to be.
- Upstream CVEs in ffmpeg or whisper.cpp with no DropScribe-specific angle. Still
  worth a message so the pinned version can be bumped; just not an advisory here.
- Anything that requires an attacker who already has code execution as your user
  account. At that point they can read the Keychain, the DPAPI blobs and your
  files directly, and no desktop app defends against that.
- Anything requiring physical access to an unlocked machine.
- Denial of service by feeding the app an enormous or malformed file, where the
  worst outcome is a failed job or a hung child process the user can cancel.
- Missing hardening flags, absent security headers, or a scanner's output with no
  demonstrated path to impact.
- Social engineering, phishing of maintainers, or anything about this repository's
  GitHub configuration rather than the app.

---

## The app's actual security posture

Stated plainly, so a report can point at a specific broken promise rather than a
vibe.

### API keys are never written in plaintext

Keys go through Electron's [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage),
which encrypts against the OS keystore — **Keychain** on macOS, **DPAPI** on
Windows — so the ciphertext on disk is bound to your login and useless when
copied to another machine or another user account. What is stored is the
encrypted blob and nothing else.

The consequences are deliberate and worth knowing:

- **A key is write-only from the UI's point of view.** Once saved it is never
  displayed again; the settings pane shows the last four characters
  (`…a91f`) purely so you can tell two keys apart. There is no "reveal" button,
  because the only thing it would add is a screenshot risk.
- **The renderer never receives a key.** It asks main to test a key or run a job;
  main reads the key, uses it, and returns a result. A key is never part of any
  IPC payload travelling toward the renderer.
- **Keys are never logged**, never interpolated into an error message, never put
  in a file path, and never placed in a URL — not even a query string that only
  goes to the provider, because URLs end up in logs, in crash reports and in
  proxy history. They travel in a request header, and the header is not logged.
- If `safeStorage` reports the OS keystore is unavailable, the key is **not**
  written to a fallback file. It stays in memory for the session and you are told.
  Silently degrading to plaintext would be the worst possible failure mode.

### The renderer is sandboxed, context-isolated, and has no Node

The window is created with `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`, and no `nodeIntegrationInWorker` or
`nodeIntegrationInSubFrames`. The renderer's *only* channel to the rest of the
app is one frozen object exposed through `contextBridge` by the preload script,
which forwards a fixed, enumerated set of IPC channels and nothing else. There is
no generic `invoke(channel, args)` escape hatch — that pattern re-creates the
vulnerability the bridge exists to remove.

Renderer code cannot `require`, cannot touch the filesystem, and cannot reach
`ipcRenderer`. Navigation away from the app's own origin and `window.open` are
blocked; external links are opened by the main process against a fixed list of
known destinations, addressed by a semantic id rather than a URL the renderer
supplies, so the renderer cannot ask the OS to open an arbitrary URL.

### Every file path is authorized by the main process

The main process keeps an allowlist. A path enters it only through an action you
took — a drop onto the window, or a native open dialog — and only if it is a
readable regular file with a media extension. Every later operation on that path
(probe, extract, transcribe, export next to it) is checked against the allowlist
first, and an unauthorized path throws before anything opens it.

The renderer is therefore never trusted to name a file. It can *ask* for one; it
cannot *assert* one. This is the single most important boundary in a
drag-and-drop app, because a path string from the renderer is exactly what an
injected script would want to control.

### Local transcription sends nothing, anywhere

When the target is a local model, no part of the pipeline makes a network
request. ffmpeg extracts audio to a temporary WAV, the engine binary runs on your
machine, and the temporary file is deleted when the job ends. No telemetry, no
analytics, no crash reporting, no "anonymous usage statistics". The app makes
network requests in exactly three situations, all of which you initiate: you
download a model, you use a cloud provider, or the updater checks for a new
release.

### A cloud provider receives the audio and nothing else

Choosing a cloud provider means sending your audio to that provider — there is no
way around it, and it is the trade you are making for their model. What is *not*
sent: your filename, the path, any other file, or anything identifying you beyond
the API key that authenticates the request. The audio is transcoded to 16 kHz
mono Opus first, which is done for upload size but has the side effect that the
original file never leaves your machine.

Only the provider you selected is contacted. Selecting one provider does not
cause a request to any other.

### ElevenLabs is told to retain nothing

Every request to the ElevenLabs Speech-to-Text API is sent with
**`enable_logging=false`**. In their API this is the zero-retention flag: the
audio is not stored, not retained, and not used for model training. It is sent on
every request unconditionally — it is not a setting, because a retention default
is not something a transcription tool should quietly leave switched on.

The other providers' retention behaviour is governed by their own policies and
your account settings with them; DropScribe sends no request that opts you into
data retention or training anywhere. If you have strict requirements, read the
policy of the provider you pick — or use a local model, where the question does
not arise.

---

## Supported versions

DropScribe is pre-1.0. Only the latest release gets security fixes; there are no
backports to earlier ones. Update before reporting, and say which version you
tested.
