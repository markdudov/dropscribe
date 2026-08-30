# 0012 — Long cloud jobs failed after the provider had done the work and billed it

## Symptom

A recording long enough that the provider takes more than five minutes to
answer fails with:

> Could not reach api.example.com. Check your internet connection and try again.

The connection was fine. The provider transcribed the file and charged for it.
**Try again** uploads it and charges again.

## Root cause

Global `fetch` in Node — and so in Electron's main process — is undici, and
undici applies a `headersTimeout` of 300 seconds by default. Nothing in this
codebase asked for it, and `abortableFetch`'s own comment says the opposite:

> There is deliberately no timeout. A 90-minute recording legitimately keeps the
> connection open for minutes with nothing on the wire, and every fixed timeout
> we could pick would be wrong for either the long files or the short ones.
> Cancellation is the user's timeout, and it is always available.

The clock is refreshed when the request body has finished uploading, so the
whole 300-second budget is **provider think-time**. A provider that transcribes
synchronously and answers after five minutes has its socket destroyed with
`UND_ERR_HEADERS_TIMEOUT`.

`openrouter.ts` sets `TRANSCRIBE_TIMEOUT_MS = 15 * 60_000` and never got it: the
socket died at five.

Nowhere in `electron/`, `src/` or `scripts/` is a dispatcher configured, so
every provider request inherited the default.

## Measured

Against a loopback server that consumes the upload and then holds response
headers for 310 seconds, from an Electron main process:

```
  global fetch : THREW after 301123 ms   UND_ERR_HEADERS_TIMEOUT
  net.fetch    : OK 200 after 310033 ms
```

## The threshold, since "always fails" would overstate it

The budget is time-to-first-byte after the upload, so the shortest file that
fails is about `300 × R` seconds of audio at a provider real-time factor of R:

| R | shortest failing recording |
| --- | --- |
| 5× | 25 min |
| 10× | 50 min |
| 20× | 100 min |
| 40× | 200 min |

A fast Deepgram job usually returns inside the window. A queued GPU, a
diarizing model, or ElevenLabs Scribe on a long file does not.

## The fix

`longFetch` in `providers/types.ts` uses Electron's `net.fetch`, which goes
through Chromium's network stack and has no equivalent ceiling. It also honours
the system proxy and certificate store, which matters to anyone behind a
corporate one. Global `fetch` remains as a fallback for the tests, which import
the module outside Electron.

`abortableFetch` uses it — so DeepInfra's transcription and every Deepgram call
— and the two adapters that call `fetch` directly for transcription, ElevenLabs
and OpenRouter, were switched too. The short metadata calls (subscription, user,
the OpenAPI document) were left alone: they have their own deadlines and no
reason to wait five minutes.

Cancellation is unchanged. `net.fetch` takes the same `AbortSignal`, and the
comment above is still the policy: the user's Cancel is the only timeout this
layer should have.

## The project already half-knew

`elevenlabs.ts:210` names the mechanism exactly — the STT endpoint holds the
connection for the whole transcription, and "Node's default five-minute header
timeout can fire on a multi-hour file even though nothing is actually wrong" —
and maps `UND_ERR_HEADERS_TIMEOUT` to an honest sentence. An honest sentence on
one adapter of four, which did not stop the job failing. The other three blamed
the user's router.

## Test

Verified end to end against the running app rather than in a unit test: the
transport is the thing being changed, and a mock proves nothing about it. All
four providers were given a junk key and all four came back with the provider's
own rejection over real HTTPS — Deepgram 1018 ms, DeepInfra 557 ms, ElevenLabs
373 ms, OpenRouter 69 ms — which exercises `longFetch` for headers, auth and
error bodies. The 310-second measurement above is the timeout itself.
