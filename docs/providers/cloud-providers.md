# Cloud providers

Four providers, four completely different APIs. What they have in common is only
what `electron/shared/providers.ts` declares: a key can be tested, models can be
listed, and a file can be transcribed into the one `Transcript` shape. Everything
else — the auth header's *name*, whether the model list needs a key at all,
which of five error envelopes comes back — lives in one adapter under
`electron/providers/` and never escapes it. That containment is what makes
adding a fifth provider a one-file change.

This document is one section per provider, each answering the same six
questions: **auth header · validation endpoint · model listing · the
transcription request · the response shape · the trap**. The trap is the part
worth reading. Every one of these APIs has a behaviour that produces a working
build with a silent, wrong result, and each of them cost time before it was
found.

Two rules apply to all four and are enforced in `providers/types.ts`:

- **A key travels in a header and nowhere else.** Never a query string, never an
  error message, never a URL that gets logged — a key in a query string is
  printed by every proxy and every crash reporter. `abortableFetch` takes the URL
  and the init separately and never interpolates the init into an error;
  failures name `new URL(url).host` and nothing more.
- **One vocabulary for failure.** If DeepInfra reported dead Wi-Fi as "fetch
  failed" and Deepgram reported it as "TypeError", one broken router would look
  to the user like two different problems. One fetch wrapper, one status-code
  vocabulary, one error-body reader.

There is also deliberately **no request timeout** in the shared wrapper. A
90-minute recording legitimately holds a connection open for minutes with
nothing on the wire, and any fixed timeout we could pick would be wrong for
either the long files or the short ones. Cancellation is the user's timeout, and
it is always available.

---

## DeepInfra

`electron/providers/deepinfra.ts`

DeepInfra offers two ways in: a native `/v1/inference/{model}` route and an
OpenAI-shaped `/v1/openai/audio/transcriptions` route. The native one is richer —
`task=translate`, `initial_prompt`, `chunk_level`, and a per-request billed
`cost` — and it is still the wrong choice. The OpenAI-shaped route is the one
DeepInfra's own model docs use, the one every client library targets, and the
one whose response shape appears in the published OpenAPI spec. Being boring is
worth more than `initial_prompt`.

**Auth header.** `Authorization: Bearer <key>`, built in exactly one function
(`checkKey`) that no other code path is allowed to bypass. It strips a leading
`Bearer ` the user pasted along with the key (dashboard copy buttons take the
whole curl header value), rejects a key containing whitespace or a line break,
and rejects one containing anything outside printable ASCII — smart quotes and
non-breaking spaces arrive routinely from a key copied out of a chat app or a
PDF, and they make `fetch` throw a bare `TypeError` about an invalid header
value rather than anything a user can act on.

**Validation endpoint.** `GET /v1/openai/models`. Chosen because it is free,
cheap and instant — transcribing a one-second file to test a key would bill the
user for the privilege. A 200 is treated as *necessary but not sufficient*: the
body must also contain a `data` array, because a hotel captive portal answers 200
to everything with a login page, and "your key works" is the last thing to say in
that situation.

**Model listing.** `GET /models/list` — the *native* catalogue, not the
OpenAI-shaped one, because it carries `type`, `deprecated` and a `pricing` block
with a real per-second rate that `/v1/openai/models` does not expose in any
documented form. **The key is deliberately not sent**: the endpoint is public and
returns an identical catalogue with or without it, so the secret simply never
enters the code path — and the model picker works, prices and all, before the
user has pasted anything.

All filtering is client-side, because DeepInfra's query parameters silently do
nothing: `?type=automatic-speech-recognition` returns all ~368 models, not the 7
speech ones. Sending it would look like it worked and would quietly offer the
user an image model to transcribe with. So the adapter keeps
`type === 'automatic-speech-recognition'`, drops anything with a truthy
`deprecated` (the seven retired Whisper variants all carry a timestamp there and
all now redirect to `whisper-large-v3`, so offering them would bill a model the
user did not pick), takes the id from `model_name`, and converts
`pricing.cents_per_input_sec` to USD per minute (`× 60 ÷ 100`).

