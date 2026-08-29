<!--
Keep this short. The checklist is not ceremony: every box on it corresponds to
something that has actually shipped broken in a desktop app that reviewers could
not see from the diff — a change that only fails on the other OS, a behaviour
change nobody documented, a key pasted into a fixture.
-->

## What this changes

<!-- One or two sentences. What is different for a user of the app after this? -->

## Why

<!--
The reasoning, not the restatement. If it fixes an issue, link it: `Fixes #123`.
If you rejected an obvious simpler approach, say so here — that is the sentence
the reviewer most wants and least often gets.
-->

## How it was verified

<!--
"CI is green" is necessary and not sufficient for this app: none of the checks
run ffmpeg on a real file or launch the engine binaries. Say what you actually
put through it — which file, which container, which target — and on which OS.
-->

- Platform(s) tried: <!-- macOS 15 arm64 / Windows 11 x64 / both -->
- Target(s) exercised: <!-- local Whisper, local Parakeet, DeepInfra, Deepgram, ElevenLabs, OpenRouter, n/a -->
- Media used: <!-- e.g. 3 min mkv/opus, 90 min mp4/aac, n/a for a pure refactor -->

## Checklist

- [ ] `npm test && npm run typecheck && npm run lint` all pass locally. These three are the whole gate; CI runs the same three and nothing more forgiving.
- [ ] No `any`, and no optional property assigned `undefined` — `exactOptionalPropertyTypes` means it is spread conditionally or it is absent.
- [ ] All new transcript timing is integer milliseconds, converted exactly once at the adapter boundary.
- [ ] No API key, no personal file path, and no customer media in the diff, in a fixture, in a test snapshot, or in a screenshot attached here.
- [ ] Nothing new is logged that could contain a key — including a request URL with a token in the query string.
- [ ] **Behaviour change → `docs/` updated in this PR.** If a user could notice the difference, some page under `docs/` is now wrong; fix it here rather than promising to.
- [ ] **Non-trivial bug fix → `docs/bugs/NNNN-slug.md` added.** Next number in the directory, and it explains the actual cause, not the symptom. See CONTRIBUTING.md.
- [ ] A regression test exists for the bug being fixed, and it fails without the fix.

<!--
Not every box applies to every PR. Strike through the ones that do not rather
than leaving them ambiguous — an unchecked box that turns out to be irrelevant
costs a review round-trip.
-->
