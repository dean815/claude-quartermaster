#!/usr/bin/env python3
"""Subset a Nerd Font down to the three client glyphs and emit an @font-face.

The glyphs are Private Use Area codepoints. They render on this machine because
a dozen patched Nerd Fonts are installed, but the published artifact runs on
someone else's device behind a CSP that blocks font CDNs — there they would be
tofu. A three-glyph subset inlined as a data URI is a couple of KB and works
everywhere, so the page never depends on what the viewer has installed.

  python3 make_glyphfont.py     # writes icons/glyphs.css
"""

import base64
import glob
import os
import sys
from pathlib import Path

OUT = Path(__file__).parent / "icons" / "glyphs.css"

GLYPHS = {
    0xF108:  "desktop",
    0xE795:  "cli",
    0xF109B: "api",
}

# Any patched Nerd Font carries the same icon set; pick a clean one that has all three.
CANDIDATES = [
    "FiraCodeNerdFont-Regular.ttf",
    "GoogleSansCodeNerdFont-Regular.ttf",
    "CousineNerdFont-Regular.ttf",
    "AgaveNerdFont-Regular.ttf",
]


def pick_font():
    home = Path.home() / "Library/Fonts"
    for name in CANDIDATES:
        p = home / name
        if p.exists():
            return p
    for p in sorted(home.glob("*NerdFont-Regular.ttf")):
        return p
    return None


def main():
    try:
        from fontTools import subset
        from fontTools.ttLib import TTFont
    except ImportError:
        sys.exit("fontTools missing: .venv/bin/pip install fonttools brotli")

    src = pick_font()
    if not src:
        sys.exit("no Nerd Font found in ~/Library/Fonts")

    font = TTFont(str(src), fontNumber=0)
    cmap = font.getBestCmap()
    missing = [hex(c) for c in GLYPHS if c not in cmap]
    if missing:
        sys.exit(f"{src.name} is missing {missing}")

    opts = subset.Options()
    opts.desubroutinize = True
    opts.notdef_outline = True
    opts.layout_features = []
    opts.name_IDs = []
    subsetter = subset.Subsetter(options=opts)
    subsetter.populate(unicodes=list(GLYPHS))
    subsetter.subset(font)

    fmt, mime = "woff2", "font/woff2"
    try:
        font.flavor = "woff2"
        tmp = OUT.parent / "_tmp.woff2"
        font.save(str(tmp))
    except Exception:                       # brotli not installed
        font.flavor = None
        fmt, mime = "truetype", "font/ttf"
        tmp = OUT.parent / "_tmp.ttf"
        font.save(str(tmp))

    b64 = base64.b64encode(tmp.read_bytes()).decode()
    size = tmp.stat().st_size
    tmp.unlink()

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(
        f"@font-face{{font-family:'FleetGlyph';font-style:normal;font-weight:400;"
        f"font-display:block;src:url(data:{mime};base64,{b64}) format('{fmt}')}}\n")
    print(f"{OUT.relative_to(OUT.parent.parent)} · {src.name} · {fmt} · "
          f"{size} bytes raw, {len(b64)} base64")


if __name__ == "__main__":
    main()
