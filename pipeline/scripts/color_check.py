"""Color check for the map: contrast and color-blind distances for every color token.

Reads the data colors from web/src/colors.js and the neutrals from web/src/styles.css, then prints
markdown tables (paste into docs/DECISIONS.md):
  - WCAG contrast of each color against the light basemap land (paper) and the night land;
  - CIEDE2000 distance of the lowest data class to the land and water it sits on (figure-ground);
  - pairwise CAM02-UCS distance between the offense-group colors, for normal vision and under
    deuteranopia, protanopia and tritanopia (Machado et al. 2009, severity 100).
Run:  uv run --with colorspacious scripts/color_check.py      (from pipeline/)
"""
import itertools
import math
import re
from pathlib import Path

import numpy as np
from colorspacious import cspace_convert

ROOT = Path(__file__).resolve().parents[2]
colors_js = (ROOT / "web/src/colors.js").read_text()
styles = (ROOT / "web/src/styles.css").read_text()
basemap = (ROOT / "web/src/basemap.js").read_text()


def hexes(block):
    return re.findall(r"#[0-9a-fA-F]{6}", block)


def js_array(name):
    m = re.search(name + r":\s*\[([^\]]*)\]", colors_js)
    return hexes(m.group(1)) if m else []


ramp_light = js_array("light")
ramp_dark = re.search(r"export const RAMPS = \{(.*?)\};", colors_js, re.S).group(1)
RAMP = {"light": hexes(re.search(r"light:\s*\[(.*?)\]", ramp_dark, re.S).group(1)),
        "dark": hexes(re.search(r"dark:\s*\[(.*?)\]", ramp_dark, re.S).group(1))}
groups_block = re.search(r"export const GROUP_COLORS = \{(.*?)\};", colors_js, re.S).group(1)
GROUPS = dict(re.findall(r"(\w+):\s*'(#[0-9a-fA-F]{6})'", groups_block))
paper = dict(re.findall(r"(light|dark):\s*'(#[0-9a-fA-F]{6})'", re.search(r"PAPER = \{(.*?)\}", basemap).group(1)))
water = dict(re.findall(r"(light|dark):\s*'(#[0-9a-fA-F]{6})'", re.search(r"WATER = \{(.*?)\}", basemap).group(1)))


def token(theme, name):
    sel = r":root, :root\[data-theme='light'\] \{(.*?)\}" if theme == "light" else r":root\[data-theme='dark'\] \{(.*?)\}"
    block = re.search(sel, styles, re.S).group(1)
    m = re.search(r"--" + name + r":\s*(#[0-9a-fA-F]{6})", block)
    return m.group(1) if m else None


def rgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)]) / 255


def lum(h):
    c = rgb(h)
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def contrast(a, b):
    la, lb = sorted([lum(a), lum(b)], reverse=True)
    return (la + 0.05) / (lb + 0.05)


def lab(h):
    return cspace_convert(rgb(h), "sRGB1", "CIELab")


