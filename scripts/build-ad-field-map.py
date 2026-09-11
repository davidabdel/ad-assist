#!/usr/bin/env python3
"""Build public/ad-field-map.png — the "which field is which" reference.

Renders labelled boxes over a real Facebook feed ad so an operator holding an
idea card can see, in one glance, where each field lands. The example is a live
Sharkskin Seat Covers ad taken from Meta's public Ad Library; it is a good one
because it fills the description slot, which most ads leave empty and which Ad
Assist does not write.

Drawn with PIL rather than generated, because every character here is a literal
label and an image model spells those wrong. Supersampled 2x and downsampled
with BOX — area-average, so it cannot ring the way LANCZOS does on flat colour.

    python3 scripts/build-ad-field-map.py
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "scripts" / "ad-field-map-source.png"   # 886x788 feed ad
OUT = ROOT / "public" / "ad-field-map.png"

S = 2
FONT_DIR = Path("/System/Library/Fonts/Supplemental")
REGULAR, BOLD = FONT_DIR / "Arial.ttf", FONT_DIR / "Arial Bold.ttf"

BLUE = (47, 107, 255)      # the brand accent: fields the card gives you
AMBER = (194, 120, 3)      # the field it does not
INK = (11, 11, 12)
GREY = (110, 110, 116)

# Boxes in source-image coordinates, with the badge hung outside the corner so
# it never sits on top of the ad's own words.
REGIONS = [
    ((52, 144, 834, 236), "1", BLUE, "tl"),
    ((8, 250, 878, 608), "2", BLUE, "tl"),
    ((28, 624, 205, 648), "3", GREY, "tl"),
    ((28, 648, 664, 702), "4", BLUE, "tl"),
    ((28, 704, 434, 730), "5", AMBER, "tl"),
    ((664, 638, 862, 714), "6", BLUE, "tr"),
]

LEGEND = [
    ("1", BLUE, "Primary text", [
        "The block above the picture. The paragraphs on your card are all ONE field — a blank",
        "line between them is a line break, not a second field. Only what comes before that",
        "break shows before “See more”, so the opening has to work on its own.",
    ]),
    ("2", BLUE, "The picture", [
        "Made from the picture instruction on the card. The small photo beside it is the",
        "seller’s own photograph the edit starts from, not the finished ad.",
    ]),
    ("3", GREY, "Display link", [
        "Meta writes this itself, from the destination URL. Nothing to fill in.",
    ]),
    ("4", BLUE, "Headline", [
        "The bold line on your card. It truncates around 40 characters on a phone, so the",
        "point has to be inside that.",
    ]),
    ("5", AMBER, "Description", [
        "Ad Assist does not write this one. It is optional — Meta only renders it on some",
        "placements — and it is where an offer, shipping or terms would go if you want it.",
    ]),
    ("6", BLUE, "Button", [
        "The “Button …” line on your card. Chosen from Meta’s fixed list, not written, because",
        "a button that is not on the list cannot be selected in Ads Manager.",
    ]),
]

TITLE = "Where each field on an ad idea lands in the real ad"
FOOTER = ("Example: a live Sharkskin Seat Covers ad from Meta’s public Ad Library. "
          "Most ads leave 5 empty.")


def main() -> None:
    ad = Image.open(SOURCE).convert("RGB")
    aw, ah = ad.size
    pad_l, pad_t = 44, 56
    legend_h = 30 + sum(30 + 17 * len(body) for _, _, _, body in LEGEND) + 34
    w, h = pad_l * 2 + aw, pad_t + ah + legend_h

    canvas = Image.new("RGB", (w * S, h * S), "white")
    canvas.paste(ad.resize((aw * S, ah * S), Image.LANCZOS), (pad_l * S, pad_t * S))
    d = ImageDraw.Draw(canvas)

    def font(path, size):
        return ImageFont.truetype(str(path), size * S)

    def centred(text, cx, cy, f, fill):
        b = d.textbbox((0, 0), text, font=f)
        d.text((cx - (b[2] - b[0]) / 2, cy - (b[3] - b[1]) / 2 - b[1]), text, font=f, fill=fill)

    badge_f = font(BOLD, 13)
    for (x0, y0, x1, y1), num, colour, corner in REGIONS:
        box = [(pad_l + x0) * S, (pad_t + y0) * S, (pad_l + x1) * S, (pad_t + y1) * S]
        d.rectangle(box, outline=colour, width=2 * S)
        r = 11 * S
        cx = (box[0] - r) if corner == "tl" else (box[2] + r)
        d.ellipse([cx - r, box[1], cx + r, box[1] + 2 * r], fill=colour)
        centred(num, cx, box[1] + r, badge_f, "white")

    d.text((pad_l * S, 20 * S), TITLE, font=font(BOLD, 19), fill=INK)

    name_f, body_f, num_f = font(BOLD, 15), font(REGULAR, 13), font(BOLD, 13)
    y = pad_t + ah + 26
    for num, colour, name, body in LEGEND:
        r = 11 * S
        cx, cy = (pad_l + 11) * S, y * S + r
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=colour)
        centred(num, cx, cy, num_f, "white")
        d.text(((pad_l + 32) * S, y * S), name, font=name_f, fill=INK)
        d.text(((pad_l + 32) * S, (y + 19) * S), "\n".join(body),
               font=body_f, fill=GREY, spacing=5 * S)
        y += 30 + 17 * len(body)

    d.text((pad_l * S, (y + 6) * S), FOOTER, font=font(REGULAR, 12), fill=(160, 160, 166))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.resize((w, h), Image.BOX).save(OUT, optimize=True)
    print(f"wrote {OUT} ({w}x{h}, {OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