**Transcription request.** `POST /v1/openai/audio/transcriptions`, multipart:

| Field | Note |
| --- | --- |
| `file` | the Opus file the queue prepared, sent with its real basename so the extension matches the blob's MIME type |
| `model` | the catalogue id |
| `response_format` | `verbose_json` — **required**; see the trap |
| `timestamp_granularities[]` | `segment`, plus `word` when the user wants word timings. The literal square brackets are not a typo |
| `language` | only when the user pinned one. Absent means "detect", which is what makes a mixed-language drop folder work |

No `Content-Type` header is set by hand: `fetch` derives `multipart/form-data`
*and* the boundary from the `FormData` body, and setting it manually omits the
boundary, after which the server reports every field as missing.

`diarize` and `translate` cannot be honoured — this endpoint has neither — so
`listModels` reports both capabilities as an explicit `false` and the UI greys
the toggles. Dropping them silently at request time is the least-bad remaining
behaviour, and better than failing a job over a global toggle the user set for
Deepgram.

**Response shape.** `{ text, segments: [{ start, end, text }], words: [{ word,
start, end }], language, duration }`, with all times as fractional seconds
(converted to integer milliseconds exactly once, in `buildTranscript`). Two
quirks: `language` is a full English **name** (`"english"`, `"bulgarian"`),
which is mapped back to ISO-639-1 through Whisper's own code→name table plus its
alias list, returning `null` rather than a guess for anything unrecognised; and
`words` is a **flat top-level array**, not nested inside its segment, so the
association is rebuilt in one forward pass. Words are placed by their
**midpoint**, not their start, because Whisper routinely emits a segment's first
word starting a few tens of milliseconds *before* the segment itself — matching
on the start would push that word into the previous segment and read as an
off-by-one error in every subtitle file.

> ### The trap: DeepInfra answers 200 to a missing or malformed key
>
> `Authorization: <key>` — the header **without** the literal `Bearer ` prefix —
> is not rejected. It is treated as if no `Authorization` header had been sent at
> all. And `GET /v1/openai/models` serves anonymous callers: HTTP 200, full
> catalogue. Exactly what a valid key returns.
>
> A key-checking function that builds the header wrong therefore reports **every
> key as valid, including the empty string**, and the user finds out when their
> first real transcription 401s ten minutes later.
>
> The defence is that an empty or malformed key is **rejected locally, before any
> request is made** — `testKey` returns `{ ok: false }` from `checkKey` without
> touching the network. There is no server-side check to fall back on here; that
> branch *is* the check. The header is also asserted to start with `Bearer ` after
> it is built, which can only fail if someone edits the line above it — which is
> precisely when it should fail.
>
> A second, smaller trap sits beside it: without `response_format=verbose_json`
> the route returns `{ "text": "..." }` and nothing else — no segments, no
> language, no timings — and a client that forgets it gets a plausible transcript
> with no subtitles in it. A third: `timestamp_granularities[]` needs the literal
> brackets, exactly as DeepInfra's own curl examples send them. The bare name is
> ignored, which costs every timestamp in the response.

---

## Deepgram

`electron/providers/deepgram.ts`

Three endpoints are in play and they behave nothing like each other, which is
most of why this adapter is the longest of the four.

**Auth header.** `Authorization: Token <key>`. **Not `Bearer`.** Built in one
`authHeaders()` used everywhere, never a hand-written literal.

**Validation endpoint.** `GET /v1/auth/token`. Chosen because `GET /v1/models`
is *completely public* — a "test" built on it would accept every string the user
typed. `/v1/auth/token` costs no transcription credits and answers on the status
code alone; its success body is undocumented, absent from the OpenAPI spec, and
is deliberately **not parsed**, because any field name read out of it would be a
guess that can break without notice. Its 401 body is `text/plain` — literally
`Invalid credentials.` — so `response.json()` there throws and hides the real
answer behind a parse error; the adapter reads text and drains it.

