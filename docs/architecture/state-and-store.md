# State and the renderer store

## Main is the authority; the store is a mirror

There is exactly one store in the renderer — zustand, composed under
`src/ui/store/` and imported through that one path — and it holds everything the
UI draws: the job list, the model list, the provider list, the settings, and the
purely local bits (which panel is open, what is selected, what the drop zone is
currently doing).

None of that is the truth. The truth lives in main:

| What the UI shows | Who actually owns it |
| --- | --- |
| Jobs and their transcripts | the closure inside `createQueue()` (`electron/transcribe/queue.ts`) |
| Model states | `electron/services/model-store.ts` plus the bytes on disk |
| Provider states | `electron/services/settings.ts` and `credentials.ts` |
| Settings | `<userData>/settings.json` |

The store's job is to be **in step** with those, not to reason about them. It
never computes a job's next status, never decides that a download has finished,
never invents a percentage. Every mutation of mirrored state has exactly one
cause: an IPC reply, or an event from main.

The reason is not purity for its own sake. Main and the renderer would disagree
the moment they both tried to model the same state machine — main knows the
engine died, the renderer knows the user clicked Cancel two hundred milliseconds
earlier — and every one of those disagreements shows up as a row that is stuck,
duplicated, or showing a status the app is no longer in. One authority and one
mirror has no such failure mode.

