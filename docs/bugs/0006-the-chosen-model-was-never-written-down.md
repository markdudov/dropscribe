# 0006 — Opening a file from Finder said there was nothing to transcribe with

## Symptom

Download a model, pick it in the target picker, quit the app. Double-click a
video in Finder, or use Open With → DropScribe, or pass a file on the command
line. The app opens and shows:

> **DropScribe has nothing to transcribe with yet.**
> Download a local model or add a provider key in Settings, then open “…” again.

The user had done exactly that. The picker in the window showed the model by
name at the same moment.

## Root cause

`flushPendingFiles` in `electron/main.ts` handles `open-file`,
`second-instance` and `process.argv`. It reads `getSettings().defaultTarget` —
main's own settings, not the renderer's store, because at that point there may
not even be a window yet.

`defaultTarget` was **never written by anything**. `setTarget` in the renderer
store set local state and stopped there:

```ts
setTarget: (target) => { set({ target }); },
```

So the field held its initial `null` for the life of the app, on every machine,
and every externally-opened file met that dialog.

The read side was already complete: `pickInitialTarget` reads `defaultTarget`,
re-validates it against the models actually installed and the keys actually
present, and explains in a comment why it must be checked rather than trusted.
The i18n files even carry `settings.defaultTarget.label` and
`.none` — "Default for new files", "Ask every time". Everything about this
feature existed except the write.

## The fix

`setTarget` persists the pick. Fire-and-forget: the choice has already taken
effect locally, and a settings write that fails should not undo it or interrupt
the drop the user is about to make.

## How it was found

The static review flagged it; running it settled it. Picking a target through
the real picker in the running app and then reading `getSettings()` back showed
`defaultTarget: null` before and after — while the button showed the model.

## Test

Verified end to end against the running app rather than in a unit test: the
store has no test harness, and the thing worth checking is precisely that the
renderer's action reaches main's settings file. Picking a target now yields
`{ kind: 'local', modelId: 'whisper-large-v3-turbo' }` from `getSettings()`.
