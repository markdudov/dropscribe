# Engine verification — what was actually measured

This file is the difference between what this project *knows* and what it
*assumes*. Everything below was run on a real machine and the output recorded;
nothing below is a recollection of how whisper.cpp usually behaves.

It exists because the engine layer is full of things that look wrong. A CLI with
no JSON flag. A model catalogue that pins `.bin` files in a repository whose name
ends in `-GGUF`. A GitHub Actions workflow that builds binaries a project could
apparently just download. Each of those looks like an oversight, each is load
bearing, and each has already cost an afternoon once.

**So: before you delete, "modernize" or simplify anything in `electron/engines/`,
`electron/shared/models.ts` or `.github/workflows/engines.yml`, find it here
first.** If a claim below contradicts what you remember about whisper.cpp, the
measurement wins. If a claim below is contradicted by a *new* measurement, replace
it and say so — this file is a log, not a monument.

## The bench

| | |
| --- | --- |
| Date | 2026-08-29 |
| Machine | Apple M2 Pro, 16 GB unified memory |
| OS | macOS 26.6.2, arm64 |
| Source | `ggml-org/whisper.cpp` at tag **`b4938`** (the old `ggerganov/whisper.cpp` GitHub URL still redirects there; the *Hugging Face* weights repo is still literally `ggerganov/whisper.cpp` — the two names are not interchangeable and both appear in `electron/shared/models.ts`) |
| ggml | version 0.20.2, commit `371b5a7` |
| Test audio | 8.78 s (140 442 frames), 16 kHz mono s16 WAV, synthesized with macOS `say` |

Build:

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DBUILD_SHARED_LIBS=OFF
cmake --build build -j --config Release
```

Two of those flags are not decoration:

- **`-DGGML_METAL_EMBED_LIBRARY=ON`** compiles the Metal shader source *into* the
  executable. Without it the binary looks for `ggml-metal.metal` beside itself at
  run time — a loose data file that would have to be found relative to
  `binDir()`, copied by electron-builder, and included in the notarized bundle,
  and whose absence shows up not as a startup error but as a silent fall back to
  CPU on a user's machine. The run log confirms the flag took:
  `ggml_metal_library_init: using embedded metal library`.
- **`-DBUILD_SHARED_LIBS=OFF`** makes each tool self-contained. `otool -L
  build/bin/whisper-cli` lists **only** OS frameworks — Accelerate, Metal,
  MetalKit, Foundation, CoreFoundation, `libSystem`, `libc++`, `libobjc`. Nothing
  from the build tree. That is why the macOS side of `vendor/bin/` is four files
  with no `@rpath` fix-ups and no dylibs to sign individually. Compare item 3
  below, where upstream's *shared* Windows build costs twelve extra files.

---

## 1. whisper.cpp ships a Parakeet implementation

The build produced, in `build/bin/`:

```
bench   main   parakeet-cli   parakeet-quantize   whisper-bench
whisper-cli   whisper-quantize   whisper-server   whisper-vad-speech-segments
```

`parakeet-cli` and `parakeet-quantize` are built from the same tree, against the
same ggml, with the same Metal backend, as `whisper-cli`.

**This single fact is the foundation the whole engine design stands on.** Because
it is true, DropScribe has:

- one runtime to build, one to notarize, one to sign on Windows;
- one model format (GGML `.bin`) for both engines, so `model-store.ts` has one
  download path and one integrity check;
- one place where Metal/CPU acceleration is configured;
- **no ONNX Runtime anywhere in the app** — see item 8.

If a future session concludes "Parakeet obviously needs its own runtime," it has
regressed to the pre-measurement state of the world. It does not. It is in the box.

---

## 2. Upstream publishes no macOS binaries

Release `b4938` carries exactly these assets:

`whisper-bin-x64.zip`, `whisper-blas-bin-x64.zip`, the `whisper-cublas-*-bin-x64.zip`
family, `whisper-bin-Win32.zip`, the Ubuntu tarballs, and an xcframework.

That is the whole list. There is no `whisper-bin-macos-arm64.tar.gz`, and the
xcframework is a static library for embedding in an Xcode target — not a CLI, not
something `spawn()` can run.

**Cost of getting this wrong:** `.github/workflows/engines.yml` exists solely
because of this line. Someone who assumes upstream ships mac binaries will look at
that workflow, see it compiling whisper.cpp from source on a macOS runner, decide
it is redundant next to a two-line `curl`, and delete it. The macOS build then has
no engines at all, and the failure surfaces at `enginesReady()` on a user's
machine rather than in CI. Verify the asset list *before* touching that workflow:

```bash
gh release view b4938 --repo ggml-org/whisper.cpp --json assets \
  --jq '.assets[].name'
