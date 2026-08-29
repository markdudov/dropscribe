#!/usr/bin/env bash
#
# Regenerate every raster in build/ from build/icon.svg.
#
# Run it after touching the master SVG and commit whatever changes:
#
#     ./build/generate-icons.sh
#
# WHY THIS SCRIPT EXISTS AT ALL, RATHER THAN AN npm DEVDEPENDENCY:
# the rasters are committed, so they are built once per icon change and never
# in CI or on `npm install`. Pulling in `sharp`, `@resvg/resvg-js` or
# `icon-gen` for that would add a native, prebuilt-per-platform dependency to
# every contributor's install — and to `postinstall`, which already has to
# fetch ~40 MB of engine binaries — in exchange for a file nobody regenerates.
# Everything below is macOS built-ins plus the Node this repo already requires.
#
# WHY macOS ONLY: `iconutil` produces the .icns and ships with the OS, and
# there is no equivalent on Windows or Linux. DropScribe's macOS build has to
# happen on a Mac anyway (codesign, notarization), so the icons are made where
# the app is made. On any other platform this script stops immediately and
# tells you what to install instead; see build/README.md.
#
# THE ROUTE, AND WHY IT LOOKS ODD:
#   1. `qlmanage -t` rasterizes the SVG through Quick Look — the only SVG
#      rasterizer guaranteed to be on a stock Mac. ImageMagick, rsvg-convert,
#      Inkscape and Python's Pillow are all absent from a clean install, so
#      none of them may be the required route.
#   2. Quick Look thumbnails are OPAQUE. It composites the SVG onto white and
#      hands back alpha=255 everywhere, which would give macOS a white square
#      behind the rounded corners instead of the transparency it expects. So
#      every size is rendered TWICE: once as-is (over Quick Look's white) and
#      once with a full-canvas black path injected behind the artwork. For a
#      pixel of colour C and coverage a those two renders are
#          Cw = C*a + 255*(1-a)      and      Cb = C*a
#      so  a = 255 - (Cw - Cb)  and  C = Cb/a. That is exact, not a heuristic,
#      and it recovers the antialiased edges too. `icon-tools.mjs compose`
#      does the arithmetic and writes a real RGBA PNG.
#   3. Each size is rendered from the VECTOR at its own resolution rather than
#      downsampled from 1024. The master's geometry comment explains that the
#      three baselines are phased so they survive 16 px and 48 px as three
#      separate stripes; resampling a 1024 px render is what turns them into a
#      grey slab. `sips -z` would have been one line and is the wrong line.
#
set -euo pipefail

BUILD_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MASTER="$BUILD_DIR/icon.svg"

fail() { printf 'generate-icons: %s\n' "$*" >&2; exit 1; }

# ── Preconditions ───────────────────────────────────────────────────────────
# Checked up front and named individually. A missing tool that surfaces
# halfway through leaves a half-written icon set in the working tree, and
# "command not found" three steps in does not tell you which step it was.
[ "$(uname -s)" = "Darwin" ] || fail "this script needs macOS (qlmanage + iconutil). See build/README.md for the commands to run elsewhere."
[ -f "$MASTER" ] || fail "missing master artwork: $MASTER"
for tool in qlmanage iconutil node; do
  command -v "$tool" >/dev/null 2>&1 || fail "'$tool' not found on PATH. qlmanage and iconutil ship with macOS; node is this repo's own requirement."
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dropscribe-icons.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

TOOLS="$TMP/icon-tools.mjs"

