#!/usr/bin/env python3
"""Regenerate PWA icons (needs Pillow). Usage: python tools/make_icons.py"""
import os
from PIL import Image, ImageDraw, ImageFont
OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
BG, FG, ACC = (15, 20, 25), (232, 238, 244), (47, 129, 247)
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

def draw(size, safe):
    img = Image.new('RGB', (size, size), BG)
    d = ImageDraw.Draw(img)
    pad = size * (0.22 if safe else 0.10)
    # blue rounded plate
    d.rounded_rectangle([pad, size * 0.30, size - pad, size * 0.70], radius=size * 0.08, fill=ACC)
    f = ImageFont.truetype(FONT, int(size * (0.20 if safe else 0.25)))
    t = 'VIN'
    w = d.textlength(t, font=f)
    d.text(((size - w) / 2, size * 0.5), t, font=f, fill=(255, 255, 255), anchor='lm')
    # dots = "last digits"
    r = size * 0.025
    for i in range(4):
        cx = size * (0.5 + (i - 1.5) * 0.09)
        d.ellipse([cx - r, size * 0.80 - r, cx + r, size * 0.80 + r], fill=FG)
    return img

os.makedirs(OUT, exist_ok=True)
draw(192, False).save(os.path.join(OUT, 'icon-192.png'))
draw(512, False).save(os.path.join(OUT, 'icon-512.png'))
draw(512, True).save(os.path.join(OUT, 'maskable-512.png'))
draw(180, False).save(os.path.join(OUT, 'apple-touch-icon.png'))
print('icons written')