```

---

## 3. The Windows zip is usable — and is twelve DLLs wide

`whisper-bin-x64.zip` (8 361 840 bytes, ~8 MB) does contain both CLIs:
`Release/whisper-cli.exe` and `Release/parakeet-cli.exe`. So the Windows half of
the pipeline genuinely can be downloaded rather than built.

But upstream built it with shared libraries, so the executables are inert on their
own. Beside them in `Release/` sit:

| File | Why it must travel with the .exe |
| --- | --- |
| `whisper.dll`, `parakeet.dll` | the engines themselves |
| `ggml.dll`, `ggml-base.dll` | the tensor library and its base ops |
| `ggml-cpu-alderlake.dll`, `-cannonlake`, `-cascadelake`, `-haswell`, `-icelake`, `-sandybridge`, `-skylakex`, `-sse42`, `-x64` | nine microarchitecture variants; ggml picks one at run time by CPUID |
| `llama.dll` | linked in by the shared build whether or not this app uses it |

**Neither .exe starts without those DLLs in the same directory.** Windows resolves
them from the executable's own folder, and the failure mode is a loader dialog
before a single line of our code runs — no stderr to parse, no exit code worth
reading, nothing `engineReport()` can explain to a user.

Two consequences that look like sloppiness and are not:

- The nine `ggml-cpu-*` DLLs are **not** dead weight to be pruned to "the one for
  modern CPUs." They are the dispatch set. Ship only `ggml-cpu-x64.dll` and the
  app runs, slowly, on hardware that could have used AVX-512; ship only
  `ggml-cpu-skylakex.dll` and it crashes on an older CPU.
- `binaryPath()` in `electron/binaries-runtime.ts` returns paths inside one flat
  `bin/` directory per platform for precisely this reason. The DLLs are siblings
  of the .exe, not a separate `lib/`.

---

## 4. `whisper-cli` JSON: the exact shape, measured

Command run:

```bash
whisper-cli -m ggml-tiny.bin -f speech.wav -l auto -oj -ojf -of out -pp
```

Result: auto-detected `en` with **p = 0.999136**, total runtime **641 ms** for
8.78 s of audio, and a file `out.json` with top-level keys:

```
systeminfo   model   params   result   transcription
```

`result` is exactly `{"language":"en"}` — the detected language and nothing else.
`systeminfo` is the backend banner string
(`WHISPER : COREML = 0 | OPENVINO = 0 | MTL : EMBED_LIBRARY = 1 | CPU : NEON = 1 | …`),
which is worth logging on a support ticket and worth nothing to the parser.

Each entry of `transcription[]`, verbatim from the measured file:

```json
{
  "timestamps": { "from": "00:00:00,000", "to": "00:00:05,040" },
  "offsets":    { "from": 0, "to": 5040 },
  "text": " the quick brown fox jumps over the lazy dog, this is a test of …",
  "tokens": [
    { "text": "[_BEG_]", "timestamps": {…}, "offsets": { "from": 0,   "to": 0   }, "id": 50364, "p": 0.989719, "t_dtw": -1 },
    { "text": " the",     "timestamps": {…}, "offsets": { "from": 10,  "to": 220 }, "id": 264,   "p": 0.415889, "t_dtw": -1 },
    { "text": " quick",   "timestamps": {…}, "offsets": { "from": 220, "to": 580 }, "id": 1702,  "p": 0.717194, "t_dtw": -1 }
  ]
}
```

Five things follow, and each of them is a rule the adapter obeys:

- **`offsets.from` / `offsets.to` are already integer milliseconds.** They are not
  centiseconds, not `t0`/`t1`, not seconds. Whisper's *C API* speaks centiseconds
  and half the reference material on the internet describes that API; the CLI's
  JSON writer has already multiplied by 10. Parse `offsets`, never `timestamps`.
  Getting this wrong scales every subtitle by 10× or 0.1× — an error so large it
  is caught immediately, which is the only good news about it.
- **`timestamps` are `"HH:MM:SS,mmm"` strings and exist for humans.** Re-parsing
  them would mean string-splitting a value that is already available as an
  integer, and would silently lose anything past 99 hours.
- **The first token of a segment is `[_BEG_]`**, with a zero-width span. Special
  tokens follow the `[_XXX_]` bracket form (`[_TT_123]` is the other common one)
  and must be dropped before words are assembled, or every segment gains a
  literal `[_BEG_]` at its head.
- **A token's `text` carries its own leading space**, and that space is the word
  boundary — the measured segment tokenizes `timestamps` as `" timest"` + `"amps"`.
  Splitting on whitespace *after* concatenation loses the alignment between a word
  and its offsets; joining tokens and re-splitting produces the right string with
  the wrong timings. Accumulate: a token that starts with a space begins a new word.
- **`p` is a probability in 0..1**, per token, and is what `Word.confidence`
  is derived from. It is not a log-probability, so do not exponentiate it.

Segments abut exactly — the measured pair are `[0, 5040]` and `[5040, 8760]` — so
there is no gap to interpolate and no overlap to resolve.

### Progress is on stderr, and is not a percentage of the file

`-pp` prints:

```
whisper_print_progress_callback: progress = 100%
```

to **stderr**, not stdout, and the number is padded (`progress =  42%`). stdout
carries the transcript. A reader that watches the wrong stream sees a job sit at
0% for its entire duration and then finish — which reads as a hung app on a
40-minute file, and is the single most likely reason someone would "fix" the
progress code by ripping it out.

---

## 5. `parakeet-cli` has ten options and none of them is `--json`

Measured `--help`, complete:

```
  -h,     --help              show this help message and exit
  -t N,   --threads N         [4] number of threads to use during computation
  -m,     --model FILE        [models/ggml-parakeet-tdt-0.6b-v3.bin] model path
  -f,     --file FILE         [ ] input audio file
  -ng,    --no-gpu            [false] disable GPU
  -dev N, --device N          [0] GPU device to use
  -ps,    --print-segments    [false] print segment information
  -otxt,  --output-txt        [false] output result in a text file
  -of,    --output-file FILE  [ ] output file path (without file extension)
  -np,    --no-prints         [false] do not print anything other than the results
