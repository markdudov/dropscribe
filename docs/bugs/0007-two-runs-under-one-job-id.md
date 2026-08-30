# 0007 — Try again could start a second run while the first was still dying

## Symptom

None that a user reported, and none this machine could be made to show. That is
the honest headline, and the reason this entry exists anyway is below.

## What is actually wrong

`cancel()` flips a job to the terminal status `cancelled` the instant the click
arrives. The child process does not stop then — it stops when it notices the
signal. `electron/engines/whisper-cpp.ts` says so itself:

> whisper only notices a signal between decode windows, and one window of a
> large model can run for several seconds

During that drain the run is still in `controllers` and `running` has not been
decremented. `retry()` decided purely on `job.status`, and `pump()` guarded only
on `running >= limit` and `job.status !== 'queued'`. So with **Files at once**
set to 2 or more — a setting the UI offers, 1 to 8 — a retry inside the drain
window satisfied every condition and called `begin()` a second time for the same
`Job` object and the same id.

Both runs then resolve to the same scratch directory, because `jobTempDir`
derives it from the job id alone. The older run's `finally` was unconditional:

```ts
controllers.delete(job.id);   // removes the NEWER run's AbortController
cleanupJobTemp(job.id);       // recursive delete of the directory it is writing
```

## What could and could not be reproduced

The second `begin()` is there by construction — every condition in `pump()` was
satisfied, and nothing anywhere checked whether a run already existed for the id.

The *harm* could not be produced. Ten cancel-then-retry cycles at delays from
0 ms to 2900 ms, on a 110-second file with `whisper-large-v3-turbo`, all
completed with a correct 60-word transcript, no orphaned process and no leftover
temp file. Turbo notices SIGTERM quickly, so the older run's `finally` had
already finished before the newer run created anything to destroy. The window
that the engine's own comment describes — several seconds, on a large model —
was not reachable with the model installed here.

So: a real defect, a window the code documents, and a harm that needs a slower
engine or a slower machine than the one it was hunted on. Recorded rather than
dismissed, because "I could not trigger it" is not "it cannot happen".

## The fix, and the second bug it exposed

`pump()` now skips a job whose id still has a controller. Skipping rather than
refusing: the job stays `queued`, and the `pump()` in the draining run's own
`finally` picks it up the moment the id is free, so the click is honoured just
not instantly. `begin()`'s `finally` additionally cleans up only when the
controller registered for the id is still its own.

That guard immediately broke the retry at 0 ms delay, and the breakage was
informative. The draining run's `catch` called `markCancelled(job)`, which wrote
`cancelled` over the `queued` that `retry()` had just set. `pump()` then found
nothing queued and the row sat at "Cancelled" having been asked to try again —
the click lost outright. Before the guard this was invisible only because the
race started the second run before the clobber happened.

So the `catch` now checks whether the job has been re-queued since this run
started, and stays silent if it has. What a dying run has to say about how it
ended stops being interesting the moment the job has been asked for again.

## Do not undo

- `pump()`'s `controllers.has(job.id)` check and the `catch`'s `reQueued` check
  are one fix in two places. Removing either brings back a different half of it.
- The `finally` must not clean up unconditionally. `cleanupJobTemp` is a
  recursive directory remove keyed only by the job id.

## Test

Not a unit test: `queue.ts` reaches `ffmpeg.ts`, which imports `electron`, and
the repository has no main-process test harness. Verified against the running
app instead — cancel, then Try again at 0, 10, 50, 200, 800, 2000 and 2900 ms,
seven times over, each ending `done` with a correct transcript, zero orphaned
engine processes and zero leftover temp files.
