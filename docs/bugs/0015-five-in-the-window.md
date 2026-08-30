# 0015 — Five in the window: a swallowed error, a lost number, a green verdict for the wrong key

## An error the queue wrote down and the row never showed

`queue.ts` deliberately records a failure on a job that **succeeded** when the
automatic export cannot be written, and explains itself:

> failing to write a file into a read-only folder must not throw away the
> expensive thing, so this failure is reported on an otherwise successful job
> rather than turning the whole job red

`JobRow` rendered that block only when `status === 'failed'`. So the transcript
was safe, the file was never written, and nothing anywhere said so.

Reproduced by pointing the output directory at a `chmod 0555` folder. Before:
the row read `0:00 long · Whisper large-v3-turbo (local) · took 0:02` and
nothing else. After:

```
  The transcript is finished, but the export files could not be written.
  The system refused access…
  The transcript itself is fine — open it with View, or export it somewhere else.
```

Amber rather than red, because the transcription worked and is one click away.

## A number typed and thrown away

`NumberField` commits its draft on blur, and Enter blurs. **Escape and a click
on the backdrop close the modal without one**, so a number the user had just
typed went nowhere, silently. Typing 38 into "Longest line" and pressing Escape
left it at 42.

The draft is now committed on unmount as well, from a ref so the cleanup does
not see the props of the first render. Verified: type 38, press Escape, read the
settings back — 38.

## Green for a key that was never tested

`onTest` applied its verdict without checking that the key it tested is still
the one in the field. Paste key A, press **Test connection**, paste key B while
it is thinking: the answer about A was shown against B. Green is the worst
direction for that to fail in, because **Save** only appears once the phase is
`passed`.

The tested value is captured and compared against a ref of the current one
before anything is shown. The ref is written in an effect, not during render —
`react-hooks/refs` forbids the latter, and it is right to.

## A row that jumped backwards

`addFiles` merged the array `enqueue` returned into the job list with
`mergeById`, which replaces an entry wholesale. That array is a snapshot from
before the `await` returned, and `job:updated` for those ids may already have
arrived — a short file can be extracting, or done, by then. The stale `queued`
was written back over it.

The reply's job is to make the rows exist; everything after that belongs to the
events. It now inserts only ids that are not already there.

## The second identical failure that nothing acknowledged

The dismissal timer's effect depended on the notice text. Two files failing the
same way set the identical string, so the effect did not re-run and the second
failure inherited whatever was left of the first one's six seconds — sometimes
nothing — while the banner already on screen showed those very words. The user's
second file failed and the app appeared not to notice.

Every notice write now bumps a counter that the effect also depends on. All
twenty-two of them: `setNotice` was the smaller half, and the direct
`set({ notice })` calls scattered through the store were the rest.

Verified against the real store: setting the same message twice takes the
sequence 0 → 1 → 2.

## A model armed before it existed

`downloadModel` armed the drop zone with the model it had just fetched. That
promise settles when the download **stops**, which includes the user cancelling
it, so a cancelled download left an uninstalled model as the target and the next
drop failed naming a file that is not there. It now arms only what
`refreshModels` reports as installed.
