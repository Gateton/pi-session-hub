#!/usr/bin/env python3
"""Render a raw ANSI capture to a real PNG.

A PTY capture is a stream of cursor movements and colour changes. Stripping the
escapes collapses the layout, and ignoring SGR loses the theme. This applies both,
so the image is what the user actually saw on screen.

Pi emits 24-bit colour (`ESC[38;2;R;G;Bm`) and never sets a background, so the
terminal's own background is used here.

Usage:
  python3 test/tools/png.py <capture> <out.png> [--rows N] [--cols N] [--size N]
"""

import argparse
import re
import sys

from PIL import Image, ImageDraw, ImageFont

DEFAULT_FG = (205, 211, 222)
DEFAULT_BG = (17, 19, 25)

# Primary font first, then fallbacks. A real terminal resolves missing glyphs
# through fontconfig, so a renderer that uses one font file would show tofu
# boxes for symbols the terminal actually draws.
FONT_CHAIN = [
    "/usr/share/fonts/TTF/JetBrainsMonoNerdFontMono-Regular.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
    "/usr/share/fonts/Adwaita/AdwaitaMono-Regular.ttf",
    "/usr/share/fonts/noto/NotoSansSymbols2-Regular.ttf",
    "/usr/share/fonts/noto/NotoSansSymbols-Regular.ttf",
]
FONT_CHAIN_BOLD = [
    "/usr/share/fonts/TTF/JetBrainsMonoNerdFontMono-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/Adwaita/AdwaitaMono-Bold.ttf",
    "/usr/share/fonts/noto/NotoSansSymbols2-Regular.ttf",
]

