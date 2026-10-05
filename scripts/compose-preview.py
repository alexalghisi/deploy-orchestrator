"""Turns the frames from capture-preview.mjs into docs/preview.gif.

Frames keep their real timing. Every frame is mapped onto one shared
palette, so unchanged pixels stay identical between frames and the GIF
encoder can skip them.

    python3 scripts/compose-preview.py
"""
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
CAPTURE = ROOT / ".capture"
OUT = ROOT / "docs" / "preview.gif"
WIDTH = 960
CAPTION_HEIGHT = 40
BG = (23, 20, 31)
FG = (236, 233, 245)
ACCENT = (139, 92, 246)


def font(size):
    for name in ("DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def compose(frame, caption, typeface):
    shot = Image.open(CAPTURE / frame).convert("RGB")
    height = round(shot.height * WIDTH / shot.width)
    shot = shot.resize((WIDTH, height), Image.LANCZOS)
    canvas = Image.new("RGB", (WIDTH, height + CAPTION_HEIGHT), BG)
    canvas.paste(shot, (0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([0, height, 4, height + CAPTION_HEIGHT], fill=ACCENT)
    draw.text((18, height + CAPTION_HEIGHT // 2), caption, font=typeface, fill=FG, anchor="lm")
    return canvas


def main():
    frames = json.loads((CAPTURE / "frames.json").read_text())
    typeface = font(16)
    images = [compose(f["file"], f["caption"], typeface) for f in frames]

    durations = []
    for current, following in zip(frames, frames[1:]):
        durations.append(max(60, min(600, following["t"] - current["t"])))
    durations.append(2500)

    # one palette for the whole animation, sampled from frames across it
    picks = list(range(0, len(images), max(1, len(images) // 12)))
    sample = Image.new("RGB", (WIDTH, images[0].height * len(picks)))
    for i, index in enumerate(picks):
        sample.paste(images[index], (0, i * images[0].height))
    palette = sample.quantize(colors=256, method=Image.Quantize.FASTOCTREE)
    quantized = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in images]

    OUT.parent.mkdir(exist_ok=True)
    quantized[0].save(
        OUT,
        save_all=True,
        append_images=quantized[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=1,
    )
    total = sum(durations) / 1000
    print(f"{OUT.relative_to(ROOT)}: {len(images)} frames, {total:.1f} s, {OUT.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
