/// <reference types="vitest/globals" />
/**
 * `electron/ffmpeg.ts` — which encoder an upload copy gets made with.
 *
 * WHY THIS FILE IS UNDER `test/node/` AND NOT BESIDE THE OTHERS. `ffmpeg.ts`
 * imports `node:child_process` and `electron`, so it is not one of the modules
 * `tsconfig.web.json` lists as safe for the renderer. That config excludes
 * `test/node/**` and `tsconfig.node.json` includes it, which is the whole
 * reason for the directory; `vite.config.ts` globs `test/**` regardless, so it
 * still runs with everything else. The module is import-safe outside Electron
 * on purpose — see the note on `ensureQuitHook` — so nothing has to be mocked.
 *
 * WHAT IS BEING GUARDED. `compressForUpload` used to name `libopus` outright
 * and retry with `libmp3lame`. The vendored macOS ffmpeg is the author's own
 * build, configured `--enable-libx264 --enable-libx265 --enable-libzimg` and
 * nothing else, so it has neither and every cloud job died on arrival with
 * “Encoder not found”. These tests pin the two halves of the fix: read the
 * build's real capability list, and rank the candidates so that the answer on
 * that build is one it can actually produce.
 *
 * The macOS fixtures below are VERBATIM from
 * `vendor/bin/darwin-arm64/ffmpeg -hide_banner -encoders`, ffmpeg n7.1.5,
 * measured 2026-08-29. The Windows rows are reconstructed — a win32 .exe cannot
 * be run on the CI host — but the encoder long names in them were read out of
 * the shipped `vendor/bin/win32-x64/ffmpeg.exe`, whose configure line does
 * carry `--enable-libopus --enable-libmp3lame --enable-libvorbis`.
 */

import { UPLOAD_ENCODINGS, chooseUploadEncoding, parseEncoders, fitBitrate } from '../../electron/ffmpeg';
import type { UploadEncoding } from '../../electron/ffmpeg';

/** `chooseUploadEncoding` returns `null` for an unusable build; fail loudly instead. */
function chosen(available: ReadonlySet<string>): UploadEncoding {
  const encoding = chooseUploadEncoding(available);
  if (encoding === null) throw new Error('expected an encoding to be chosen');
  return encoding;
}

/**
 * VERBATIM — the legend ffmpeg prints above the table, and the rule under it.
 *
 * Every one of these lines has the shape of a real row: a flag field, then a
 * word. `A..... = Audio` in particular is an audio-flagged line whose second
 * field is `=`, and a parser that split on whitespace and took field 1 without
 * looking at it would report an encoder called `=` on every build there is.
 */
