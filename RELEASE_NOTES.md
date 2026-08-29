# DropScribe 0.1.0

Drop an audio or video file on the window and get a transcript back. DropScribe
runs Whisper large-v3, Whisper large-v3-turbo and NVIDIA's Parakeet TDT 0.6B v3
locally — entirely offline, GPU-accelerated on Apple silicon — or sends the file
to DeepInfra, Deepgram, ElevenLabs or OpenRouter using your own API key, which
is kept in the operating system's credential store rather than in a settings
file. Transcripts export as TXT, Markdown, SRT, WebVTT, JSON or CSV; the
subtitle formats are rebuilt to real subtitling limits instead of dumping the
recognizer's raw segments on screen. Files queue up, report their progress
individually, and can be cancelled at any point.

macOS and Windows. MIT licensed.

## The app is not signed yet

There is no Apple Developer certificate and no Windows code-signing certificate
behind this build, so both operating systems will treat it as an unknown app the
first time you open it.

On macOS, double-clicking will be refused. Right-click the app in Finder and
choose **Open**, then confirm — you only have to do this once. If your version
of macOS refuses even that, open **System Settings → Privacy & Security**,
scroll to the message about DropScribe being blocked, and choose **Open Anyway**.

On Windows, SmartScreen will show a blue "Windows protected your PC" box. Click
**More info**, then **Run anyway**.

Both warnings are about the missing signature, not about anything the app was
caught doing — but that is exactly what a bad actor would also write here. The
source is public, so if you would rather not trust a binary from a stranger, you
can build it yourself.

## The first transcription downloads a model

Only the engines ship inside the app. Model weights are downloaded from Hugging
Face the first time you use a given model, so the first run of each one costs a
download — after that it is on disk and everything happens offline. Downloads
report progress and can be cancelled.

| Model | Download |
| --- | --- |
| Whisper large-v3-turbo | 1.5 GB |
| Whisper large-v3-turbo, 5-bit quantized | 547 MB |
| Whisper large-v3 | 2.9 GB |
| Whisper large-v3, 5-bit quantized | 1.0 GB |
| Parakeet TDT 0.6B v3 | 638 MB |
| Parakeet TDT 0.6B v3, F16 | 1.2 GB |

If you are choosing blind: start with **Whisper large-v3-turbo**. It is close to
large-v3 in accuracy at a fraction of the running time. The quantized builds
trade a little accuracy for roughly a third of the disk and memory, and are the
right pick on a machine with 8 GB of RAM. Parakeet is faster still, but only
knows 25 European languages, where Whisper will attempt any of 99.

The cloud providers need no download at all — just a key.

## What 0.1.0 is

A first public release. It is unsigned, it does not update itself, and it has
not yet been run on every combination of hardware and file that exists. There
will be rough edges, and finding them is the point of putting it out.

To get a new version, come back to the Releases page and download it; nothing in
the app will tell you one exists.

Problems, crashes, a file that transcribes badly, a format that exports wrong:
please open an issue at
<https://github.com/markdudov/dropscribe/issues>. The file's format and
roughly how long it is, the model or provider you ran it through, and your OS
version are usually enough to reproduce it — no need to attach the media itself.