```

It also reports `supported audio formats: flac, mp3, ogg, wav`.

**There is no `-oj`, no `-l/--language`, no `--translate` and no `-pp`.** That is
not a gap in the measurement; that is the whole option set.

What each absence forces:

| Missing | Consequence in `electron/engines/parakeet-cpp.ts` |
| --- | --- |
| JSON output | segments are parsed from `-ps` stdout in whisper.cpp's bracket form `[00:00:00.000 --> 00:00:05.040]  text`, with the plain transcript as a single whole-file segment fallback |
| language flag | `LocalRunRequest.language` is *ignored* for this engine — v3 is multilingual and detects on its own. The UI must not offer a language picker that does nothing |
| translate flag | `LocalRunRequest.translate` is likewise unusable here. A UI that offers translation for Parakeet is offering a lie |
| progress flag | there is no per-file progress to report; the job goes from "running" to "done" |

Note the default model path: `models/ggml-parakeet-tdt-0.6b-v3.bin`, resolved
**relative to the process's working directory**. `-m` is therefore mandatory in
this app, not optional-with-a-sensible-default — the packaged binary's cwd is
whatever Electron happened to inherit.

---

## 6. The false start: a GGUF is not a GGML `.bin`

The community file `handy-computer/parakeet-tdt-0.6b-v3-gguf` (739 508 576 bytes,
SHA-256 `5859f779…`) downloaded cleanly and hashed correctly. It is a valid file.
`parakeet-cli` still refuses it:

```
parakeet_model_load: invalid model data (bad magic)
parakeet_init_with_params_no_state: failed to load model
error: failed to load Parakeet model from 'parakeet-q8.gguf'
```

The first four bytes say why:

```
$ head -c 4 parakeet-q8.gguf     | xxd   # 4747 5546   "GGUF"
$ head -c 4 ggml-parakeet-q8.bin | xxd   # 6c6d 6767   "ggml", little-endian
```

Two different container formats for the same weights, aimed at two different
runtimes. whisper.cpp's `parakeet-cli` reads the GGML one, produced by
`models/convert-parakeet-to-ggml.py` in the whisper.cpp tree and published at
**`ggml-org/parakeet-GGUF`** as
`ggml-parakeet-tdt-0.6b-v3-{f32,f16,q8_0,q4_k,q4_0}.bin`.

Yes: a repository named `-GGUF` whose usable files end in `.bin`. That naming is
the trap, and it is upstream's, not ours.

**Do not repoint the catalogue at a GGUF because the extension looks more modern.**
Note also that the sizes are close enough to pass a glance — the wrong F16 GGUF is
1 255 869 856 bytes against the right F16 `.bin`'s 1 255 897 319, a 0.002 %
difference. Eyeballing the size is not a check. The magic number is.

---

## 7. Model sizes and hashes come from Hugging Face, not from the download

Every `bytes` and `sha256` in `electron/shared/models.ts` was read from Hugging
Face's LFS metadata:

```bash
curl -s -X POST https://huggingface.co/api/models/<repo>/paths-info/main \
  -H 'Content-Type: application/json' \
  -d '{"paths":["ggml-large-v3-turbo.bin"]}'