`GET /v1/projects` is then called for the "connected as" line, and **its failure
is never a failed test**. Deepgram keys carry scopes, and a key minted for
transcription alone legitimately lacks `project:read`: it will transcribe
perfectly and still be refused there. Treating that as a bad key would lock out
exactly the narrowly-scoped keys a security-minded user creates, so a failure
degrades to "no project name" and the test carries on.

**Model listing.** `GET /v1/models`, public, no key sent (sending a header it
does not read would only widen where the key travels). The response is a
443-row `stt` array which is folded into one entry per pickable model:

- rows without `batch: true` are dropped — they are streaming-only, and this is
  also what keeps Flux out of the list;
- rows are grouped by **`canonical_name`**, and the union of each group's
  `languages` arrays is the model's real coverage. `nova-3-general` alone appears
  77 times with different language arrays;
- `multi` is prepended for multilingual models: it is a real, documented value
  for `?language=` that turns on code-switching, and it appears nowhere in
  `/v1/models`' own language arrays, so a list built purely from the response
  would never offer it;
- the family is derived from the canonical name, **not** from the `architecture`
  field, which is not self-consistent: every `enhanced-*` model reports
  `polaris`, `phoneme` reports both `base` and `unknown` across its rows, and
  `nova-general` reports `nova` on some rows and `nova-2` on others;
- `pricePerMinuteUsd` is deliberately absent. `/v1/models` carries no pricing,
  Deepgram's rates vary by plan, and a hard-coded number in a shipped desktop app
  would eventually lie to the user about their own bill.

**Transcription request.** `POST /v1/listen`, with the audio as a **raw body**
(not multipart) and everything else in the query string:

| Parameter | Why |
| --- | --- |
| `model` | always set. The API's own default is `base-general`, the oldest and cheapest tier, so an omitted parameter silently downgrades every job |
| `smart_format`, `punctuate`, `paragraphs` | all three sent explicitly even though `smart_format` implies the others, so a change to any one of them cannot quietly turn punctuation off. `smart_format` is what produces the `punctuated_word` field the parser depends on |
| `utterances` | the segmentation source, see below |
| `language` **or** `detect_language=true` | without one of them the API defaults to `language=en` and transcribes Bulgarian audio as garbled English rather than failing |
| `diarize_model=latest` | the **only** diarization parameter this adapter ever sends |

The `Content-Type` header is set explicitly from the file's extension, and its
fallback must never be `application/json` — that is the header that switches
`/v1/listen` into fetch-this-URL mode, where the binary body is read as JSON and
comes back as "corrupt or unsupported data".

The synchronous request is the only option: the async `callback=` flow needs a
public HTTPS endpoint to deliver to, and Deepgram does not store transcripts, so
a desktop app with nowhere to receive the callback would simply lose the result.

**Response shape.** `results.channels[0].alternatives[0]` carries `transcript`
and a flat `words[]` of `{ word, punctuated_word, start, end, confidence,
speaker }` in fractional seconds. Segments are taken from `results.utterances`
first — utterances break on speaker turns and on pauses longer than `utt_split`,
which is exactly the boundary a subtitle wants, and they carry their own words so
no time-window matching is needed. `alternatives[0].paragraphs.paragraphs` is
the fallback (paragraphs break on sentence flow and happily run one speaker's
whole answer together, and carry no words, so the flat word list is walked with a
cursor); the whole channel as one segment is the last resort, which is what comes
back for a non-space-delimited language where `paragraphs` does nothing.
`punctuated_word` is preferred over `word` — the published schema declares it
only on utterance words, but the live API returns it on channel words too
whenever smart_format or punctuate is on, and this adapter always turns both on.

Error bodies come in **three** dialects: plain text from `/v1/auth/token`, legacy
`{err_code, err_msg, request_id}` from `/v1/listen`, and modern
`{category, message, details, request_id}` from `/v1/projects`. The `dg-error`
and `dg-request-id` response headers are read as a last resort, because even an
empty body still identifies the request — which is the only thing Deepgram
support can act on.

