# 0016 — The last five: a folder anyone could name, stale rules, a stranded file, a lost cancel, a refused upload

## A folder the renderer could name, and main would write into

`output.outputDir` is a path main writes files into: the auto-export `mkdir`s it
and writes a transcript there after every job, `output:exportMany` writes there
on demand, and `files:reveal` treats it as an allowed target.

`settings:save` handed the renderer's patch straight to `saveSettings`, whose
only validation — `nullableString` — is literally `typeof value === 'string'`.
No absolute-path check, no existence check, no path-policy involvement.

`files:chooseOutputDir` opens a native dialog and returns the result, but
nothing bound that result to the settings write: the renderer round-tripped it
through `settings:save`, so main could not tell a chosen folder from a
fabricated one. A compromised renderer could point it at `~/Library/LaunchAgents`
and have every finished job write a file there, with a name derived from the
dropped media, without a dialog appearing.

This is exactly the boundary `path-policy.ts` says it exists to hold: *"a path
becomes usable only by arriving from a source main itself controls."*

`settings:save` now refuses an `outputDir` that is neither the value already
stored nor one this process opened a dialog for. Refused rather than silently
ignored: keeping the old value quietly would leave the panel showing a folder
that is not the one being written to.

Verified against the running app:

```
  arbitrary directory        -> refused: A folder for transcripts has to be chosen through the picker.
  unrelated settings save    -> ok
  re-sending the stored one  -> ok
```

The legitimate path is unbroken: `chooseOutputDir` adds the folder to the set
one line before returning it, and the store writes exactly that value back.

## The one export that ignored the export settings

`OutputTab` promises the subtitle rules "take effect on the next **export**,
because cues are derived from the stored transcript every time it is rendered,
never baked into it". The preview, Copy and the Export dialog all read the
settings fresh. The **auto-export** used the snapshot `runJob` took when the job
started.

So a two-hour job whose settings changed halfway wrote a `.srt` laid out to the
old rules, while everything else in the window used the new ones — two files
with different cue boundaries and nothing to say which was which. It now reads
`getSettings()` at the moment it writes.

## A file the cleanup could never see

`whisper-cli` was given `-of <tmpdir>/dropscribe-whisper-<uuid>`, a **sibling**
of the app's temp root rather than a child of it. `sweepOrphanedTemp` reads only
`<tmpdir>/dropscribe`, so the one mechanism written for "a hard crash, a
force-quit, a `kill -9`, a machine that loses power mid-job" could not see it.
Its only other removal is the `finally` that those cases skip. At roughly a
kilobyte per second of audio, an interrupted two-hour job stranded about 8 MB —
permanently, since macOS clears `/var/folders` only on a reboot and Windows
never clears `%TEMP%`.

It now goes beside the WAV, inside the job's own scratch directory, which both
`cleanupJobTemp` and the sweep already cover. Demonstrated by planting a stale
file in each location, back-dating both past the 24-hour cutoff, and launching:

```
  before: inside the root 2 files,  sibling 1
  after : inside the root 0 files,  sibling 1
```

The sibling survives the sweep forever. That was the old location.

## Cancel that did not reach ffprobe

`probe()` took no `AbortSignal`, though `runBinary` has supported one all along.
A job cancelled while ffprobe was still reading a very large or very slow file
held its queue slot until ffprobe finished on its own: the row said "Cancelled",
the process kept working, and the next job did not start. The signal is now
threaded through both ffprobe passes.

## An upload refused for a size it could have fitted

`fitBitrate` needs a duration and returns the encoding's own rate unchanged
without one — so a file whose duration ffprobe cannot read was encoded at full
rate and then refused by the provider for being too big. That happens to an
ordinary file: a container written to a non-seekable sink, which is what a live
recorder or a piped capture produces, never gets its Duration element filled in.

The bytes just written are the measurement — at a known constant bitrate, size
implies duration — so there is now one measured retry, and only when the encode
was blind *and* overshot. A file whose real duration is known and still does not
fit is one the provider genuinely cannot take.

Verified with a 90-minute MKV written to a pipe, which ffprobe reports as
`{"format":{}}`:

```
  ceiling: 17825792 bytes
  written: 15336625 bytes   fits: true
```

At the nominal 32k it would have been about 21.6 MB, and refused.

## And one that is not wired up yet

`stitch` in `engines/chunking.ts` has no importers — `planChunks` and `stitch`
exist for the day a file is too long for one pass. Its seam de-duplication drops
a later chunk's segment whenever the previous one ends more than 250 ms after it
starts, on the assumption stated in the header: the earlier chunk covers the
seam completely.

True of a segment lying inside the seam; false of one that begins inside it and
ends past it. Chunk N's audio stops at `chunk(N+1).startMs + overlapMs` and can
say nothing about what came after, so dropping chunk N+1's segment whole deletes
the only decode of that span. The transcript reads as a clean sentence with a
phrase missing from the middle — the worst shape this can take, because nothing
about the output looks wrong.

It now keeps the tail, cut at word boundaries because the words carry their own
times. `test/chunking.test.ts` is new, and pins it before the module is ever
connected: a module that is correct when it is wired up is worth more than one
debugged afterwards on somebody's four-hour recording.