def de2000(h1, h2):
    L1, a1, b1 = lab(h1)
    L2, a2, b2 = lab(h2)
    C1, C2 = math.hypot(a1, b1), math.hypot(a2, b2)
    Cb = (C1 + C2) / 2
    G = 0.5 * (1 - math.sqrt(Cb**7 / (Cb**7 + 25**7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = math.hypot(a1p, b1), math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360
    h2p = math.degrees(math.atan2(b2, a2p)) % 360
    dLp, dCp = L2 - L1, C2p - C1p
    dhp = 0 if C1p * C2p == 0 else (h2p - h1p if abs(h2p - h1p) <= 180 else h2p - h1p - 360 if h2p > h1p else h2p - h1p + 360)
    dHp = 2 * math.sqrt(C1p * C2p) * math.sin(math.radians(dhp / 2))
    Lbp, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    hbp = (h1p + h2p) / 2 if abs(h1p - h2p) <= 180 else (h1p + h2p + 360) / 2 if h1p + h2p < 360 else (h1p + h2p - 360) / 2
    if C1p * C2p == 0:
        hbp = h1p + h2p
    T = 1 - 0.17 * math.cos(math.radians(hbp - 30)) + 0.24 * math.cos(math.radians(2 * hbp)) \
        + 0.32 * math.cos(math.radians(3 * hbp + 6)) - 0.20 * math.cos(math.radians(4 * hbp - 63))
    dtheta = 30 * math.exp(-(((hbp - 275) / 25) ** 2))
    Rc = 2 * math.sqrt(Cbp**7 / (Cbp**7 + 25**7))
    Sl = 1 + (0.015 * (Lbp - 50) ** 2) / math.sqrt(20 + (Lbp - 50) ** 2)
    Sc, Sh = 1 + 0.045 * Cbp, 1 + 0.015 * Cbp * T
    Rt = -math.sin(math.radians(2 * dtheta)) * Rc
    return math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))


def ucs(h, cvd=None):
    c = rgb(h)
    if cvd:
        c = np.clip(cspace_convert(c, {"name": "sRGB1+CVD", "cvd_type": cvd, "severity": 100}, "sRGB1"), 0, 1)
    return cspace_convert(c, "sRGB1", "CAM02-UCS")


print("### Data ramp (hexagons: theme ramp; precincts and boroughs: light ramp in both themes)\n")
print("| Class | Light | vs paper | Dark | vs night |")
print("|---|---|---|---|---|")
for i, (l, d) in enumerate(zip(RAMP["light"], RAMP["dark"])):
    print(f"| {i + 1} | `{l}` | {contrast(l, paper['light']):.1f}:1 | `{d}` | {contrast(d, paper['dark']):.1f}:1 |")
print(f"\nLowest light class vs water ΔE2000 = {de2000(RAMP['light'][0], water['light']):.1f}, vs paper = {de2000(RAMP['light'][0], paper['light']):.1f}; "
      f"lowest dark class vs night land ΔE2000 = {de2000(RAMP['dark'][0], paper['dark']):.1f}, vs night water = {de2000(RAMP['dark'][0], water['dark']):.1f}.\n")

print("### Offense groups (points and the offense list)\n")
print("| Group | Color | vs paper | vs night |")
print("|---|---|---|---|")
for g, h in GROUPS.items():
    print(f"| {g} | `{h}` | {contrast(h, paper['light']):.1f}:1 | {contrast(h, paper['dark']):.1f}:1 |")
print("\n| Pair | normal | deutan | protan | tritan |")
print("|---|---|---|---|---|")
worst = 99
for (ga, a), (gb, b) in itertools.combinations(GROUPS.items(), 2):
    row = []
    for cvd in (None, "deuteranomaly", "protanomaly", "tritanomaly"):
        d = float(np.linalg.norm(ucs(a, cvd) - ucs(b, cvd)))
        worst = min(worst, d)
        row.append(f"{d:.1f}")
    print(f"| {ga} / {gb} | " + " | ".join(row) + " |")
print(f"\nMinimum pairwise CAM02-UCS ΔE (all conditions): {worst:.1f}\n")

print("### Interface tokens\n")
print("| Token | Light | on sheet | Dark | on sheet |")
print("|---|---|---|---|---|")
for name in ("ink", "muted", "rule-strong"):
    l, d = token("light", name), token("dark", name)
    print(f"| --{name} | `{l}` | {contrast(l, token('light', 'sheet')):.1f}:1 | `{d}` | {contrast(d, token('dark', 'sheet')):.1f}:1 |")
hl = re.search(r"--highlighter:\s*(#[0-9a-fA-F]{6})", styles).group(1)
print(f"| --highlighter | `{hl}` | {contrast(hl, paper['light']):.1f}:1 on paper (always drawn with an ink casing: ink vs highlighter {contrast(hl, token('light', 'ink')):.1f}:1) | | |")