const LEGEND = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------`;

/**
 * VERBATIM — the whole shape of the measured macOS listing, in miniature.
 *
 * The video and subtitle rows are kept because they are what the parser has to
 * throw away: `a64multi` is the first row of the real table and `ass` is in the
 * middle of it, and neither is something we could ever upload. `aac_at` is here
 * because macOS has an AudioToolbox alias for half the codecs, and it must not
 * be mistaken for the native `aac` the table actually asks for.
 */
const MACOS_LISTING = `${LEGEND}
 V....D a64multi             Multicolor charset for Commodore 64 (codec a64_multi)
 A....D aac                  AAC (Advanced Audio Coding)
 A..... aac_at               aac (AudioToolbox) (codec aac)
 A....D alac                 ALAC (Apple Lossless Audio Codec)
 A....D flac                 FLAC (Free Lossless Audio Codec)
 A..X.D opus                 Opus
 A....D pcm_s16le            PCM signed 16-bit little-endian
 A..X.D vorbis               Vorbis
 A....D wavpack              WavPack
 S..... ass                  ASS (Advanced SubStation Alpha) subtitle`;

/**
 * The audio half of the measured macOS build, as a set.
 *
 * This is the exact case the bug was: seven natives, no `lib*` anything. Note
 * that `opus` and `vorbis` ARE in here — the build has both, they are simply
 * the native encoders rather than libopus and libvorbis, and the native ones
 * are not interchangeable with them.
 */
const MACOS_NATIVES: ReadonlySet<string> = new Set([
  'aac',
  'flac',
  'alac',
  'opus',
  'wavpack',
  'vorbis',
  'pcm_s16le',
]);

/** Reconstructed — the rows a BtbN Windows build adds on top of the natives. */
const WINDOWS_LIB_ROWS = ` A....D libmp3lame           libmp3lame MP3 (MPEG audio layer 3) (codec mp3)
 A....D libopus              libopus Opus (codec opus)
 A....D libvorbis            libvorbis (codec vorbis)`;

/** A build with video and subtitles and no audio encoder at all. */
const VIDEO_ONLY_LISTING = `${LEGEND}
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 S..... ass                  ASS (Advanced SubStation Alpha) subtitle`;

describe('parseEncoders', () => {
  it('returns the audio rows', () => {
    const found = parseEncoders(MACOS_LISTING);
    expect([...found].sort()).toEqual([
      'aac',
      'aac_at',
      'alac',
      'flac',
      'opus',
      'pcm_s16le',
      'vorbis',
      'wavpack',
    ]);
  });

  it('leaves the video and subtitle rows out', () => {
    // Not a filter applied afterwards — the media letter is the first thing
    // read, so `a64multi` and `ass` never become candidates in the first place.
    const found = parseEncoders(MACOS_LISTING);
    expect(found.has('a64multi')).toBe(false);
    expect(found.has('ass')).toBe(false);
  });

  it('reads nothing at all out of the legend', () => {
    // The strongest form of the assertion: nine lines of header, zero encoders.
    expect(parseEncoders(LEGEND).size).toBe(0);
  });

  it('does not turn the legend rows into encoders named after the legend', () => {
    const found = parseEncoders(MACOS_LISTING);
    for (const impostor of ['=', 'Audio', 'Video', 'Subtitle', '------', 'Encoders:']) {
      expect(found.has(impostor)).toBe(false);
    }
  });

  it('reads the lib-prefixed rows a Windows build carries', () => {
    const found = parseEncoders(`${MACOS_LISTING}\n${WINDOWS_LIB_ROWS}`);
    expect(found.has('libopus')).toBe(true);
    expect(found.has('libvorbis')).toBe(true);
    expect(found.has('libmp3lame')).toBe(true);
  });

  it('finds no audio encoders in a video-only build', () => {
    expect(parseEncoders(VIDEO_ONLY_LISTING).size).toBe(0);
  });

  it('survives an empty listing', () => {
    // `availableEncoders()` falls back to an assumed set when ffmpeg exits
    // non-zero, but a zero-exit run that printed nothing has to be survivable
    // too, and the honest answer to that is "no encoders", not a throw.
    expect(parseEncoders('').size).toBe(0);
  });
});

describe('UPLOAD_ENCODINGS', () => {
  it('is ranked opus, vorbis, mp3, aac', () => {
    // The order IS the policy — `chooseUploadEncoding` is a `find` over this
    // array — so the ranking is asserted here rather than inferred from the
    // choices below. Smallest first, with the row every build has last.
    expect(UPLOAD_ENCODINGS.map((encoding) => encoding.codec)).toEqual([
      'libopus',
      'libvorbis',
      'libmp3lame',
      'aac',
    ]);
  });

  it('never offers the native opus encoder', () => {
    // THE REGRESSION GUARD. Adding `opus` looks like free coverage: the macOS
    // build has it, it is the same codec, and it would have made the original
    // hard-coded version work. It does not work — the encoder refuses the only
    // sample rate this module ever produces, with “Specified sample rate 16000
    // is not supported by the opus encoder” — so a build that has it and
    // nothing else must still fall through to `aac`.
    expect(UPLOAD_ENCODINGS.map((encoding) => encoding.codec)).not.toContain('opus');
  });
});

describe('chooseUploadEncoding', () => {
  it('takes libopus when the build has it', () => {
    const encoding = chosen(parseEncoders(`${MACOS_LISTING}\n${WINDOWS_LIB_ROWS}`));
    expect(encoding).toMatchObject({ codec: 'libopus', extension: 'ogg', bitrate: '12k' });
  });

  it('takes aac on a build with only the native encoders', () => {
    // The measured macOS case, and the one the old code failed on outright.
    const encoding = chosen(MACOS_NATIVES);
    expect(encoding).toMatchObject({ codec: 'aac', extension: 'm4a' });
  });

  it('does not reach for the native opus that build does have', () => {
    // Same set as above, stated as its own assertion because this is the thing
    // that would break silently: the set contains `opus` and `vorbis`, and the
    // answer must still be `aac`.
    expect(MACOS_NATIVES.has('opus')).toBe(true);
    expect(chosen(MACOS_NATIVES).codec).not.toBe('opus');
  });

  it('does not mistake the native vorbis for libvorbis either', () => {
    expect(MACOS_NATIVES.has('vorbis')).toBe(true);
    expect(chosen(MACOS_NATIVES).codec).not.toBe('vorbis');
  });

  it('prefers each row over the ones below it', () => {
    expect(chosen(new Set(['libvorbis', 'libmp3lame', 'aac'])).codec).toBe('libvorbis');
    expect(chosen(new Set(['libmp3lame', 'aac'])).codec).toBe('libmp3lame');
    expect(chosen(new Set(['aac'])).codec).toBe('aac');
  });

  it('returns null when the build has no audio encoder at all', () => {
    expect(chooseUploadEncoding(new Set())).toBe(null);
    expect(chooseUploadEncoding(parseEncoders(VIDEO_ONLY_LISTING))).toBe(null);
  });

  it('returns null rather than the closest thing when nothing matches', () => {
    // A build full of audio encoders, none of them ours. `null` is what lets
    // the caller say so in words instead of spawning a doomed conversion.
    expect(chooseUploadEncoding(new Set(['flac', 'alac', 'wavpack', 'pcm_s16le']))).toBe(null);
  });

  it('gives every row a muxable extension and a bitrate', () => {
    // The extension is not decoration: the caller is handed a path without one
    // and writes the file under whatever this says, so an empty or dotted value
    // would produce a file no provider can identify.
    for (const encoding of UPLOAD_ENCODINGS) {
      expect(encoding.extension).toMatch(/^[a-z0-9]+$/);
      expect(encoding.bitrate).toMatch(/^\d+k$/);
      expect(encoding.label.length).toBeGreaterThan(0);
    }
  });
});


describe('fitBitrate', () => {
  const aac = UPLOAD_ENCODINGS.find((entry) => entry.codec === 'aac');
  if (aac === undefined) throw new Error('the aac row is the fallback every build has; it must exist');

  it('leaves the encoding alone when the provider publishes no ceiling', () => {
    // The common path: three of the four providers document no limit, and a
    // number we do not have is not a number to guess at.
    expect(fitBitrate(aac, 7_200_000, null)).toBe('32k');
  });

  it('leaves a file that already fits alone', () => {
    // An hour of 32 kbps is 13.7 MB, comfortably under OpenRouter's 17 MiB.
    expect(fitBitrate(aac, 60 * 60_000, 17 * 1024 * 1024)).toBe('32k');
  });

  it('lowers the rate for a film that would not fit', () => {
    // This is the case that broke: two hours at 32k measured 30 MB and was
    // rejected before the request left the machine.
    const chosen = fitBitrate(aac, 120 * 60_000, 17 * 1024 * 1024);
    expect(chosen).toBe('17k');
    const predictedBytes = (17 * 1000 * 120 * 60) / 8;
    expect(predictedBytes).toBeLessThan(17 * 1024 * 1024);
  });

  it('never raises the rate above the encoding’s own figure', () => {
    // A ceiling is a constraint, not a licence to spend more on a short file.
    expect(fitBitrate(aac, 10_000, 17 * 1024 * 1024)).toBe('32k');
  });

  it('floors rather than shaving away consonants', () => {
    // Four hours cannot fit whatever we do. Stopping at the floor hands the job
    // to the provider, whose own message explains the real problem, instead of
    // sending something too thin to transcribe.
    expect(fitBitrate(aac, 240 * 60_000, 17 * 1024 * 1024)).toBe('16k');
  });

  it('treats an unknown duration as no ceiling', () => {
    // `durationMs` is 0 when ffprobe could not measure the file. Guessing a
    // bitrate from a duration we do not have would be worse than not fitting.
    expect(fitBitrate(aac, 0, 17 * 1024 * 1024)).toBe('32k');
  });
});

/*
 * ── The floor was allowed to outrank the encoding ─────────────────────────
 *
 * `fitBitrate`'s own doc comment states the rule: "It never raises the bitrate
 * above the encoding's default. A ceiling is a constraint, not a licence to
 * spend more on a short file." The code did the opposite for any encoding whose
 * own rate sits below `MIN_UPLOAD_KBPS`:
 *
 *     Math.max(MIN_UPLOAD_KBPS, Math.min(preferred, fittedKbps))
 *
 * The floor is applied last, so when `preferred` (12 for Opus) is under the
 * floor (16), the floor wins and 16k comes back — at every duration, including
 * a one-minute file nowhere near the ceiling. The upload then grows by a third
 * while the function's whole purpose is to shrink it.
 *
 * Every test above used AAC, whose 32k is above the floor, which is exactly why
 * this survived. Opus is the encoding the app prefers when ffmpeg has it.
 */
describe('fitBitrate with an encoding whose own rate is below the floor', () => {
  const opus = UPLOAD_ENCODINGS.find((entry) => entry.codec === 'libopus');

  it('is the encoding the app prefers, and it is configured below the floor', () => {
    expect(opus).toBeDefined();
    expect(opus!.bitrate).toBe('12k');
  });

  it.each([1, 5, 30, 70, 120])('never exceeds its own 12k — %i minutes under a 17 MiB ceiling', (minutes) => {
    const chosen = fitBitrate(opus!, minutes * 60_000, 17 * 1024 * 1024);
    expect(Number.parseInt(chosen, 10)).toBeLessThanOrEqual(12);
  });

  it('still shrinks when the ceiling actually bites', () => {
    // Four hours at 12k is about 21 MiB, over the ceiling, so it has to come
    // down — and the floor may not push it back up.
    const chosen = Number.parseInt(fitBitrate(opus!, 240 * 60_000, 17 * 1024 * 1024), 10);
    expect(chosen).toBeLessThanOrEqual(12);
    expect(chosen).toBeGreaterThan(0);
  });
});