```

which answers with `{"size":…, "lfs":{"oid":"<sha256>", …}}`.

**They were not computed by hashing a file we had already downloaded.** A hash
taken from bytes you already trusted proves only that your disk works. Taken from
the publisher's own metadata, it detects a silently re-uploaded model — which is
the case the check exists for. `scripts/verify-model-catalogue.mjs` re-reads the
same endpoint in CI so the drift is caught there rather than by a user with a
half-working model.

Re-verified against the API on 2026-08-29, all four Whisper entries exact:

| File | Bytes | SHA-256 (first 8) |
| --- | ---: | --- |
| `ggml-large-v3-turbo.bin` | 1 624 555 275 | `1fc70f77` |
| `ggml-large-v3-turbo-q5_0.bin` | 574 041 195 | `39422170` |
| `ggml-large-v3.bin` | 3 095 033 483 | `64d182b4` |
| `ggml-large-v3-q5_0.bin` | 1 081 140 203 | `d75795ec` |

### One pair of numbers does not reconcile

The two Parakeet entries in `models.ts` carry **correct hashes and wrong byte
counts**. Measured three ways on 2026-08-29 — the API, the LFS pointer inside it,
and `shasum -a 256` over the actually-downloaded 668 757 119-byte file, which
hashes to exactly the `4d64e9e9…` the catalogue pins:

| Entry | `models.ts` says | Upstream says | Hash |
| --- | ---: | ---: | --- |
| `ggml-parakeet-tdt-0.6b-v3-q8_0.bin` | 669 142 048 | **668 757 119** | `4d64e9e9…` ✓ correct |
| `ggml-parakeet-tdt-0.6b-v3-f16.bin` | 1 256 128 672 | **1 255 897 319** | `833bffc9…` ✓ correct |

This matters because `LocalModel.bytes` is documented as "a first integrity
check": a downloader that compares the finished size against the catalogue will
reject both Parakeet models *even when the download is byte-perfect*, and the user
sees an integrity failure on a file that is in fact correct. The hashes are the
authority; these two size fields are the thing to fix. Do not "fix" it in the
other direction by re-deriving the hashes from a local file — see the paragraph
above for why that check would then be worthless.

---

## 8. sherpa-onnx was evaluated, worked, and was still rejected

This is recorded because the rejection was *not* on capability grounds, and a
future session that discovers sherpa-onnx and thinks "this would solve Parakeet"
is rediscovering an option that was already on the table.

sherpa-onnx **v1.13.6** was downloaded and unpacked. It genuinely delivers:

- prebuilt CLI bundles for `osx-arm64`, `osx-x64` and `win-x64` — no compiling,
  which is more than upstream whisper.cpp offers for macOS (item 2);
- an official model, `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
  unpacking to `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`,
  `tokens.txt`;
