# 0011 — Three small ones: a mojibake CSV, a console window, a button that did nothing

Three defects too small to deserve an entry each, and too real to leave
unrecorded. None was hard to find once someone looked; all three had been
shipped.

## CSV opened as mojibake in Excel

`toCsv`'s own comment commits the format to Excel:

> Rows are joined with CRLF, which RFC 4180 mandates and — the reason that
> actually matters — which Excel requires. Handed bare LF, Excel drops the
> entire file into row 1.

Excel is equally literal about the encoding. Given a UTF-8 CSV with no
byte-order mark it decodes the bytes as the system's legacy code page, so
`Здравей` opens as `Ð—Ð´Ñ€Ð°Ð²ÐµÐ¹`. For a transcript in anything but English
that is most of the file, and this app's author transcribes Bulgarian.

Three bytes. Every CSV parser worth using skips them, and they are the only
thing that makes the file open correctly in the program the format was already
shaped around. The existing test that pinned the exact output was updated in the
same change; it had encoded the defect.

## A console window over the app on Windows

`parakeet-cli` was spawned without `windowsHide: true`. Windows gives a GUI
process's console child its own window, so every Parakeet job opened a black
console over the app for as long as it ran.

`whisper-cpp.ts:146` and `ffmpeg.ts:159` both set it. This one spawn was missed.
Not reproducible on the machine this was found on — there is no Windows here —
and not in doubt either: the flag is present in the two sibling spawns for
exactly this reason, and absent in the third.

## Refresh models did nothing for six hours

`loadModels` in the ElevenLabs adapter caches a successful model list for six
hours. `providers:refreshModels` — the handler behind the **Refresh models**
button — went through `listModels`, hit that cache, and returned the list it
already had. A model ElevenLabs added this morning stayed invisible until the
afternoon, with no way to ask again.

`ProviderAdapter.listModels` now takes an optional `{ force }`, and the refresh
handler passes it. Adapters that keep no cache ignore it, which is three of the
four. The cache itself is worth keeping: `listModels` is also called on every
settings-panel open, and that should not be a network round trip.

## Test

`test/exports.test.ts` — `CSV for the program the format was shaped around`:
the mark is present, the header still follows it, rows are still CRLF, and no
other format grows one.

The other two are verified by reading: a spawn flag that matches its two
siblings, and a cache lookup that a boolean now skips.
