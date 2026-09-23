#!/usr/bin/env bash
# Regenerates the lab's icons and social card into ../public from the sources
# in this folder. Needs Google Chrome (headless rendering) and python3 — no
# image libraries. Run after changing the mark, the stage list, or the copy:
#
#   ./brand/build.sh
#
# Outputs:
#   public/favicon.svg          modern browsers (vector, crisp at any DPI)
#   public/favicon.ico          16/32/48 fallback, PNG-in-ICO
#   public/apple-touch-icon.png 180x180, iOS home screen
#   public/og-image.png         1200x630, link previews (LinkedIn, Slack, X, iMessage)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../public"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || { echo "Chrome not found; set CHROME=/path/to/chrome" >&2; exit 1; }

# shot <html-file> <width> <height> <out.png>
shot() {
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --default-background-color=00000000 \
    --window-size="$2,$3" --screenshot="$4" "file://$1" >/dev/null 2>&1
}

# Render an SVG at an exact pixel size. Each size is rasterised from the
# vector directly (not downscaled), so 16px stays as crisp as it can.
#
# The box is sized in px and anchored top-left on purpose: headless Chrome
# clamps the viewport to a minimum width (~500px) even when --window-size is
# smaller, while still capturing only the requested area. With 100vw the icon
# gets centred in the wider viewport and a 180px capture shows only its left
# edge. Absolute px makes the result independent of that clamp.
svg_png() {
  local svg="$1" size="$2" out="$3"
  printf '<!doctype html><body style="margin:0"><img src="file://%s" style="display:block;width:%spx;height:%spx">' "$svg" "$size" "$size" > "$TMP/wrap.html"
  shot "$TMP/wrap.html" "$size" "$size" "$out"
}

cp "$HERE/mark.svg" "$OUT/favicon.svg"

for s in 16 32 48; do svg_png "$HERE/mark.svg" "$s" "$TMP/ico-$s.png"; done
svg_png "$HERE/touch-icon.svg" 180 "$OUT/apple-touch-icon.png"
shot "$HERE/og-image.html" 1200 630 "$OUT/og-image.png"

# PNG-in-ICO: a 6-byte header, one 16-byte directory entry per image, then the
# PNG payloads. Supported by every browser that still reads .ico.
python3 - "$TMP" "$OUT/favicon.ico" <<'PY'
import struct, sys
tmp, out = sys.argv[1], sys.argv[2]
images = [(s, open(f"{tmp}/ico-{s}.png", "rb").read()) for s in (16, 32, 48)]
offset = 6 + 16 * len(images)
entries, payload = b"", b""
for size, png in images:
    entries += struct.pack("<BBBBHHII", size, size, 0, 0, 1, 32, len(png), offset + len(payload))
    payload += png
with open(out, "wb") as f:
    f.write(struct.pack("<HHH", 0, 1, len(images)) + entries + payload)
PY

echo "Wrote favicon.svg, favicon.ico, apple-touch-icon.png, og-image.png to public/"