# The helper lives inside this script instead of beside it so there is exactly
# one file to keep in sync with the master, and no half-orphaned .mjs in build/
# that looks like something the app imports.
cat > "$TOOLS" <<'MJSEOF'
/**
 * Pixel plumbing for generate-icons.sh: PNG decode, PNG encode, alpha
 * recovery from a white/black render pair, and an ICO writer.
 *
 * Node built-ins only — `node:zlib` is the entire dependency list, and it is
 * enough because PNG's compressed stream *is* zlib and everything around it is
 * a length, a four-letter tag and a CRC.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function die(message) {
  process.stderr.write(`icon-tools: ${message}\n`);
  process.exit(1);
}

/**
 * CRC-32 by table.
 *
 * `zlib.crc32()` exists from Node 20.15, but this script is the one piece of
 * the repo a contributor might run on whatever Node they happen to have, and a
 * ten-line table costs nothing next to a version floor nobody documented.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Decode a PNG to straight (non-premultiplied) RGBA.
 *
 * Deliberately narrow: 8-bit, non-interlaced, RGB or RGBA. That is exactly
 * what Quick Look emits and exactly what this script re-encodes, so anything
 * else arriving here means the input is not what we produced and should stop
 * the build rather than be half-handled.
 */
function decodePng(file) {
  const buf = readFileSync(file);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) die(`${file} is not a PNG`);

  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      // Encoders are free to split the zlib stream across any number of IDAT
      // chunks; concatenating them is the spec, not a workaround.
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }

  if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    die(`${file}: unsupported PNG (depth=${depth} colorType=${colorType} interlace=${interlace})`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) die(`${file}: truncated image data`);

  // Un-filter in place, row by row. Each scanline is prefixed with its filter
  // type and is predicted from the reconstructed bytes to its left (a) and
  // above (b) — so this loop has to walk forward and cannot be vectorised away.
  const pixels = Buffer.alloc(height * stride);
  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++];
    const line = raw.subarray(read, read + stride);
    read += stride;
    const cur = pixels.subarray(y * stride, y * stride + stride);
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = y > 0 ? pixels[prevStart + x] : 0;
      const c = y > 0 && x >= channels ? pixels[prevStart + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        die(`${file}: unknown scanline filter ${filter} on row ${y}`);
      }
      cur[x] = value & 0xff;
    }
  }

  if (channels === 4) return { width, height, rgba: pixels };

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i];
    rgba[j + 1] = pixels[i + 1];
    rgba[j + 2] = pixels[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/**
 * Encode straight RGBA as an 8-bit RGBA PNG.
 *
 * Filters are chosen per row by the minimum-sum-of-absolute-differences
 * heuristic from the PNG spec's own encoding guide. Writing filter 0
 * everywhere would have been shorter and roughly doubles the file for the
 * antialiased edges; these files are committed, so the size is permanent.
 */
function encodePng(width, height, rgba) {
  const channels = 4;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  const candidate = Buffer.alloc(stride);
  let write = 0;

  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    let bestFilter = 0;
    let bestScore = Infinity;
    let best = Buffer.alloc(0);

    for (let filter = 0; filter <= 4; filter++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const value = rgba[rowStart + x];
        const a = x >= channels ? rgba[rowStart + x - channels] : 0;
        const b = y > 0 ? rgba[prevStart + x] : 0;
        const c = y > 0 && x >= channels ? rgba[prevStart + x - channels] : 0;
        let out;
        if (filter === 0) out = value;
        else if (filter === 1) out = value - a;
        else if (filter === 2) out = value - b;
        else if (filter === 3) out = value - ((a + b) >> 1);
        else {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          out = value - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        out &= 0xff;
        candidate[x] = out;
        score += out < 128 ? out : 256 - out;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
        best = Buffer.from(candidate);
      }
    }

    raw[write++] = bestFilter;
    best.copy(raw, write);
    write += stride;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: truecolour with alpha
  ihdr[10] = 0;  // compression: deflate
  ihdr[11] = 0;  // filter method: adaptive
  ihdr[12] = 0;  // interlace: none

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Inject a full-canvas black path behind the artwork; see the header of generate-icons.sh. */
function backdrop(inFile, outFile) {
  const svg = readFileSync(inFile, 'utf8');
  const open = /<svg\b[^>]*>/.exec(svg);
  if (open === null) die(`${inFile}: no <svg> element`);

  // The canvas is read from viewBox rather than width/height because the
  // backdrop has to be in USER space — the same coordinate system the
  // artwork's own paths are in — and viewBox is what defines that.
  const viewBox = /viewBox\s*=\s*"([^"]+)"/.exec(open[0]);
  let x = 0;
  let y = 0;
  let w = Number.NaN;
  let h = Number.NaN;
  if (viewBox !== null) {
    const parts = viewBox[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) die(`${inFile}: unreadable viewBox`);
    [x, y, w, h] = parts;
  } else {
    w = Number.parseFloat(/\bwidth\s*=\s*"([\d.]+)/.exec(open[0])?.[1] ?? '');
    h = Number.parseFloat(/\bheight\s*=\s*"([\d.]+)/.exec(open[0])?.[1] ?? '');
  }
  if (!Number.isFinite(w) || !Number.isFinite(h)) die(`${inFile}: cannot determine the canvas size`);

  // A <path>, not a <rect>, for the same reason the master uses paths
  // throughout: it is the SVG subset every rasterizer reproduces identically.
  const cover = `<path fill="#000000" d="M ${x},${y} L ${x + w},${y} L ${x + w},${y + h} L ${x},${y + h} Z" />`;
  const at = open.index + open[0].length;
  writeFileSync(outFile, `${svg.slice(0, at)}${cover}${svg.slice(at)}`);
}

/**
 * Recover straight RGBA from the white-composited and black-composited renders.
 *
 * Alpha is averaged over the three channels: the two renders differ by exactly
 * 255*(1-a) in every channel, so any one of them would do, and averaging just
 * cancels the ±1 each picked up from being rounded to 8 bits independently.
 */
function compose(whiteFile, blackFile, outFile) {
  const white = decodePng(whiteFile);
  const black = decodePng(blackFile);
  if (white.width !== black.width || white.height !== black.height) {
    die(`render pair disagrees on size: ${white.width}x${white.height} vs ${black.width}x${black.height}`);
  }

  const out = Buffer.alloc(white.width * white.height * 4);
  for (let i = 0; i < out.length; i += 4) {
    let alpha = 0;
    for (let c = 0; c < 3; c++) alpha += 255 - (white.rgba[i + c] - black.rgba[i + c]);
    alpha = Math.min(255, Math.max(0, Math.round(alpha / 3)));
    out[i + 3] = alpha;
    for (let c = 0; c < 3; c++) {
      // The black render is premultiplied by construction (C*a), so dividing
      // by alpha gives the straight colour PNG wants. At alpha 0 there is no
      // colour to recover and 0,0,0 is what every other rasterizer writes
      // there — a fully transparent pixel's RGB is never sampled.
      out[i + c] = alpha === 0 ? 0 : Math.min(255, Math.round((black.rgba[i + c] * 255) / alpha));
    }
  }

  writeFileSync(outFile, encodePng(white.width, white.height, out));
}

/**
 * Assemble an .ico from a set of PNGs.
 *
 * Every entry is a PNG, including 16 and 32. The alternative — BMP/DIB entries
 * with a separate 1-bit AND mask for the small sizes, which is what pre-Vista
 * Windows needed — means hand-rolling row padding and mask packing that I
 * cannot test on the platform that consumes it. Windows has read PNG-compressed
 * ICO entries at every size since Vista, Electron 43 requires Windows 10, and
 * electron-builder reads the directory rather than decoding it. A format that
 * is verifiably right beats one that is theoretically more compatible and
 * silently wrong.
 */
function ico(outFile, pngFiles) {
  const images = pngFiles.map((file) => {
    const bytes = readFileSync(file);
    const { width, height } = decodePng(file);
    if (width > 256 || height > 256) die(`${file}: ${width}x${height} does not fit in an .ico (max 256)`);
    return { bytes, width, height };
  });

  const HEADER = 6;
  const ENTRY = 16;
  const header = Buffer.alloc(HEADER);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // 1 = icon (2 would be a cursor)
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(ENTRY * images.length);
  let offset = HEADER + ENTRY * images.length;
  images.forEach((image, index) => {
    const at = index * ENTRY;
    // 256 is written as 0: the field is one byte, so 256 does not fit, and 0
    // is the spec's escape for it. Writing 255 here is the classic off-by-one
    // that makes Windows show a 255-pixel-wide icon scaled badly.
    directory[at] = image.width === 256 ? 0 : image.width;
    directory[at + 1] = image.height === 256 ? 0 : image.height;
    directory[at + 2] = 0;                 // palette size; 0 = not paletted
    directory[at + 3] = 0;                 // reserved
    directory.writeUInt16LE(1, at + 4);    // colour planes
    directory.writeUInt16LE(32, at + 6);   // bits per pixel
    directory.writeUInt32LE(image.bytes.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.bytes.length;
  });

  writeFileSync(outFile, Buffer.concat([header, directory, ...images.map((i) => i.bytes)]));
}

/** Print `<width>x<height>` for a PNG, so the shell can assert on it. */
function inspectPng(file) {
  const { width, height } = decodePng(file);
  process.stdout.write(`${width}x${height}\n`);
}

/**
 * Re-open a finished .ico and check every entry against the PNG it points at.
 *
 * This reads the file back off disk rather than trusting the writer above,
 * because the whole point of a hand-rolled container is that nothing else will
 * catch it if the offsets are wrong.
 */
function verifyIco(file) {
  const buf = readFileSync(file);
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) die(`${file}: not an icon directory`);
  const count = buf.readUInt16LE(4);
  if (count === 0) die(`${file}: contains no images`);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const declared = buf[at] === 0 ? 256 : buf[at];
    const length = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    if (offset + length > buf.length) die(`${file}: entry ${i} runs past the end of the file`);
    const payload = buf.subarray(offset, offset + length);
    if (!payload.subarray(0, 8).equals(SIGNATURE)) die(`${file}: entry ${i} is not the PNG it claims to be`);
    const width = payload.readUInt32BE(16);
    const height = payload.readUInt32BE(20);
    if (width !== declared || height !== declared) {
      die(`${file}: entry ${i} declares ${declared}px but the image is ${width}x${height}`);
    }
    sizes.push(declared);
  }
  process.stdout.write(`${sizes.join(' ')}\n`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'backdrop') backdrop(args[0], args[1]);
else if (command === 'compose') compose(args[0], args[1], args[2]);
else if (command === 'ico') ico(args[0], args.slice(1));
else if (command === 'inspect') inspectPng(args[0]);
else if (command === 'verify-ico') verifyIco(args[0]);
else die(`unknown command: ${String(command)}`);
MJSEOF

# The master is copied under a fresh name for each run. Quick Look keeps a
# thumbnail cache keyed by the file it was asked about, and a stale hit would
# silently regenerate the *previous* artwork — the failure mode where you edit
# the SVG, rerun this, and the icons do not change.
STAMP="$(date +%s)-$$"
WHITE_SVG="$TMP/w-$STAMP.svg"
BLACK_SVG="$TMP/b-$STAMP.svg"
cp "$MASTER" "$WHITE_SVG"
node "$TOOLS" backdrop "$MASTER" "$BLACK_SVG"

# 16/32/48/64/128/256 are what the .ico needs; 512 and 1024 are what the .icns
# adds on top. Rendered once each and shared between the two containers.
SIZES=(16 32 48 64 128 256 512 1024)

render() {  # render <svg> <size> <destination.png>
  local svg="$1" size="$2" dest="$3"
  local out="$TMP/ql-$size-$(basename "$svg" .svg)"
  mkdir -p "$out"
  qlmanage -t -s "$size" -o "$out" "$svg" >/dev/null 2>&1 || true
  local produced="$out/$(basename "$svg").png"
  # qlmanage exits 0 whether or not it produced anything, so the existence of
  # the file is the only honest success signal.
  [ -f "$produced" ] || fail "Quick Look produced no thumbnail for $(basename "$svg") at ${size}px. On a machine with no window server (a headless CI runner, a plain ssh session) qlmanage cannot render — run this on a desktop session."
  mv "$produced" "$dest"
}

printf 'Rasterizing %s\n' "$MASTER"
for size in "${SIZES[@]}"; do
  render "$WHITE_SVG" "$size" "$TMP/white-$size.png"
  render "$BLACK_SVG" "$size" "$TMP/black-$size.png"
  node "$TOOLS" compose "$TMP/white-$size.png" "$TMP/black-$size.png" "$TMP/icon-$size.png"
  actual="$(node "$TOOLS" inspect "$TMP/icon-$size.png")"
  [ "$actual" = "${size}x${size}" ] || fail "expected ${size}x${size} at step ${size}, got $actual"
  printf '  %4spx  ok\n' "$size"
done

# ── icon.png — the 1024 master raster; also what electron-builder uses on Linux ──
cp "$TMP/icon-1024.png" "$BUILD_DIR/icon.png"

# ── icon.icns ───────────────────────────────────────────────────────────────
# iconutil takes a directory of exactly-named files and nothing else; an
# unexpected name in there is a hard error, not a warning.
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"
cp "$TMP/icon-16.png"   "$ICONSET/icon_16x16.png"
cp "$TMP/icon-32.png"   "$ICONSET/icon_16x16@2x.png"
cp "$TMP/icon-32.png"   "$ICONSET/icon_32x32.png"
cp "$TMP/icon-64.png"   "$ICONSET/icon_32x32@2x.png"
cp "$TMP/icon-128.png"  "$ICONSET/icon_128x128.png"
cp "$TMP/icon-256.png"  "$ICONSET/icon_128x128@2x.png"
cp "$TMP/icon-256.png"  "$ICONSET/icon_256x256.png"
cp "$TMP/icon-512.png"  "$ICONSET/icon_256x256@2x.png"
cp "$TMP/icon-512.png"  "$ICONSET/icon_512x512.png"
cp "$TMP/icon-1024.png" "$ICONSET/icon_512x512@2x.png"
iconutil --convert icns --output "$BUILD_DIR/icon.icns" "$ICONSET"

# ── icon.ico ────────────────────────────────────────────────────────────────
node "$TOOLS" ico "$BUILD_DIR/icon.ico" \
  "$TMP/icon-16.png" "$TMP/icon-32.png" "$TMP/icon-48.png" \
  "$TMP/icon-64.png" "$TMP/icon-128.png" "$TMP/icon-256.png"

# ── Verify what we just wrote, from disk ────────────────────────────────────
# Not a formality. Every container here is assembled by code in this file, and
# a wrong offset or a mislabelled size produces a file that opens in Preview
# and fails in the installer.
png_size="$(node "$TOOLS" inspect "$BUILD_DIR/icon.png")"
[ "$png_size" = "1024x1024" ] || fail "icon.png is $png_size, expected 1024x1024"

# The round trip is the check: iconutil can only expand an .icns it can parse.
iconutil --convert iconset --output "$TMP/roundtrip.iconset" "$BUILD_DIR/icon.icns"
roundtrip_count="$(find "$TMP/roundtrip.iconset" -name '*.png' | wc -l | tr -d ' ')"
[ "$roundtrip_count" = "10" ] || fail "icon.icns round-tripped to $roundtrip_count images, expected 10"

ico_sizes="$(node "$TOOLS" verify-ico "$BUILD_DIR/icon.ico")"
[ "$ico_sizes" = "16 32 48 64 128 256" ] || fail "icon.ico holds [$ico_sizes], expected [16 32 48 64 128 256]"

printf '\nWrote:\n'
for f in icon.png icon.icns icon.ico; do
  printf '  %-10s %8s bytes\n' "$f" "$(wc -c < "$BUILD_DIR/$f" | tr -d ' ')"
done
printf '  icon.icns holds %s images, icon.ico holds %s\n' "$roundtrip_count" "$ico_sizes"
