#!/usr/bin/env python3
"""Draws Cartouche's logo: a sheet of papyrus with a cartouche on it, the oval that holds a name
in hieroglyphs, here a black island with a cover and a few bars inside, tied off at one end.
Writes brand/logo.svg (+ PNGs), the app icon in extension/assets/icons/, and the website's
icons and social card. Needs rsvg-convert for the PNGs.
"""
import pathlib
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
INK = "#121212"
PAPYRUS = "#F1E6CC"
EDGE = "#D9C9A3"
GOLD = "#D99A2B"
LAPIS = "#2B59C3"
CORAL = "#F0644A"


def cartouche(x, y, w, h, stroke=7):
    """The island: a pill with a tie at its right end; a cover and four bars inside."""
    r = h / 2
    art = h * 0.56
    ax, ay = x + r * 0.55, y + (h - art) / 2
    bars = []
    bw = h * 0.085
    gap = h * 0.07
    bx = x + w - r * 0.62 - 4 * bw - 3 * gap
    for i, k in enumerate([0.36, 0.62, 0.86, 0.5]):
        bh = h * 0.5 * k
        bars.append(f'<rect x="{bx + i * (bw + gap):.1f}" y="{y + h / 2 - bh / 2:.1f}" width="{bw:.1f}" '
                    f'height="{bh:.1f}" rx="{bw / 2:.1f}" fill="{GOLD}"/>')
    tie_x = x + w + stroke * 1.6
    return f"""
  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{INK}"/>
  <line x1="{tie_x:.1f}" y1="{y + 4}" x2="{tie_x:.1f}" y2="{y + h - 4}" stroke="{INK}" stroke-width="{stroke}" stroke-linecap="round"/>
  <rect x="{ax:.1f}" y="{ay:.1f}" width="{art:.1f}" height="{art:.1f}" rx="{art * 0.22:.1f}" fill="{LAPIS}"/>
  <circle cx="{ax + art * 0.68:.1f}" cy="{ay + art * 0.32:.1f}" r="{art * 0.13:.1f}" fill="{GOLD}"/>
  <path d="M{ax:.1f} {ay + art * 0.86:.1f} L{ax + art * 0.38:.1f} {ay + art * 0.5:.1f} L{ax + art:.1f} {ay + art * 0.92:.1f} L{ax + art:.1f} {ay + art - art * 0.22:.1f} Q{ax + art:.1f} {ay + art:.1f} {ax + art - art * 0.22:.1f} {ay + art:.1f} L{ax + art * 0.22:.1f} {ay + art:.1f} Q{ax:.1f} {ay + art:.1f} {ax:.1f} {ay + art - art * 0.22:.1f} Z" fill="#7FA0EE"/>
  {"".join(bars)}"""


def logo():
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect x="8" y="8" width="240" height="240" rx="56" fill="{PAPYRUS}"/>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="none" stroke="{EDGE}" stroke-width="3"/>
  <!-- fibres of the papyrus -->
  <g stroke="{EDGE}" stroke-width="2" stroke-linecap="round" opacity=".8">
    <line x1="40" y1="56" x2="216" y2="56"/><line x1="40" y1="200" x2="216" y2="200"/>
    <line x1="56" y1="40" x2="56" y2="70"/><line x1="200" y1="186" x2="200" y2="216"/>
  </g>
  {cartouche(30, 96, 178, 64)}
</svg>
"""


def social():
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="{PAPYRUS}"/>
  <text x="600" y="250" text-anchor="middle" font-family="Georgia, serif" font-size="120" font-weight="700" fill="{INK}">Cartouche</text>
  <text x="600" y="330" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="40" fill="#5b5446">A Dynamic Island for GNOME</text>
  <g transform="translate(400 380) scale(1.6)">{cartouche(30, 20, 178, 60)}</g>
</svg>
"""


def main():
    brand = ROOT / "brand"
    brand.mkdir(exist_ok=True)
    (brand / "logo.svg").write_text(logo())
    (brand / "og.svg").write_text(social())
    icons = ROOT / "extension" / "assets" / "icons"
    icons.mkdir(parents=True, exist_ok=True)
    shutil.copy(brand / "logo.svg", icons / "cartouche.svg")
    docs = ROOT / "docs" / "assets"
    docs.mkdir(parents=True, exist_ok=True)
    shutil.copy(brand / "logo.svg", docs / "logo.svg")
    if shutil.which("rsvg-convert"):
        for size in (256, 512):
            subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), str(brand / "logo.svg"),
                            "-o", str(brand / f"logo-{size}.png")], check=True)
        subprocess.run(["rsvg-convert", "-w", "64", "-h", "64", str(brand / "logo.svg"), "-o", str(docs / "favicon.png")], check=True)
        subprocess.run(["rsvg-convert", "-w", "180", "-h", "180", str(brand / "logo.svg"), "-o", str(docs / "apple-touch-icon.png")], check=True)
        subprocess.run(["rsvg-convert", "-w", "1200", "-h", "630", str(brand / "og.svg"), "-o", str(docs / "og.png")], check=True)
    else:
        print("rsvg-convert not found: wrote the SVGs only")


if __name__ == "__main__":
    main()