> ### The traps: three of them, all silent
>
> **1. `Token`, not `Bearer`.** `Bearer` is a *valid* scheme at Deepgram — it is
> what the short-lived JWTs from `/v1/auth/grant` use — so a request sending
> `Bearer <api key>` is not met with "wrong scheme". It gets a plain 401,
> indistinguishable from a bad key, and sends you to regenerate a perfectly good
> credential.
>
> **2. `canonical_name` is the model id; `name` is not.** Four different models
> are *named* `general`: `nova-3-general`, `nova-general`, `enhanced-general`, and
> base's own `general`. A picker built on `name` produces four identical rows and
> sends an ambiguous string the API cannot resolve.
>
> **3. Deepgram REJECTS a request that sets `diarize` together with
> `diarize_model`.** `diarize=true` is deprecated and always routes to the v1
> diarizer; `diarize_model` both enables diarization *and* selects the model. The
> natural instinct — send both, "for compatibility" — fails the whole job. So
> `diarize_model=latest` is the only diarization parameter this adapter sends. Do
> not add `diarize` back.
>
> A fourth worth knowing: a **504 is not a file-length limit.** Deepgram budgets
> about ten minutes of *processing* per synchronous request (twenty for Whisper
> models), so how long a file may be depends on the model's speed and on
> Deepgram's load that minute. The same file can succeed on a retry and will
> certainly succeed on a faster model, which is why that error says both things
> out loud. And Whisper Cloud has **no diarizer at all** behind it, so the adapter
> drops a diarization request for Whisper models rather than have the whole job
> rejected — the model list already advertises `diarization: false` there, which
> is how the UI explains the missing speaker labels.

---

## ElevenLabs

`electron/providers/elevenlabs.ts`

**Auth header.** `xi-api-key: <key>`. Not `Authorization`, no `Bearer` prefix. A
request sending `Authorization: Bearer …` is treated as an *unauthenticated*
request, so the failure surfaces as "no key sent" (`code:
needs_authorization`) rather than "wrong header" — which the adapter turns into
the message *"ElevenLabs received no API key with the request"*, because that is
a bug in this app rather than a bad key and the user should not go regenerate a
working credential over it.

**Validation endpoint.** `GET /v1/user/subscription`. The cheapest authenticated
call in the API: it costs no credits and answers both "is this key good" and
"whose account is this" in one round trip. `GET /v1/user` follows for the key
preview, and both are on a 20-second deadline. The reported character quota is
the **text-to-speech** allowance, not a speech-to-text budget — Scribe is billed
by the hour and the subscription endpoint has no hours field — so it is shown as
a way to recognise *which* account this is, never as a transcription budget.

Only the last four characters of `xi_api_key_preview` are kept.
`KeyTestResult` is persisted to `settings.json`, this app cannot verify how much
of the key that preview contains, and nothing capable of reconstructing a key is
allowed to reach disk.

**Model listing.** **There is no speech-to-text model-list endpoint.**
`GET /v1/models` is the *text-to-speech* catalogue and carries no STT flag of any
kind, so filtering it would be guesswork. The only authoritative machine-readable
list of accepted STT model ids is the `model_id` **enum inside the public
OpenAPI document**, so `listModels` fetches `GET /openapi.json` (public, no key,
~2 MB, cached for six hours) and walks
`paths./v1/speech-to-text.post.requestBody.content.multipart/form-data.schema.properties.model_id.enum`.

Every step of that walk is checked rather than asserted: surviving a
restructured document is the entire reason the function is written that way. If
the enum ever moves behind a `$ref`, the walk returns `undefined` and the caller
falls back to the hardcoded `['scribe_v2', 'scribe_v1']` instead of throwing on a
background refresh. Ids containing `realtime` are filtered out — those live in
the WebSocket API and 422 on this endpoint. Only a real answer is cached; caching
the fallback would hide a recovered network for six hours.
`scribe_v1_experimental` is deliberately *absent* from the fallback: it was
removed from the enum and sending it now fails validation.

**Transcription request.** `POST /v1/speech-to-text?enable_logging=false`,
multipart with `model_id`, `file`, `timestamps_granularity=word`,
`tag_audio_events=false`, plus `language_code` and `diarize` when asked. The file
is streamed off disk with `openAsBlob` rather than read into a Buffer — reading
it first would put an entire movie in the main process's heap for the length of
the upload.

