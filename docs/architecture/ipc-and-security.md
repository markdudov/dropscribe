# IPC and the renderer security model

The threat this app faces is not a targeted attacker. It is a malformed media
file, a hostile provider response, and a supply-chain substitution of a binary
or a model. The renderer is where the first two are parsed, so the renderer is
the thing that is contained — and everything in this document follows from
treating it as the process most likely to be turned against the user, rather
than as our own trusted code.

## The one bridge

`electron/preload.ts` exposes exactly one object, `window.dropscribe`. Its type
— and every type that crosses it — is declared **once**, in
`electron/api-types.ts`, which is compiled by `tsconfig.node.json` (main and
preload) *and* by `tsconfig.web.json` (the renderer). The handler, the bridge
and the caller therefore compile against the same shapes rather than three
hand-synced copies that drift apart one field at a time.

That is also why `api-types.ts` may not import from `node:` or `electron`. It
imports the pure types under `electron/shared/` and nothing else; the file says
so in its own header, and `tsconfig.web.json`'s `include` list is what enforces
it — see
[build-and-packaging.md](build-and-packaging.md#two-typescript-projects).

Renderer flags: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, `webSecurity: true`, and a `Content-Security-Policy` of
`default-src 'self'` on the renderer document. There is no `remote`, no
`require` and no `ipcRenderer` in the main world.

The preload is CommonJS. A sandboxed preload cannot be ESM — that is a platform
constraint, and `electron.vite.config.ts` forces `format: 'cjs'` with a comment
saying as much, so nobody "modernizes" it later.

### The window goes nowhere

Those flags stop renderer code from reaching node. They do **not** stop it from
steering the window somewhere else, which would replace the app with a remote
page inside a process that still holds the bridge's channels. So the window is
created with three refusals:

- `setWindowOpenHandler` → `{ action: 'deny' }`, unconditionally. Nothing in
  `src/` calls `window.open`, and a second `BrowserWindow` would also be a
  second window whose close nobody guards while a two-hour transcription is
  running.
- `will-navigate` → `preventDefault()` for anything that is not the app's own
  document.
- `will-frame-navigate` → the same predicate, because `will-navigate` fires for
  the main frame only and an iframe is a frame.

**A denied navigation is dropped, not forwarded to `shell.openExternal`.** That
forwarding is the common Electron recipe and it is wrong here. `app:openExternal`
deliberately takes a semantic id rather than a URL (below) precisely so that a
compromised renderer cannot name a destination for main to open; a guard that
answers a denied navigation by opening it externally hands that capability
straight back, over a path with no allowlist at all. The recipe exists for apps
that render documents full of third-party links. This app renders none — the
transcript pane shows text, the settings screen shows the app's own controls,
and the drop handlers `preventDefault` `dragover`/`drop` so a dropped file
cannot navigate the window either.

This is defence in depth, not the fix for an observed escape.

### `invokeUserFacing`

An `Error` thrown inside an `ipcMain.handle` arrives in the renderer wrapped:

```
Error invoking remote method 'jobs:enqueue': Error: <the real message>
```

Almost every error message in this app is written *for the user* and is shown
verbatim — `path-policy.ts`'s "DropScribe can no longer read “clip.mp4”…",
`credentials.ts`'s keychain advice, every adapter's provider-specific sentence.
Stripping the plumbing in each `catch` in the renderer would mean doing it
correctly in a dozen places forever, so it is stripped once, at the bridge, by
`invokeUserFacing`.

**Any new IPC whose error text can reach the UI must route through
`invokeUserFacing`.** The exceptions are the channels whose failures are
programming errors rather than conditions — and there are fewer of those than
you would think.

## Channels

Everything is `ipcRenderer.invoke` except where the table says otherwise. Two
channels go main → renderer, and exactly one is synchronous.

### Files

| Channel | Direction | Notes |
| --- | --- | --- |
| `files:open` | invoke | Native picker filtered by `OPEN_DIALOG_FILTERS`. The returned paths are **already authorized**, and they are the canonical (`realpath`-resolved) ones, so everything downstream — and `Job.filePath` in the UI — names the file the user will actually find in Finder or Explorer |
| `files:authorize` | **sendSync** | One string in, one boolean out, and the app's only synchronous channel. It authorizes a dropped path *before* the renderer can use it. Synchronous because a `drop` handler must decide inside the event, while the `DataTransfer` still exists |
| `files:chooseOutputDir` | invoke | Folder picker for `OutputSettings.outputDir`. Returns `null` when cancelled |
| `files:reveal` | invoke | `shell.showItemInFolder`. Takes a renderer-supplied path, so it is allowlist-checked like every other path-taking channel |

### Jobs

| Channel | Direction | Notes |
| --- | --- | --- |
| `jobs:enqueue` | invoke | `(paths, target)`. Returns the jobs actually created — a path that failed authorization gets **no job at all**, so the caller compares lengths and says "took 4 of 6" once, rather than showing four red rows for files the app declined to look at |
| `jobs:list` | invoke | The whole list, as copies. What the store loads on mount and after a reconnect |
| `jobs:cancel` | invoke | Aborts the `AbortController`, then marks the row `cancelled` immediately rather than waiting for ffmpeg to notice |
| `jobs:retry` | invoke | Only `failed` and `cancelled` jobs. Re-running a `done` job would write a second set of exports as `name (2).srt` beside the first, which is not what anybody means by "retry" |
| `jobs:remove` | invoke | Aborts, marks cancelled, deletes. **Emits no event** — see [state-and-store.md](state-and-store.md) for why the store must drop the row itself |
| `jobs:clearFinished` | invoke | Drops every terminal job. Also silent, for the same reason |
| `jobs:updated` | **main → renderer** | One job per event, always a copy of the whole job. A removed job is never emitted for: the store cannot tell "a change to a job you have" from "a job you have not seen", so an event for a deleted job would resurrect its row |

### Local models

| Channel | Direction | Notes |
| --- | --- | --- |
| `models:list` | invoke | Catalogue joined with what is on disk, including a partial `.part` size |
| `models:download` | invoke | Resumable; verifies SHA-256 as the bytes stream past and renames into place only on a match, so a file with the catalogue's name is always one the engine can load |
| `models:cancelDownload` | invoke | Leaves the `.part` behind on purpose. "Cancel" from someone holding 2.4 GB of a 3 GB file means "not right now" |
| `models:delete` | invoke | Removes the weights, not the catalogue entry |
| `models:updated` | **main → renderer** | One `ModelState` per event, rate-limited to ~4 Hz. A 64 KB chunk on a fast connection is several hundred callbacks a second, and each one would be an IPC message and a React render |

### Cloud providers

| Channel | Direction | Notes |
| --- | --- | --- |
| `providers:list` | invoke | `ProviderState[]`: `hasKey`, `keyPreview`, `lastTest`, cached `models`, `selectedModelId`. **Never a key** |
| `providers:testKey` | invoke | Tests and does **not** save. This is what the Test connection button calls, so a mistyped key never reaches the keychain |
| `providers:saveKey` | invoke | Tests first, stores only on success, and returns the same `KeyTestResult`. The ordering is a spec, not a nicety: the model picker does not exist until the key has proved itself |
| `providers:clearKey` | invoke | Drops the ciphertext *and* the cached provider record — leaving a green "connected" badge and a model list behind would make the row look configured with no key behind it |
| `providers:refreshModels` | invoke | Re-fetches with the stored key. Replaces the list wholesale; a provider returning fewer models is one retiring a model, and merging would resurrect it |
| `providers:selectModel` | invoke | Persists the choice |

### Settings and output

| Channel | Direction | Notes |
| --- | --- | --- |
| `settings:get` | invoke | A deep copy of the coerced settings |
| `settings:save` | invoke | Takes a `Partial<Settings>` and returns the merged result — the same coercion path that loads the file, with the current values as the fallback, which is exactly what "merge a patch" means |
| `output:render` | invoke | Renders a finished job's transcript into one format and returns the **text**. Main renders it with the same pure `renderTranscript` the auto-export used, so the preview cannot drift from the file on disk |
| `output:export` | invoke | Save-as dialog, then write. Returns the path written, or `null` if cancelled |
| `output:exportMany` | invoke | Every selected job × every chosen format. Returns how many files landed |
| `output:copy` | invoke | Renders and puts it on the clipboard from main, so the renderer never needs clipboard permissions |

### App

| Channel | Direction | Notes |
| --- | --- | --- |
| `app:info` | invoke | Version, platform, arch, the models directory, and `enginesReady` + `engineReport`. The report is recomputed on every call rather than cached: a developer who has just run `npm run binaries:fetch` with the app open should see the answer change on the next render |
| `app:openExternal` | invoke | Takes an `ExternalLinkId`, **never a URL** — see below |
| `app:licenses` | invoke | Reads `licenseNoticePath()` and returns its contents. The path is computed by main from `app.isPackaged` / `process.resourcesPath`, never supplied by the renderer, so this channel needs no allowlist check |

## The path allowlist

The renderer may only touch files the **user actually chose**.
`electron/path-policy.ts` keeps a `Set` of authorized paths, and a path gets in
by exactly two routes: a native dialog main itself opened, or a path taken from
a genuine dropped `File` and submitted through `files:authorize`.

`pathForFile(file)` on the bridge is **not** a channel: `webUtils.getPathForFile`
reads a value Chromium has already attached to the `File`, and it lives in the
preload because that is the only place `webUtils` exists. A compromised main
world cannot forge a path through it — a `File` constructed in JavaScript
returns `''`, which `authorizePath` then refuses like any other string that is
not a readable media file — and the path it does return is worth nothing until
`files:authorize` has accepted it.

Both routes end in `vet()`, which checks in the order that fails cheapest first:

1. **Absolute.** A relative path would be resolved against main's cwd — the repo
   root in dev, and somewhere the user has never heard of in a packaged app.
2. **Media extension**, before any syscall. This is the check that rejects the
   PDF dropped by mistake, and it costs nothing.
3. **`realpathSync`.** A missing file, a broken symlink and an unreadable parent
   directory all land here and all mean the same thing.
4. **Media extension again, on the resolved path.** `foo.mp4` may be a symlink
   to `secrets.pem`, and the extension of the link says nothing about the target.
5. **`statSync().isFile()`.** Directories, sockets and device nodes are refused
   — and so are FIFOs, which matter more than they look: ffmpeg would block on
   one forever and the job would sit at "Preparing" until the app was quit.
6. **`R_OK`.**

**Why it stores and re-resolves the real path.** Authorizing
`~/Movies/clip.mp4` while it is a symlink to a real film, then repointing that
symlink at a private key before the job reaches the front of the queue, is a
trivially winnable race against a set of raw strings. Resolving at authorization
time *and* again at use time means the string that finally gets spawned was, at
both moments, the same real file. `isAuthorized` therefore re-runs `realpath`
rather than comparing strings; a canonical path resolves to itself and costs one
syscall.

**The set is never pruned.** An entry has to outlive the job that uses it,
including a retry hours later, and there is no moment at which "the user is
definitely finished with this file" is knowable. It dies with the process, so a
relaunch means dropping the file again — which is correct, because the temp
files and the in-memory queue are gone too.

**Where it is enforced:** every IPC handler that accepts a renderer-supplied
path, and again inside the queue at the moment the file is opened
(`assertAuthorized(job.filePath)` at the top of `runJob`). The second check is
not redundant — a job can wait an hour behind a feature film, and that is enough
time for the world to change.

**Where it is deliberately *not* enforced:** `electron/ffmpeg.ts` never calls
`assertAuthorized`. It is also asked to read files the app created itself — the
extracted WAV, the compressed upload — which are never user-authorized and never
will be. The check belongs at the boundary where a renderer-supplied string
enters main, not at the boundary where main talks to a process it spawned.

**Any new IPC that takes a renderer-supplied path MUST check the allowlist.**

## `app:openExternal` takes an id, not a URL

```ts
type ExternalLinkId =
  | 'repo'
  | 'issues'
  | `provider-key:${ProviderId}`
  | `provider-docs:${ProviderId}`;
```

Main resolves the id to a URL from its own tables: the repository and issue
links are constants in main, and the two templated forms read `keyUrl` and
`docsUrl` off the matching entry of `PROVIDERS` in
`electron/shared/providers.ts`. The renderer never supplies a URL string, and an
id that names no provider resolves to nothing rather than to a default.

The obvious signature, `openExternal(url: string)`, turns any renderer
compromise into an arbitrary-URL opener, and on a desktop that is worth far more
to an attacker than it sounds: `shell.openExternal` will follow `file://`, and
every custom scheme any installed application has registered with the OS. The id
form costs one lookup table and removes the capability entirely.

The same reasoning is why the navigation guard drops denied navigations instead
of forwarding them here.

## API keys, end to end

A key is entered, tested, stored, used and shown — and each of those five steps
has one rule.

**Tested before it is ever stored.** `providers:testKey` validates without
saving; `providers:saveKey` tests first and writes nothing if the test fails. A
mistyped key never reaches the keychain, so "the settings screen says connected"
and "there is a working key on this machine" cannot disagree.

**Encrypted at rest by the OS.** `electron/services/credentials.ts` uses
Electron's `safeStorage` — the login Keychain on macOS, DPAPI on Windows. The
obvious library is `keytar`, and it was rejected: it is a native addon, so every
Electron upgrade means rebuilding it against a new ABI, shipping a prebuilt
`.node` per platform *and* per architecture, and code-signing that binary on
macOS — all to reach the identical syscalls the runtime already exposes.

`safeStorage` encrypts blobs but does not store them, so the ciphertext lives in
`<userData>/credentials.json`, base64 per provider id, written `0o600` through
the same temp-then-rename dance as `settings.json`. That file is worthless on
another machine or another user account, which is the entire point.

**There is no plaintext fallback, in either direction.** When
`safeStorage.isEncryptionAvailable()` is false, `setKey` throws a loud,
platform-specific, actionable error and stores nothing. Writing the key in
plaintext "just this once" is exactly the failure this module exists to prevent:
a credential sitting readable inside the user's profile, put there by an app
they trusted *because* it said it used the Keychain. One unlock is a cost the
user can pay; an exposure they never learn about is not. On the read side there
is nothing to fall back to — we never wrote any.

A decrypt that fails (ciphertext from another machine, a restored backup) returns
`null` and **leaves the entry on disk**. The user may be about to log into the
account that can read it, and a failed decrypt is not a reason to destroy data;
re-entering the key overwrites it cleanly.

**The renderer never sees a key.** `ProviderState` carries `hasKey`, and
`keyPreview` — the last four characters, as `…a91f`. Four is enough for someone
with two accounts to tell which key is configured and far too few to be worth
anything to anybody else. It is `undefined` rather than `''` when there is no
key, so the caller's conditional spread omits the field entirely under
`exactOptionalPropertyTypes`.

**Keys travel in headers, never in URLs.** `providers/types.ts` takes the URL and
the request init separately and never interpolates anything from the init into
an error message. A key in a query string is printed by every proxy, every crash
reporter and every log line that records a request.

**The log redacts as a chokepoint, not as a discipline.** `redact()` in
`electron/services/logger.ts` runs over every message, every field value, every
nested field value, every error message and every stack trace — prefixed keys
(`sk-…`), `Bearer …`, sensitive query parameters, any bare 32+ character run of
base64url, and any field whose *name* matches `key|token|secret|authorization`
at any depth. The last rule is the only one that can catch a short legacy key no
entropy heuristic would flag.

The trade is one-directional and deliberate: a 34-character filename with no
separators comes out as `[redacted]`, and that is the correct outcome. The reason
this is a chokepoint is that the most likely way a key escapes this app is not a
leaked request — it is a helpful user zipping the log into a GitHub issue
because we asked them to. Call-site discipline works right up until someone logs
an error object whose `config.headers.authorization` they never thought about,
and by then it is in a public tracker.

UUIDs are the one exemption from the long-run rule, because job ids are UUIDs
and redacting them would gut the log for the exact purpose it exists: following
one file through enqueue, extract, decode and export.

**`JobError.detail` is a bug-report field, and it is still redacted.** It carries
ffmpeg's stderr tail and provider error bodies. `JobError.message` is the
user-facing half and may not contain a stack trace, a home directory or a URL.

## The donation links go through the same allowlist as everything else

`ExternalLinkId` gained `support:paypal` and `support:revolut`, and the URLs
live in `main.ts` beside `REPO_URL`, not in the component that renders the
buttons. That is not consistency for its own sake: a payment page is the single
most valuable destination for a compromised renderer to be able to choose. If
the renderer could name the URL, `shell.openExternal` would be a way to send
somebody to a page that looks like this one and is not. It names an intent; main
decides what that means.
