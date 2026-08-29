# build/ — application icons

electron-builder reads this directory by convention. Nothing here is imported by
the app; these files are consumed at packaging time and never at run time.

This file covers the icons only. Other packaging inputs live here too — the
macOS entitlements plist among them — and are documented where they are used.

| File | Consumer | Contents |
| --- | --- | --- |
| `icon.svg` | nothing automated — it is the **master** | the artwork, with the reasoning for every number in its own comments |
| `icon.png` | electron-builder (Linux target, and its own fallback source) | 1024 × 1024 RGBA |
| `icon.icns` | electron-builder (`mac`) | 16, 32, 64, 128, 256, 512, 1024 — ten entries, each of 16/32/128/256/512 present at both 1× and 2× |
| `icon.ico` | electron-builder (`win`, and the NSIS installer) | 16, 32, 48, 64, 128, 256 |

**The three rasters are generated, not drawn.** Edit `icon.svg`, then run

```bash
./build/generate-icons.sh
```

and commit whatever changed. Hand-editing a raster means the next person to run
that script silently reverts your work.

---

## What the script actually does, and why it is not one line

`icon.png` could be `sips -s format png icon.svg --out icon.png` if any of that
worked the way it reads. Three things get in the way, and each one is why the
script is longer than you expect.

**1. A clean Mac has no SVG rasterizer on `PATH`.** Not ImageMagick, not
`rsvg-convert`, not Inkscape; Python is present but Pillow and cairosvg are not,
and `sips` does not read SVG. What *is* always present is Quick Look, and
`qlmanage -t -s <n> -o <dir> icon.svg` renders the file at any size. That is the
only rasterizer the script is allowed to depend on.

**2. Quick Look thumbnails are opaque.** It composites onto white and returns
`alpha = 255` everywhere, so a naive one-pass route ships an icon with a white
square behind the rounded corners — visible on every dark Dock and every dark
taskbar, and exactly the thing `icon.svg`'s own comments say the transparency is
there to avoid. The script therefore renders each size twice: once as-is, and
once from a temporary copy of the SVG with a full-canvas black path injected
behind the artwork. For a pixel of colour `C` and coverage `a`,

```
white render:  Cw = C·a + 255·(1 − a)
black render:  Cb = C·a
       hence:  a = 255 − (Cw − Cb)        and       C = Cb / a
```

That is algebra, not an approximation — it recovers the antialiased edges at
their true fractional coverage, and it is what `compose` in the embedded
`icon-tools.mjs` computes.

**3. Every size is rendered from the vector, not downsampled from 1024.**
`icon.svg` explains that the three baselines sit on a 128 px pitch specifically
so that at 16 px and 48 px each one lands on a whole pixel and they stay three
stripes. Resampling a 1024 px raster ignores that phase and returns a grey slab.
`sips -z 16 16` would have been one line and the wrong one.

The `.icns` is then `iconutil`'s job. The `.ico` has no system tool at all on
macOS, so the script writes the container itself — a 6-byte header, a 16-byte
directory entry per image, and the PNG bytes verbatim.

### Why the .ico stores PNGs at every size, including 16

The older convention is BMP/DIB entries with a separate 1-bit AND mask below
about 48 px. Windows has read PNG-compressed ICO entries at every size since
Vista, Electron 43 requires Windows 10, and electron-builder reads the icon
directory rather than decoding the images. Hand-rolling DIB row padding and mask
packing to satisfy an OS version this app cannot run on would mean shipping
bytes that no machine here can test. A container that is verifiably correct
beats one that is theoretically more compatible and quietly wrong.

### The script verifies its own output

It re-reads all three files from disk before it reports success: `icon.png` must
decode as 1024 × 1024, `icon.icns` must survive an `iconutil --convert iconset`
round trip into ten images, and every `.ico` directory entry is checked against
the IHDR of the PNG it points at, so a bad offset or a mislabelled size fails
the run instead of the installer.

### When it will refuse to run

- **Not macOS.** `iconutil` has no equivalent elsewhere. Use the route below.
- **No window server.** Quick Look needs a session; over plain `ssh`, or on a
  headless CI runner, `qlmanage` produces nothing and the script says so rather
  than writing a truncated icon set. This is not a problem in practice — the
  rasters are committed, so CI never regenerates them.

---

## Regenerating without this script

Any of these produce a correct `icon.png`; all of them handle transparency
natively, so the two-pass trick above is unnecessary once you have one:

```bash
rsvg-convert -w 1024 -h 1024 build/icon.svg -o build/icon.png     # librsvg
magick -background none build/icon.svg -resize 1024x1024 build/icon.png   # ImageMagick 7
inkscape -w 1024 -h 1024 build/icon.svg -o build/icon.png          # Inkscape 1.x
python3 -c "import cairosvg; cairosvg.svg2png(url='build/icon.svg', write_to='build/icon.png', output_width=1024, output_height=1024)"
```

A headless Chromium also works, on any platform, and is often the one thing
already installed — verified to give a genuinely transparent 1024 × 1024 PNG:

```bash
chrome --headless --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 \
  --window-size=1024,1024 --screenshot=build/icon.png \
  "file://$PWD/build/icon.svg"
```

Render each of 16, 32, 48, 64, 128, 256, 512 and 1024 the same way — from the
vector, not by scaling the 1024 — then:

```bash
# .icns, macOS only
mkdir icon.iconset
cp icon-16.png icon.iconset/icon_16x16.png
cp icon-32.png icon.iconset/icon_16x16@2x.png
cp icon-32.png icon.iconset/icon_32x32.png
cp icon-64.png icon.iconset/icon_32x32@2x.png
cp icon-128.png icon.iconset/icon_128x128.png
cp icon-256.png icon.iconset/icon_128x128@2x.png
cp icon-256.png icon.iconset/icon_256x256.png
cp icon-512.png icon.iconset/icon_256x256@2x.png
cp icon-512.png icon.iconset/icon_512x512.png
cp icon-1024.png icon.iconset/icon_512x512@2x.png
iconutil --convert icns --output build/icon.icns icon.iconset

# .icns, elsewhere — libicns, packaged as icnsutils on Debian/Ubuntu
png2icns build/icon.icns icon-16.png icon-32.png icon-48.png icon-128.png icon-256.png icon-512.png

# .ico, any platform — icoutils
icotool -c -o build/icon.ico icon-16.png icon-32.png icon-48.png icon-64.png icon-128.png icon-256.png

# .ico, ImageMagick 7 alternative
magick icon-16.png icon-32.png icon-48.png icon-64.png icon-128.png icon-256.png build/icon.ico
```

Check the result the way the script does:

```bash
file build/icon.png                                      # expect 1024 x 1024, RGBA
iconutil --convert iconset --output /tmp/rt.iconset build/icon.icns && ls /tmp/rt.iconset
file build/icon.ico                                      # expect "6 icons"
```

`file` reporting `8-bit/color RGB` rather than `RGBA` on `icon.png` means the
alpha was lost somewhere — the icon will ship with a white box behind its
corners. Re-render; do not "fix" it by adding a background to the SVG.