**Response shape.** `{ language_code, language_probability, text, words: [...],
audio_duration_secs }`, or `{ transcripts: [...] }` with no top-level `text`
when `use_multi_channel=true` (this app never asks for that; the branch exists
because a future option flipping the shape would otherwise produce a silently
empty transcript). Each entry of `words` has a `type` of `word`, `spacing` or
`audio_event`, and a `logprob` — a natural log, so `Math.exp()` puts it back on
0..1 for `Word.confidence`.

The `spacing` entries are **consumed, not dropped**. They carry the actual
whitespace, and joining words with `' '` instead looks identical in English and
is wrong in Japanese, Chinese and Thai, where the model emits no spacing at all
and a space-joined transcript reads as broken. So spacing never becomes a `Word`
— it becomes the separator between two of them.

> ### The traps
>
> **1. `tag_audio_events` defaults to TRUE.** Left alone, the response contains
> `type: 'audio_event'` entries whose text is `(laughter)`, `(applause)`,
> `(music)` — and those go straight into the word stream, and from there into the
> user's `.srt` and into a burned-in subtitle. Useful in a transcript you read,
> actively harmful in a subtitle file. The adapter sends `false` explicitly, and
> the same constant drives both the request field and the response filter, so the
> two can never disagree about it.
>
> **2. There is no STT model-list endpoint.** The ids come from the public
> OpenAPI enum, as described above. A reader who assumes `GET /v1/models` is the
> list will ship a picker full of TTS voices.
>
> **3. `enable_logging` is a QUERY parameter, not a multipart field.** Several of
> ElevenLabs' own doc pages put it in the body, where it is **silently ignored** —
> and being ignored means the opposite of what this app promises, because the
> server-side default is retention. DropScribe's entire premise is that people
> drop private recordings — interviews, therapy notes, legal calls — onto a
> window on their own machine, so zero-retention is the only correct default here.
> Anyone who wants the transcript kept in their ElevenLabs history can use the
> ElevenLabs web app; this app does not get to make that choice for them. That is
> why the constant is `${API_ROOT}/v1/speech-to-text?enable_logging=false` — the
> parameter is baked into the URL where nobody can move it into the form.
>
> Two smaller ones. **Scribe labels every word `speaker_0` even when diarization
> was not requested**, so speaker labels are kept only when `options.diarize` was
> set — carrying them through unconditionally would make a non-diarized
> transcript look diarized and prefix every subtitle line with a speaker name.
> And **422 uses a different error envelope**: `detail` is an *array* of
> `{loc, msg, type}` there, not an object, so a parser that only knows
> `detail.message` reports an empty reason for exactly the failures that carry the
> most useful reason.

---

## OpenRouter

`electron/providers/openrouter.ts`

This adapter was written against the live API on 2026-08-29, because the shape of
OpenRouter's audio support has moved more than once and guessing it from memory
produces a plausible-looking adapter that never works. The design note the code
was written from anticipated a chat-completions `input_audio` workaround. **That
is not what is there.**

`POST /api/v1/audio/transcriptions` answers the auth middleware's
`{"error":{"message":"…","code":401}}` when called without a key, exactly as
`/chat/completions` and `/embeddings` do — while a route that does not exist
(`/audio/translations`, `/totallyfake`) falls through to the marketing site's
Next.js 404 HTML. So OpenRouter has a **first-class STT route**, documented at
`openrouter.ai/docs/guides/overview/multimodal/stt`, and that is what this
adapter uses.

**Auth header.** `Authorization: Bearer <key>`, plus two attribution headers,
`HTTP-Referer: https://github.com/markdudov/dropscribe` and `X-Title:
DropScribe`. Those are optional and carry no user data; they are sent because
omitting them makes every DropScribe request indistinguishable from a scripted
one, which is how traffic ends up rate-limited more aggressively.

