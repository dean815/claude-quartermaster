#!/usr/bin/env python3
"""Generate the menu bar template icons. No image libraries needed.

macOS template images carry shape in the alpha channel only — the system paints
them black on a light menu bar and white on a dark one, so we never pick a colour.

Two robot-agent marks, both of which survive the shrink to 20pt:

  robot   filled squircle head, antenna, ear tabs, eyes knocked out of the fill
  bubble  the same face inside a speech bubble with a tail

Idle is the outlined form, alert is the filled form. No badge dot — every badge
tested collided with the glyph at this size.

  python3 make_icon.py                 # robot, the default
  python3 make_icon.py --style bubble
"""

import argparse
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).parent / "icons"
SS = 8                      # supersample factor; downsampled to give clean antialiasing

# rumps displays a status icon at 20pt and NSImage will not resolve an @2x sibling
# from a bare path, so one 40px bitmap in a 20pt box is exactly right on Retina.
RENDER_PX = 40


class Canvas:
    """Coverage buffer at SS× resolution, resolved to an 8-bit alpha mask.

    Every primitive takes `erase`: painting 0 instead of 255 is how the eyes get
    knocked out of a filled head, which is what keeps the glyph readable as a
    template image (there is no background to draw them in).
    """

    def __init__(self, size):
        self.n = size * SS
        self.size = size
        self.buf = bytearray(self.n * self.n)

    def _set(self, x, y, erase=False):
        if 0 <= x < self.n and 0 <= y < self.n:
            self.buf[y * self.n + x] = 0 if erase else 255

    def disc(self, cx, cy, r, erase=False):
        cx, cy, r = cx * SS, cy * SS, r * SS
        rr = r * r
        for y in range(int(cy - r - 1), int(cy + r + 2)):
            dy = y + 0.5 - cy
            for x in range(int(cx - r - 1), int(cx + r + 2)):
                dx = x + 0.5 - cx
                if dx * dx + dy * dy <= rr:
                    self._set(x, y, erase)

    def rect(self, x0, y0, w, h, erase=False):
        for y in range(int(y0 * SS), int((y0 + h) * SS)):
            for x in range(int(x0 * SS), int((x0 + w) * SS)):
                self._set(x, y, erase)

    def rrect(self, x0, y0, w, h, r, erase=False):
        """Rounded rectangle: a cross of two rects plus four corner discs."""
        r = min(r, w / 2, h / 2)
        self.rect(x0 + r, y0, w - 2 * r, h, erase)
        self.rect(x0, y0 + r, w, h - 2 * r, erase)
        for cx in (x0 + r, x0 + w - r):
            for cy in (y0 + r, y0 + h - r):
                self.disc(cx, cy, r, erase)

    def poly(self, pts, erase=False):
        """Scanline fill of an arbitrary polygon, in grid units."""
        ys = [p[1] * SS for p in pts]
        for y in range(int(min(ys)), int(max(ys)) + 1):
            hits = []
            for i in range(len(pts)):
                x1, y1 = pts[i][0] * SS, pts[i][1] * SS
                x2, y2 = pts[(i + 1) % len(pts)][0] * SS, pts[(i + 1) % len(pts)][1] * SS
                if (y1 <= y < y2) or (y2 <= y < y1):
                    hits.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
            hits.sort()
            for i in range(0, len(hits) - 1, 2):
                for x in range(int(hits[i]), int(hits[i + 1]) + 1):
                    self._set(x, y, erase)

    def alpha(self):
        """Box-downsample the coverage buffer to size×size 8-bit alpha."""
        n, s, area = self.n, self.size, SS * SS
        out = bytearray(s * s)
        for y in range(s):
            for x in range(s):
                acc = 0
                for j in range(SS):
                    row = (y * SS + j) * n + x * SS
                    acc += sum(self.buf[row:row + SS])
                out[y * s + x] = acc // area
        return out


def crop(alpha, size):
    """Trim fully transparent rows and columns. Returns (pixels, w, h).

    The mark does not fill its square: the robot leaves ~5px of empty canvas
    below the chin. Shipping that padding inside the image makes the status item
    wider and shorter-looking than it needs to be, because macOS scales the whole
    square to the menu bar height. Cropping lets the artwork own every pixel.
    """
    cols = [x for x in range(size) if any(alpha[y * size + x] for y in range(size))]
    rows = [y for y in range(size) if any(alpha[y * size + x] for x in range(size))]
    if not cols or not rows:
        return alpha, size, size
    x0, x1, y0, y1 = min(cols), max(cols), min(rows), max(rows)
    w, h = x1 - x0 + 1, y1 - y0 + 1
    out = bytearray(w * h)
    for y in range(h):
        src = (y + y0) * size + x0
        out[y * w:(y + 1) * w] = alpha[src:src + w]
    return out, w, h