- a large fleet of tools (`sherpa-onnx-offline`, diarization, VAD, punctuation).

It would have worked. It was dropped anyway, for costs that are structural rather
than technical:

| What adopting it would add | Measured evidence |
| --- | --- |
| A second runtime to package and sign | `lib/` in the osx-arm64 bundle ships `libonnxruntime.dylib`, `libsherpa-onnx-c-api.dylib`, `libsherpa-onnx-cxx-api.dylib` — per platform. Against a whisper.cpp build whose `otool -L` shows nothing but OS frameworks |
| A second model format | a four-file encoder/decoder/joiner/tokens quartet, versus one `.bin`. `model-store.ts` would need multi-file downloads, multi-file integrity checks and multi-file deletion |
| A second acceleration story | ONNX Runtime's execution providers, configured and debugged separately from ggml's Metal backend |
| A second upstream to track | two release cadences, two CVE surfaces, two licence notices in `licenseNoticePath()` |

One engine family is why this app has no ONNX Runtime in it at all. That sentence
is also in the header comment of `electron/shared/models.ts`; this file is where
the arithmetic behind it lives.

---

## How to re-measure

Everything above, from a clean checkout, in order. Nothing here writes into the
repo — work in a scratch directory.

**Build both engines from source (macOS):**

```bash
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp && git checkout b4938
cmake -B build -DCMAKE_BUILD_TYPE=Release \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DBUILD_SHARED_LIBS=OFF
cmake --build build -j --config Release
ls build/bin                      # expect whisper-cli AND parakeet-cli   (item 1)
otool -L build/bin/whisper-cli    # expect OS frameworks only             (bench)
```

**Confirm upstream still ships no macOS binaries (item 2):**

```bash
gh release view b4938 --repo ggml-org/whisper.cpp --json assets --jq '.assets[].name'
```

**Confirm the Windows zip's contents (item 3):**

```bash
curl -sLO https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-bin-x64.zip
unzip -l whisper-bin-x64.zip | grep -E 'cli\.exe|\.dll'
```

**Make the test audio and run whisper-cli (item 4):**

```bash
say -o speech.aiff "The quick brown fox jumps over the lazy dog. \
This is a test of the drop scribe transcription pipeline. \
It should produce accurate timestamps for every word."
ffmpeg -y -i speech.aiff -ar 16000 -ac 1 -c:a pcm_s16le speech.wav

curl -sLO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin
./build/bin/whisper-cli -m ggml-tiny.bin -f speech.wav -l auto -oj -ojf -of out -pp
                                  # progress lines appear on stderr
python3 -c "import json;d=json.load(open('out.json'));print(list(d));print(d['result']);print(d['transcription'][0]['offsets'])"
```

**Read parakeet-cli's real option set (item 5):**

```bash
./build/bin/parakeet-cli --help
```

**Check a model file's format before blaming the engine (item 6):**

```bash
head -c 4 some-model.bin | xxd   # "ggml" = whisper.cpp;  "GGUF" = wrong runtime
```

**Re-verify the catalogue against Hugging Face (item 7):**