**Validation endpoint.** `GET /api/v1/key` — the only endpoint that works with
an ordinary inference key. `GET /api/v1/credits` looks like the better source of
a balance and requires a **management** key, a different credential the user has
no reason to own; testing with it would 401 and reject perfectly good keys.
Verified status codes: no header at all gives 401 *"No cookie auth credentials
found"*; a well-formed but unknown key gives 401 *"User not found."*; both as
JSON, and there is no 403 path for a merely invalid key.

The response is also checked for `is_management_key === true`, which is
**rejected**: such a key authenticates cleanly and cannot run inference, so
without that check it would pass the test and fail on the first job. The `label`
field is whatever the user named the key, and OpenRouter's own default for it is
a truncated key like `sk-or-v1-au7...890` — safe, and the same "which key is
this" hint `keyPreview()` gives — but anything matching intact key material is
dropped rather than shown, because this string is persisted into `settings.json`
inside `lastTest`.

**Model listing.** `GET /api/v1/models?output_modalities=transcription`,
**without the key**. That is not laziness: the endpoint was verified to ignore
the `Authorization` header entirely — a syntactically valid but nonexistent key
still receives a 200 and the full list — so sending it would add the only way
this call could fail for an auth reason, and `listModels` runs on every settings
refresh, where a spurious 401 would look to the user like their key had been
revoked.

Ranking is not taste (see the next paragraph). `openai/`-prefixed models sort
first, the rest by catalogue order. **Every model reports no price**, and the
reason is worth stating so nobody "fixes" it by multiplying `pricing.prompt` by
sixty: STT models carry only `prompt` and `completion`, and the *unit* of
`prompt` is not in the response — it is whatever the upstream provider bills in.
Three endpoints of the *same* model, `openai/whisper-large-v3`, report
0.0000075, 0.0015 and 0.111, which OpenRouter's own model page renders as
"$0.000008/second" (DeepInfra), "$0.0015/minute" (Together) and "$0.111/hour"
(Groq). Read as one unit they differ by a factor of fifteen thousand; read with
their real units they all land between $0.0005 and $0.002 a minute. The unit
lives in the web UI and nowhere in the JSON, and which endpoint a request lands
on is decided at routing time — so there is no per-model answer to give even if
the unit were known. `usage.cost` in the response is the truthful figure, and it
is only knowable after the fact.

**Transcription request.** JSON, **not multipart**:

```json
{
  "model": "openai/whisper-large-v3-turbo",
  "input_audio": { "data": "<raw base64, no data: URI prefix>", "format": "ogg" },
  "language": "bg",
  "response_format": "verbose_json",
  "timestamp_granularities": ["segment", "word"]
}
```

The multipart path exists for OpenAI-SDK compatibility and is capped at 25 MB;
the base64 JSON path is the documented one for larger files. The adapter caps the
audio at **17 MiB before encoding** — OpenRouter documents exactly one number,
25 MB, attaches it to the multipart path, and says only that the JSON path is
where "larger files" go without ever saying how much larger, so this stays under
the one published figure whichever side of the encoding it is measured on. In
practice it never bites: the queue hands over 16 kHz mono Opus at ~12 kbps, so
17 MiB is about three and a half hours of speech. The cap exists for the case
where something upstream passes an uncompressed WAV, which fills it in nine
minutes. It is checked *before* encoding, because base64 inflates by 4/3 and the
point is never to build the oversized string at all.

`format` is a **bare token**, not a MIME type (`ogg`, `wav`, `flac`, `m4a`,
`webm`, `aac`, `mp3` — Opus-in-Ogg is declared as `ogg`), and it is determined by
**sniffing the first 16 bytes**, falling back to the extension. The extension
alone would suffice for the file the queue produces; the sniff is there because
OpenRouter's troubleshooting guide lists a bytes/`format` mismatch as the first
cause of a silently empty transcript — the upstream provider trusts the declared
format over the bytes.

`temperature` is deliberately not sent: several models in this catalogue
(Deepgram Nova-3 and Fish Audio among them) advertise an empty
`supported_parameters`, and an unsupported parameter there is a 400, not a
warning. `CloudOptions.translate` is unhonourable — this route has no `task`
parameter, so translation is impossible here rather than merely unrequested, and
`listModels` reports `translate: false` to match. `CloudOptions.diarize` has no
request switch either; whatever `speaker` labels turn up are passed through and
none are invented.