def write_png(path, w, alpha, h=None):
    """8-bit grayscale+alpha PNG. Grey channel is 0 (black) throughout."""
    h = h if h is not None else w
    size = w
    raw = bytearray()
    for y in range(h):
        raw.append(0)                                   # filter type: none
        for x in range(w):
            raw += bytes((0, alpha[y * w + x]))         # black, coverage

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    path.write_bytes(b"\x89PNG\r\n\x1a\n"
                     + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 4, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
                     + chunk(b"IEND", b""))


# --------------------------------------------------------------------------- marks
# Both marks are laid out on an 18-unit grid and scaled to the render size.

def robot(size, alert):
    k = size / 18.0
    c = Canvas(size)
    stroke = 1.7

    c.rrect(8.3 * k, 1.5 * k, 1.4 * k, 3.0 * k, 0.7 * k)      # antenna stem
    c.disc(9 * k, 1.35 * k, 1.35 * k)                          # antenna ball
    c.rrect(0.5 * k, 8.2 * k, 1.7 * k, 3.0 * k, 0.85 * k)      # ear tabs
    c.rrect(15.8 * k, 8.2 * k, 1.7 * k, 3.0 * k, 0.85 * k)

    c.rrect(2.4 * k, 4.2 * k, 13.2 * k, 11.2 * k, 3.4 * k)
    if alert:
        c.disc(6.4 * k, 9.4 * k, 1.5 * k, erase=True)          # eyes knocked out
        c.disc(11.6 * k, 9.4 * k, 1.5 * k, erase=True)
    else:
        c.rrect((2.4 + stroke) * k, (4.2 + stroke) * k,
                (13.2 - 2 * stroke) * k, (11.2 - 2 * stroke) * k,
                (3.4 - stroke) * k, erase=True)
        c.disc(6.4 * k, 9.4 * k, 1.4 * k)
        c.disc(11.6 * k, 9.4 * k, 1.4 * k)
    return c.alpha()


def bubble(size, alert):
    k = size / 18.0
    c = Canvas(size)
    stroke = 1.7
    tail = [(5.3 * k, 12.6 * k), (4.5 * k, 16.7 * k), (9.0 * k, 12.6 * k)]

    c.poly(tail)                                               # tail stays solid in both
    c.rrect(1.9 * k, 2.9 * k, 14.2 * k, 11.0 * k, 3.5 * k)
    if alert:
        c.disc(6.9 * k, 7.5 * k, 1.35 * k, erase=True)
        c.disc(11.1 * k, 7.5 * k, 1.35 * k, erase=True)
        c.rrect(6.6 * k, 10.2 * k, 4.8 * k, 1.4 * k, 0.7 * k, erase=True)
    else:
        c.rrect((1.9 + stroke) * k, (2.9 + stroke) * k,
                (14.2 - 2 * stroke) * k, (11.0 - 2 * stroke) * k,
                (3.5 - stroke) * k, erase=True)
        c.poly(tail)                                           # redraw: the inset ate it
        c.disc(6.9 * k, 7.5 * k, 1.35 * k)
        c.disc(11.1 * k, 7.5 * k, 1.35 * k)
        c.rrect(6.6 * k, 10.2 * k, 4.8 * k, 1.4 * k, 0.7 * k)
    return c.alpha()


STYLES = {"robot": robot, "bubble": bubble}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--style", choices=sorted(STYLES), default="robot")
    ap.add_argument("--preview", action="store_true",
                    help="print an ASCII proof at 18px instead of writing files")
    args = ap.parse_args()
    draw = STYLES[args.style]

    if args.preview:
        ramp = " .:-=+*#%@"
        idle, alert = draw(18, False), draw(18, True)
        print(f"{args.style}      idle              alert")
        for y in range(18):
            l = "".join(ramp[min(9, idle[y * 18 + x] * 10 // 256)] for x in range(18))
            r = "".join(ramp[min(9, alert[y * 18 + x] * 10 // 256)] for x in range(18))
            print(f"  {l}  {r}")
        return

    OUT.mkdir(exist_ok=True)
    for name, is_alert in (("fleet", False), ("fleet-alert", True)):
        path = OUT / f"{name}.png"
        pixels, w, h = crop(draw(RENDER_PX, is_alert), RENDER_PX)
        write_png(path, w, pixels, h)
        print(f"wrote {path.relative_to(OUT.parent)}  {w}x{h}")
    (OUT / "style.txt").write_text(args.style + "\n")


if __name__ == "__main__":
    main()