# 256-colour palette, computed the same way xterm does.
def _palette() -> list[tuple[int, int, int]]:
    base = [
        (0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0),
        (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229),
        (127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0),
        (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
    ]
    for i in range(216):
        r, g, b = i // 36, (i % 36) // 6, i % 6
        conv = lambda v: 0 if v == 0 else 55 + v * 40
        base.append((conv(r), conv(g), conv(b)))
    for i in range(24):
        v = 8 + i * 10
        base.append((v, v, v))
    return base


PALETTE = _palette()


class Cell:
    __slots__ = ("ch", "fg", "bg", "bold")

    def __init__(self):
        self.ch = " "
        self.fg = DEFAULT_FG
        self.bg = None
        self.bold = False


def emulate(data: bytes, rows: int, cols: int) -> list[list[Cell]]:
    text = data.decode("utf-8", "replace")
    screen = [[Cell() for _ in range(cols)] for _ in range(rows)]
    row = col = 0
    fg, bg, bold = DEFAULT_FG, None, False
    saved = (0, 0)
    i, n = 0, len(text)

    while i < n:
        ch = text[i]
        if ch == "\x1b":
            m = re.match(r"\x1b\[([0-9;?]*)([a-zA-Z])", text[i:])
            if m:
                params, cmd = m.group(1), m.group(2)
                nums = [int(p) for p in params.split(";") if p.isdigit()]
                if cmd == "H":
                    row = (nums[0] - 1) if len(nums) > 0 and nums[0] else 0
                    col = (nums[1] - 1) if len(nums) > 1 and nums[1] else 0
                elif cmd == "A":
                    row = max(0, row - (nums[0] if nums else 1))
                elif cmd == "B":
                    row = min(rows - 1, row + (nums[0] if nums else 1))
                elif cmd == "C":
                    col = min(cols - 1, col + (nums[0] if nums else 1))
                elif cmd == "D":
                    col = max(0, col - (nums[0] if nums else 1))
                elif cmd == "G":
                    col = max(0, (nums[0] - 1) if nums else 0)
                elif cmd == "d":
                    row = max(0, (nums[0] - 1) if nums else 0)
                elif cmd == "J":
                    mode = nums[0] if nums else 0
                    if mode in (2, 3):
                        screen = [[Cell() for _ in range(cols)] for _ in range(rows)]
                        row = col = 0
                    elif mode == 0:
                        for c in range(col, cols):
                            screen[row][c] = Cell()
                        for r in range(row + 1, rows):
                            screen[r] = [Cell() for _ in range(cols)]
                elif cmd == "K":
                    mode = nums[0] if nums else 0
                    if mode == 0:
                        for c in range(col, cols):
                            screen[row][c] = Cell()
                    elif mode == 2:
                        screen[row] = [Cell() for _ in range(cols)]
                elif cmd == "s":
                    saved = (row, col)
                elif cmd == "u":
                    row, col = saved
                elif cmd == "m":
                    fg, bg, bold = apply_sgr(nums or [0], fg, bg, bold)
                i += m.end()
                continue
            m2 = re.match(r"\x1b[\]P][^\x07\x1b]*(\x07|\x1b\\)", text[i:])
            if m2:
                i += m2.end()
                continue
            m3 = re.match(r"\x1b[()][A-Z0-9]", text[i:])
            if m3:
                i += m3.end()
                continue
            m4 = re.match(r"\x1b[=>78]", text[i:])
            if m4:
                i += m4.end()
                continue
            i += 1
            continue

        if ch == "\r":
            col = 0
        elif ch == "\n":
            row = min(rows - 1, row + 1)
        elif ch == "\b":
            col = max(0, col - 1)
        elif ch == "\t":
            col = min(cols - 1, (col // 8 + 1) * 8)
        elif ch >= " ":
            if 0 <= row < rows and 0 <= col < cols:
                cell = screen[row][col]
                cell.ch, cell.fg, cell.bg, cell.bold = ch, fg, bg, bold
            col += 1
            if col >= cols:
                col = 0
                row = min(rows - 1, row + 1)
        i += 1

    return screen


def apply_sgr(nums, fg, bg, bold):
    idx = 0
    while idx < len(nums):
        v = nums[idx]
        if v == 0:
            fg, bg, bold = DEFAULT_FG, None, False
        elif v == 1:
            bold = True
        elif v == 22:
            bold = False
        elif v == 39:
            fg = DEFAULT_FG
        elif v == 49:
            bg = None
        elif v == 7:
            fg, bg = (bg or DEFAULT_BG), fg
        elif v in (30, 31, 32, 33, 34, 35, 36, 37):
            fg = PALETTE[v - 30]
        elif v in (90, 91, 92, 93, 94, 95, 96, 97):
            fg = PALETTE[v - 90 + 8]
        elif v in (40, 41, 42, 43, 44, 45, 46, 47):
            bg = PALETTE[v - 40]
        elif v == 38 or v == 48:
            if idx + 1 < len(nums) and nums[idx + 1] == 2 and idx + 4 < len(nums):
                rgb = tuple(nums[idx + 2 : idx + 5])
                if v == 38:
                    fg = rgb
                else:
                    bg = rgb
                idx += 4
            elif idx + 1 < len(nums) and nums[idx + 1] == 5 and idx + 2 < len(nums):
                rgb = PALETTE[nums[idx + 2] % 256]
                if v == 38:
                    fg = rgb
                else:
                    bg = rgb
                idx += 2
        idx += 1
    return fg, bg, bold


def coverage(path):
    """Set of codepoints a font can actually draw."""
    from fontTools.ttLib import TTFont

    try:
        f = TTFont(path, fontNumber=0, lazy=True)
        cps = set()
        for t in f["cmap"].tables:
            cps |= set(t.cmap.keys())
        f.close()
        return cps
    except Exception:
        return set()


def build_chain(paths, size):
    """Load a font chain and precompute which codepoints each covers."""
    chain = []
    for path in paths:
        try:
            chain.append((ImageFont.truetype(path, size), coverage(path)))
        except Exception:
            continue
    return chain


def pick(chain, ch, primary):
    """First font in the chain that covers this character, else the primary."""
    cp = ord(ch)
    for font, cps in chain:
        if cp in cps:
            return font
    return chain[0][0] if chain else primary


def to_png(screen, out_path, size, pad, radius):
    regular = build_chain(FONT_CHAIN, size)
    bold = build_chain(FONT_CHAIN_BOLD, size)
    font = regular[0][0]
    cw = font.getlength("M")
    ascent, descent = font.getmetrics()
    lh = ascent + descent

    rows = len(screen)
    cols = len(screen[0]) if rows else 0
    w = int(cols * cw) + pad * 2
    h = int(rows * lh) + pad * 2

    img = Image.new("RGB", (w, h), DEFAULT_BG)
    draw = ImageDraw.Draw(img)

    # Backgrounds first, batched into runs so we do not draw one rect per cell.
    for r, line in enumerate(screen):
        c = 0
        while c < cols:
            bg = line[c].bg
            if bg is None:
                c += 1
                continue
            start = c
            while c < cols and line[c].bg == bg:
                c += 1
            draw.rectangle(
                [pad + start * cw, pad + r * lh, pad + c * cw, pad + (r + 1) * lh],
                fill=bg,
            )

    # Group runs by (colour, bold, resolved font) so a fallback glyph splits the
    # run instead of dragging the rest of the line into the wrong font.
    for r, line in enumerate(screen):
        y = pad + r * lh
        c = 0
        while c < cols:
            cell = line[c]
            if cell.ch == " ":
                c += 1
                continue
            fg = cell.fg
            chain = bold if cell.bold else regular
            f = pick(chain, cell.ch, font)
            start = c
            run = ""
            while (
                c < cols
                and line[c].ch != " "
                and line[c].fg == fg
                and line[c].bold == cell.bold
                and pick(chain, line[c].ch, font) is f
            ):
                run += line[c].ch
                c += 1
            draw.text((pad + start * cw, y), run, font=f, fill=fg)

    img.save(out_path)
    return w, h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("capture")
    ap.add_argument("out")
    ap.add_argument("--rows", type=int, default=40)
    ap.add_argument("--cols", type=int, default=160)
    ap.add_argument("--size", type=int, default=26)
    ap.add_argument("--pad", type=int, default=18)
    ap.add_argument("--radius", type=int, default=10)
    args = ap.parse_args()

    with open(args.capture, "rb") as fh:
        data = fh.read()
    screen = emulate(data, args.rows, args.cols)
    # Drop trailing blank lines so the image is not mostly empty.
    while screen and all(c.ch == " " and c.bg is None for c in screen[-1]):
        screen.pop()
    w, h = to_png(screen, args.out, args.size, args.pad, args.radius)
    print(f"{args.out}: {w}x{h}, {len(screen)} rows")


if __name__ == "__main__":
    sys.exit(main())