```bash
curl -s -X POST https://huggingface.co/api/models/ggml-org/parakeet-GGUF/paths-info/main \
  -H 'Content-Type: application/json' \
  -d '{"paths":["ggml-parakeet-tdt-0.6b-v3-q8_0.bin","ggml-parakeet-tdt-0.6b-v3-f16.bin"]}' \
  | python3 -m json.tool
# or, for all entries at once:
node scripts/verify-model-catalogue.mjs
```

---

## The short version, for someone in a hurry

| Tempting change | What it actually breaks |
| --- | --- |
| Delete `.github/workflows/engines.yml`, "just download the release" | there are no macOS binaries in that release. Item 2 |
| Prune the nine `ggml-cpu-*.dll` variants | that is ggml's run-time dispatch set, not duplication. Item 3 |
| Read `timestamps` instead of `offsets`, or multiply `offsets` by 10 | `offsets` is already integer milliseconds. The C API's centiseconds are a different interface. Item 4 |
| Join whisper tokens, then split on whitespace | loses per-word offsets; `" timest"` + `"amps"` is one word in two tokens. Item 4 |
| Watch stdout for progress | progress is on stderr. Item 4 |
| Add a language or translate control for Parakeet | `parakeet-cli` has no such flag. Item 5 |
| Point the Parakeet entries at the `.gguf` files | wrong magic; `parakeet-cli` rejects them outright. Item 6 |
| Recompute the catalogue hashes from downloaded files | a hash of bytes you already trusted proves nothing. Item 7 |
| Adopt sherpa-onnx for Parakeet | already evaluated; it works, and it costs a second runtime, format, accelerator and upstream. Item 8 |

## Which Windows DLLs actually have to ship (measured 2026-08-29)

Guessing this wrong produces an app that works on every developer's machine and
fails to start the engine on a user's. So the PE import tables of the two
executables in `whisper-bin-x64.zip` were read directly:

| binary | direct imports found in the zip |
| --- | --- |
| `whisper-cli.exe`  | `whisper.dll`, `ggml.dll` |
| `parakeet-cli.exe` | `parakeet.dll`, `ggml.dll` |

Following those transitively closes at four files: `whisper.dll`, `parakeet.dll`,
`ggml.dll` and `ggml-base.dll`. Everything else each binary names —
`KERNEL32.dll`, `MSVCP140.dll`, `VCRUNTIME140*.dll` and the
`api-ms-win-crt-*` set — is the system C runtime.

**The nine `ggml-cpu-*.dll` files appear in no import table and must ship
anyway.** `ggml-base.dll` loads them at runtime through its backend registry,
picking the one matching the host microarchitecture (sse42, x64, sandybridge,
haswell, skylakex, icelake, cascadelake, cannonlake, alderlake). A dependency
walker will not find them; a user on an unlucky CPU will.

`llama.dll` and `SDL2.dll` are in the same zip and are deliberately **not**
vendored: they belong to `whisper-talk-llama` and the streaming examples, and
neither `whisper-cli` nor `parakeet-cli` imports them.

Re-measure with the import-table reader if the upstream tag changes:
unzip the release, then read each `.exe`'s import directory and follow it
transitively over the files present in the archive.

## Whisper's progress granularity is the file's, not ours (measured 2026-08-29)

A short job appears to hang at the start of the transcription band and then jump
straight to done. It is not a bug in the adapter, and the next person to "fix" it
will be removing working code.

`whisper-cli -pp` emits one `whisper_print_progress_callback: progress = N%` line
per decode window, and a window is 30 seconds of audio. Measured against the same
build and model:

| audio | progress lines emitted |
| --- | --- |
| 5.4 s   | **1** (`100%`) |
| 171.2 s | 11 |

So a five-second clip genuinely has one progress event in it, and the run
observed through the app went 15 % → 100 %. The same code on the 171 s file
reported 15 → 29 → 43 → 58 → 61 → 64 → 67 → 73 → 87 → 100, which is the 15–100
band the queue maps whisper's 0–100 into.

The steps are also uneven — 58, 61, 64, 67 — because whisper re-runs a window at a
higher temperature when the decoder fails a threshold. A UI must therefore never
infer a rate or an ETA from the delta between two progress events.
