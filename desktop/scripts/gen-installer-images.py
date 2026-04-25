"""Generate branded installer images for NSIS (Windows) and DMG (macOS)."""
import os
from PIL import Image, ImageDraw, ImageFont

os.makedirs("build/installer", exist_ok=True)

BOLD_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
REGULAR_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

def _font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


# ── NSIS Installer Sidebar  164 × 314 ────────────────────────────────────────
W, H = 164, 314
img = Image.new("RGB", (W, H), "#1c1917")
draw = ImageDraw.Draw(img)

draw.rectangle([0, 0, W, 6], fill="#f59e0b")

lx, ly = (W - 48) // 2, 32
draw.rectangle([lx, ly, lx + 48, ly + 48], fill="#fbbf24")
draw.rectangle([lx, ly, lx + 48, ly + 48], outline="#92400e", width=2)
draw.text((lx + 10, ly + 10), "Wt", fill="#b91c1c", font=_font(BOLD_FONT, 24))

draw.text((W // 2, ly + 66), "WatchTower", fill="#fef3c7",
          font=_font(BOLD_FONT, 14), anchor="mm")
draw.text((W // 2, ly + 84), "Deployment Platform", fill="#a8a29e",
          font=_font(REGULAR_FONT, 9), anchor="mm")
draw.rectangle([16, ly + 96, W - 16, ly + 97], fill="#44403c")

tag_font = _font(REGULAR_FONT, 8)
for i, line in enumerate(["Monitor & deploy", "your projects", "from anywhere."]):
    draw.text((W // 2, ly + 112 + i * 14), line, fill="#d6d3d1",
              font=tag_font, anchor="mm")

draw.rectangle([0, H - 4, W, H], fill="#f59e0b")
img.save("build/installer/nsis-sidebar.png")
print("  ✓  build/installer/nsis-sidebar.png")


# ── DMG Background  600 × 400 ────────────────────────────────────────────────
W2, H2 = 600, 400
img2 = Image.new("RGB", (W2, H2), "#fef9f0")
draw2 = ImageDraw.Draw(img2)

for x in range(0, W2, 24):
    draw2.line([x, 0, x, H2], fill="#fde68a", width=1)
for y in range(0, H2, 24):
    draw2.line([0, y, W2, y], fill="#fde68a", width=1)

pad = 24
draw2.rectangle([pad, pad, W2 - pad, H2 - pad], fill="white", outline="#e7e5e4", width=2)
draw2.rectangle([pad, pad, W2 - pad, pad + 8], fill="#f59e0b")

lx2, ly2 = 120, 140
draw2.rectangle([lx2, ly2, lx2 + 72, ly2 + 72], fill="#fbbf24", outline="#92400e", width=3)
draw2.text((lx2 + 36, ly2 + 36), "Wt", fill="#b91c1c",
           font=_font(BOLD_FONT, 36), anchor="mm")

draw2.text((320, 174), "→", fill="#a8a29e", font=_font(REGULAR_FONT, 36))

ax, ay = 380, 140
draw2.rectangle([ax, ay, ax + 72, ay + 72], fill="#e0e7ff", outline="#6366f1", width=2)
draw2.text((ax + 36, ay + 36), "Apps", fill="#4338ca",
           font=_font(REGULAR_FONT, 9), anchor="mm")

fn = _font(BOLD_FONT, 13)
fs = _font(REGULAR_FONT, 10)
draw2.text((lx2 + 36, ly2 + 82), "WatchTower", fill="#1c1917", font=fn, anchor="mt")
draw2.text((ax + 36, ay + 82), "Applications", fill="#1c1917", font=fs, anchor="mt")
draw2.text((W2 // 2, H2 - 50),
           "Drag WatchTower to Applications to install",
           fill="#78716c", font=fs, anchor="mm")

draw2.rectangle([0, H2 - 6, W2, H2], fill="#f59e0b")
img2.save("build/installer/dmg-background.png")
print("  ✓  build/installer/dmg-background.png")