The full inventory of where each piece of state lives, including the parts that
never reach the renderer at all, is the table in
[overview.md](overview.md#where-state-lives).

## The two event streams

`jobs:updated` and `models:updated` are the only main → renderer channels in the
app. Both carry **one whole record per event**, not a patch:

- `jobs:updated` fires on every status change, every stage change and every
  progress step — which for a local job means roughly one per percent of the
  extraction phase and one per percent whisper reports afterwards.
- `models:updated` fires while a download runs, rate-limited to about four
  events a second.

Two properties of those payloads shape the merge rule below:

**Every payload is a fresh object.** The queue's `snapshot()` copies the job and
its `progress` before handing it to a listener; it never emits the object it is
still mutating. It has to: if the renderer's previous and next job were the same
reference, every memoized selector would see no change and the row would freeze
at whatever percentage it was on when the reference was first captured.

**A record you have never seen can arrive at any time.** `jobs:enqueue` emits
each new job as it is created *and* returns the created jobs to the caller, so
the event routinely wins the race against its own IPC reply.

## The merge rule

For both streams, one rule:

> **Replace by id, in place. Keep the existing order. Prepend anything unknown.**

```
incoming.id is in the list  →  overwrite that entry, at that index
incoming.id is not          →  put it at the front
```

Three consequences, each of which is the point:

**Order never changes on an update.** A progress tick does not move a row. This
matters because the list is something a user is *watching*: they are reading the
third row while the second one ticks, and their pointer is already on the way to
a Cancel button. Re-sorting by status, by progress, or by "most recently
updated" — all of which look tidier in isolation — means rows swap under a
cursor mid-click, and the click lands on a different job than the one that was
under it when the mouse went down. There is no undo for "cancelled the wrong
two-hour job".

**A never-seen record is prepended, not appended.** An unknown id is always
newly created work (main has no other way to make one), and new work belongs
where the user is looking. It also makes the enqueue race harmless: whether the
event or the `enqueue` reply arrives first, the row appears once, in the same
place, because the second arrival finds the id and overwrites in place.

**The rule is idempotent**, which is what makes reconnection trivial: applying
the same record twice is indistinguishable from applying it once.

### Subscribe before you list

On mount, the order is: **subscribe first, then fetch the list, then merge the
list through the same rule.** Not the other way round.

Main starts sending as soon as anything changes and does not buffer — a job that
completes between an `await listJobs()` and a later `onJobUpdated(...)` is a row
that stays at 60 % forever, and only on a fast machine, and only sometimes. The
merge rule is what makes the overlap safe: an event that arrives before the list
is applied and then arrives again inside it lands on the same id twice, which by
the rule above is a no-op.

Every subscription returns its unsubscribe function (`onJobUpdated` and
`onModelUpdated` in `electron/api-types.ts` both do), and it must be called on
teardown. A `webContents.send` into a destroyed window throws in main; the queue
catches that and logs it rather than letting a listener take the job down with
it, but a leaked listener is still a leak.

### What the events do not tell you

**Removal has no event.** `jobs:remove` and `jobs:clearFinished` emit nothing at
all, and this is deliberate: `emit()` in the queue drops any event for a job no
longer in its map, because the store cannot distinguish "here is a change to a
job you have" from "here is a job you have not seen" — so an event for a deleted
job would *resurrect* the row it was trying to delete.

The store therefore drops those rows itself, when the IPC call resolves. That is
the one place mirrored state changes without an event from main, and it is safe
precisely because main guarantees no late tick can arrive to undo it.

**A model deletion is the same shape**: `models:delete` resolves, and the store
refreshes rather than waiting for an event about a file that no longer exists.

## What persists, and what does not

Settings are the one mirrored thing that outlives the window, and they round-trip
through main rather than being written by the renderer:

```
store  ──settings:save(patch)──▶  coerceSettings(patch, current)  ──▶  disk
store  ◀────── the merged Settings, as they were actually saved ──────┘
```

**The store adopts the returned object, never its own optimistic value.** Main
coerces field by field and clamps: a `maxConcurrentJobs` of 400 comes back as 8,
a `maxCharsPerLine` of 4 comes back as 10. A store that kept what it sent would
show a number the app is demonstrably not using, and the next save would write
the rejected value back. Optimistic UI is right for a slider's *visual*
position; it is wrong for the value the app then reasons about.

That coercion is also why a patch is safe to send: `settings:save` merges each
leaf against the current setting, so `{ output: { besideSource: false } }` keeps
the user's chosen formats rather than clearing them.

Persisted, in `<userData>/settings.json`: everything in `Settings`, plus per
provider the cached model list, the selected model and the last test result —
so the settings screen is right on relaunch without a network round trip.

Persisted elsewhere: API keys as ciphertext (`credentials.json`), model weights
(`<userData>/models/`), the log.

**Not persisted, deliberately: the job list.** A relaunch starts empty. The
scratch audio has been swept, the paths are no longer authorized (the allowlist
dies with the process), and a `done` row whose transcript was never exported
would be a row promising a file the app can no longer produce. Restoring rows
that cannot be retried, cancelled or exported is worse than restoring nothing.

## Narrow selectors

**A component subscribes to the smallest thing it can name.** For a list where
one row ticks several times a second, this is not an optimization — it is the
difference between a list that scrolls and one that does not.

The arithmetic is blunt. Every `jobs:updated` produces a new job object and
therefore a new array identity in the store. A component that selects the whole
array re-renders on every tick of every job. With six files queued and each
emitting on the order of a hundred progress events, that is the entire list —
every row, every progress bar, every formatted duration — re-rendering hundreds
of times for updates that concern one row.

So:

- The list component selects the **ids**, and nothing else.
- Each row selects **its own job** by id.
- A component that needs one field selects that field, not the record — a header
  showing "3 of 6 done" selects the count, so it re-renders three times over the
  life of the queue instead of six hundred.
- Where a selector must return a new object or array, it is wrapped in
  zustand's `useShallow`. zustand 5 compares with `Object.is`, so a selector
  returning a fresh array re-renders unconditionally otherwise — the "selector"
  looks narrow and is doing nothing at all.
- Anything derived from a job — the formatted duration, the label from
  `targetLabel`, the export filename — is computed in the row from the row's own
  job. Deriving it into store state adds a second thing to keep in step for no
  gain.

The same discipline applies to the model list, where a 3 GB download emits four
times a second for twenty minutes.

## What is deliberately not in the store

- **API keys.** They never cross the bridge in either direction. The store holds
  `hasKey` and `keyPreview` (`…a91f`) and nothing else, and a key typed into the
  settings field is passed straight to `testProviderKey` / `saveProviderKey`
  without being kept in state on the way.
- **A second copy of a transcript.** The transcript arrives once, attached to the
  job's `done` event, and lives on that job. Exports and the preview go through
  `output:render`, so the text on screen is the text main would write — the
  formatter (`electron/shared/exports.ts`) is pure and compiled by the renderer
  too, which is what makes that claim checkable rather than merely asserted.
- **Anything derived that a selector can compute.** Counts, filters, sorted
  views and the "can I start a job at all" predicate are selectors over the
  mirror, not fields beside it. A derived field is a second thing to invalidate,
  and the one that is missed is always the one on screen.


## Deleting a model asks first

`ModelsTab`'s Delete turns itself into `Delete <size>` plus `Cancel` rather than
acting on the first click. The files are between half a gigabyte and three
gigabytes and getting one back is a download, not an undo — on a slow connection
a mis-aimed click costs a quarter of an hour.

The confirmation is in-place rather than a modal on purpose: a modal steals focus
and asks about something that is already under the pointer. `Cancel` sits beside
the confirm rather than relying on a timeout, so a user who meant something else
always has a target.


## The target picker is a column, not a scrolling box

`TargetPicker`'s popover used to be one element with `max-h` and
`overflow-y-auto`, which meant the empty-state footer — the only way out of a
picker where nothing is installed and no key is stored — scrolled with the model
list and was clipped by the panel's own height. A user with nothing set up saw
half a button.

It is now a flex column: the groups scroll, the footer is pinned under them and
is always whole. `overflow-hidden` on the panel is what makes the rounded corners
clip the scrolling child, and `min-h-0` on that child is what lets it shrink
inside the column rather than forcing the panel past its `max-h`.

The footer's button is `.btn-primary-quiet`, not `.btn-primary`. The panel
already carries `shadow-modal`, and a halo on top of that is shadow over shadow —
it makes the button look like it is floating off the surface it belongs to.

Which edge the popover hangs from follows `.header-controls`: `.popover-anchor`
in `index.css` pins it to the same side, so it does not open off the left edge of
the window on Windows, where the controls sit left.


## The queue has no bulk actions

`JobList` shows a count and the rows, and nothing else. The two bulk actions it
used to carry — Clear finished and Export all… — were removed: everything you do
to a transcript you do to the job it belongs to, from that job's own row, where
the file name is there to confirm you picked the right one.

Two things are consequently unreferenced by the renderer and are kept
deliberately rather than by omission:

- `clearFinished` on the store, and its two i18n strings.
- `exportMany`, all the way down — the store action, the `DropScribeApi` method,
  the preload forwarder and the `output:exportMany` handler in main.

They are the machinery for batch work, they are tested, and the decision that
just landed was about the UI rather than the capability. If that decision holds,
deleting them is a separate, deliberate change — a bridge method with no caller
is surface a compromised renderer could still reach, and that is the argument for
removing them, not for leaving them indefinitely.


## State that follows a prop is adjusted during render

`react-hooks/set-state-in-effect`, which arrives with the plugin's v7, rejects a
`setState` called synchronously in an effect body. Two components were doing it,
and in both the effect was the wrong tool rather than a rule technicality: an
effect runs *after* the browser has been given a frame, so the render in between
paints state the component already knows is stale.

**`OutputTab`'s `NumberField`** keeps a text draft so that a half-typed number is
not clamped under the cursor. Typing `42` into a field with a minimum of 10
passes through `4`, and a clamp on every keystroke would snap that to `10` and
leave the `2` landing in a field that changed underneath. The draft is local and
the clamp happens on blur, but when the clamped value comes back from main the
field has to follow it. That sync is now the previous-value comparison React
documents for exactly this case:

```ts
const [lastValue, setLastValue] = useState(value);
if (value !== lastValue) { setLastValue(value); setDraft(String(value)); }
```

A `setState` during render is not the hazard it looks like: React discards the
in-progress render and re-runs the component before touching the DOM, so nothing
is painted twice, and `value` is a number compared with `!==`, so it cannot loop.

**`TranscriptView`** used to hold `text` and `error` as two pieces of state and
blank them at the top of the effect that fetched the next format. That gave one
painted frame where the SRT tab was selected and the plain-text body was still on
screen. The state is now a single object stamped with the request it answers:

```ts
const requestKey = jobId == null ? null : `${jobId}\u0000${format}`;
const current = rendered !== null && rendered.key === requestKey ? rendered : null;
```

Switching format changes the key, so the previous answer stops being current in
the *same* render that asks for the new one. The `cancelled` flag in the effect
stays, because it stops a late reply from being written at all, but staleness is
now structural rather than something a cleanup has to remember to prevent.
