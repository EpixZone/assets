#!/usr/bin/env python3
"""Generate the NSIS installer bitmaps for the EpixNet Windows installer.

Produces two 24-bit BMPs (the formats NSIS/MUI2 expects):
  welcome.bmp  164x314  welcome/finish page sidebar (mark + wordmark on black)
  header.bmp   150x57   page header image (mark on white)

Sources: images/icons/generated/linux/epix-512.png (diamond mark) and
images/backgrounds/epix-bg.png (EPIX wordmark, on black). Rendered at 4x and
downsampled for clean edges.

Usage: python scripts/generate-installer-bmps.py [--out DIR]
  DIR defaults to ../EpixNet/packaging/windows next to this repo.
"""

import argparse
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[1]
SS = 4  # supersample factor


def extract_mark() -> Image.Image:
    """Isolate the colored diamond from epix-512.png (drops the black disc)."""
    src = Image.open(REPO / "images/icons/generated/linux/epix-512.png").convert("RGBA")
    px = src.load()
    out = Image.new("RGBA", src.size, (0, 0, 0, 0))
    op = out.load()
    for y in range(src.height):
        for x in range(src.width):
            r, g, b, a = px[x, y]
            bright = max(r, g, b)
            # keep only the colored diamond; fade the black/color boundary
            k = min(max((bright - 30) / 60.0, 0.0), 1.0)
            if k > 0 and a > 0:
                op[x, y] = (r, g, b, int(a * k))
    return out.crop(out.getbbox())


def extract_wordmark() -> Image.Image:
    """Crop the EPIX wordmark (on black) from the center of epix-bg.png."""
    bg = Image.open(REPO / "images/backgrounds/epix-bg.png").convert("RGB")
    region = bg.crop((400, 555, 1130, 700))
    px = region.load()
    xs, ys = [], []
    for y in range(region.height):
        for x in range(region.width):
            if max(px[x, y]) > 30:
                xs.append(x)
                ys.append(y)
    return region.crop((min(xs), min(ys), max(xs) + 1, max(ys) + 1))


def fit(img: Image.Image, width: int) -> Image.Image:
    h = round(img.height * width / img.width)
    return img.resize((width, h), Image.LANCZOS)


def welcome_bmp(mark: Image.Image, wordmark: Image.Image, out: Path) -> None:
    w, h = 164 * SS, 314 * SS
    canvas = Image.new("RGB", (w, h), (0, 0, 0))
    m = fit(mark, 100 * SS)
    canvas.paste(m, ((w - m.width) // 2, 72 * SS - m.height // 2), m)
    wm = fit(wordmark.convert("RGB"), 106 * SS)
    canvas.paste(wm, ((w - wm.width) // 2, 152 * SS))
    canvas.resize((164, 314), Image.LANCZOS).save(out / "welcome.bmp")


def header_bmp(mark: Image.Image, out: Path) -> None:
    w, h = 150 * SS, 57 * SS
    canvas = Image.new("RGB", (w, h), (255, 255, 255))
    m = fit(mark, 42 * SS)
    canvas.paste(m, ((w - m.width) // 2, (h - m.height) // 2), m)
    canvas.resize((150, 57), Image.LANCZOS).save(out / "header.bmp")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path,
                    default=REPO.parent / "EpixNet" / "packaging" / "windows")
    args = ap.parse_args()
    mark = extract_mark()
    wordmark = extract_wordmark()
    welcome_bmp(mark, wordmark, args.out)
    header_bmp(mark, args.out)
    print(f"wrote {args.out / 'welcome.bmp'} and {args.out / 'header.bmp'}")


if __name__ == "__main__":
    main()