**Response shape.** With `verbose_json`: `{ text, segments: [{ start, end, text,
speaker? }], words: [{ word, start, end, speaker? }], language }`, times in
fractional seconds, `language` an English **name** mapped back through Whisper's
own list (anything unrecognised falls through lowercased rather than being
discarded). Segments and words are **two independent flat arrays** — nothing in
the response says which word belongs to which segment — so words are matched to
segments by **midpoint** via a binary search over segment starts, so a word
straddling a boundary lands with the segment it mostly occupies.

> ### The trap: this route yields timestamps only *sometimes*
>
> This is the honest answer, and it is the most important line in this section.
>
> `verbose_json` — the only way to get any timing at all out of this route — is
> documented as supported by exactly **three** upstream providers: OpenAI, Groq
> and Together. Every other upstream rejects it with a **400**. And which upstream
> a model routes to **is decided per request and cannot be pinned from here**: the
> STT endpoint's `provider` object accepts only `options` passthrough, with none
> of the `only` / `order` routing controls that chat completions has. The same
> `openai/whisper-large-v3-turbo` request can land on Groq and come back
> timestamped, or on DeepInfra and not.
>
> So the shape of the request has to be **discovered by trying it**. The adapter
> sends `verbose_json` first — always, even when the user has word timestamps
> switched off, because the alternative is a response with no timing information
> whatsoever, and the toggle should control word *granularity*, not whether
> subtitles are possible. On a 400 it retries once with the plain body. That retry
> costs one round trip and no money: a 400 means nothing was transcribed and
> nothing was billed.
>
> **What the fallback costs must be stated plainly.** When it fires, all that
> comes back is one string of text. There is no timing information of any kind.
> The transcript becomes a single segment spanning the whole file, and every
> subtitle cue for it is produced by `resegment()` interpolating boundaries across
> the duration from reading speed and line length alone. The words are in the
> right order and the cues are evenly paced, and **no cue boundary corresponds to
> anything that was actually heard.** For subtitling, use a model from
> `PREFERRED_MODEL_ORDER` — the Whisper family and the `gpt-*-transcribe` models,
> which are the ones OpenAI, Groq and Together serve.
>
> This is also why `capabilities.wordTimestamps` is set to `true` only for
> `openai/`-prefixed ids, and **omitted entirely** for everything else rather than
> set to `false`. It is a claim that the model *may* be routed somewhere that
> accepts `verbose_json`; it cannot be a promise. Models whose providers are
> unknown get no claim at all rather than one this adapter cannot stand behind.
> Deepgram Nova-3, Chirp 3, Voxtral, the Qwen and Parakeet ASR models in the
> catalogue are real, often better and often cheaper — they just come back
> without timestamps, and the fallback is what makes them usable at all.
>
> One more, unrelated: a **504 or 524 is OpenRouter's documented upstream cap** —
> providers abandon a transcription after 60 seconds of *processing*. Nothing on
> this side can raise it; the answer is a shorter file or a faster model.

---

## What this leaves the UI

`ProviderModel.capabilities` is the whole contract between these four adapters
and the settings panel, and each adapter fills it in honestly rather than
optimistically:

| Provider | `diarization` | `wordTimestamps` | `translate` |
| --- | --- | --- | --- |
| DeepInfra | `false` — no diarization on any model | `true` | `false` — no `task` on this route |
| Deepgram | `true`, except Whisper Cloud which has no diarizer | `true`, always, never charged extra | *omitted* — no translation mode exists at all |
| ElevenLabs | `true` | `true` | `false` — Scribe transcribes only |
| OpenRouter | *omitted* — no request switch, labels passed through if they appear | `true` for `openai/*` only; *omitted* elsewhere | `false` — no `task` parameter |

An omitted capability means "this adapter will not make a claim". A `false`
means "asking is guaranteed not to work, grey the control." The distinction is
deliberate, and a UI that treats them the same will either promise something the
provider cannot do or hide something it can.
