"""Pointy-top axial hexagon grid in local meters (side S = 180 m), shared by the pipeline and the map.

Projection: local equirectangular around an origin near the city center
    x = (lon - LON0) * KX        KX = 111320 * cos(LAT0)   meters per degree of longitude
    y = (lat - LAT0) * KY        KY = 110950               meters per degree of latitude
Point -> hex (pointy-top axial, then cube rounding):
    q = (sqrt(3)/3 * x - 1/3 * y) / S
    r = (2/3 * y) / S
Hex -> center:
    cx = S * sqrt(3) * (q + r/2)     cy = S * 1.5 * r
    lon = LON0 + cx / KX             lat = LAT0 + cy / KY

The same constants are written to data/web/meta.json ("grid"), and the web map reads them from
there, so the browser can never use a different grid than the one the data was binned with.
"""
from __future__ import annotations

import math

import numpy as np

LON0 = -73.95
LAT0 = 40.73
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110950.0
SIDE = 180.0
SQRT3 = math.sqrt(3)

GRID = {"lon0": LON0, "lat0": LAT0, "kx": KX, "ky": KY, "side": SIDE, "orientation": "pointy"}


def cube_round(qf: np.ndarray, rf: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Round fractional axial coordinates to the containing hexagon (via cube coordinates)."""
    sf = -qf - rf
    q, r, s = np.rint(qf), np.rint(rf), np.rint(sf)
    dq, dr, ds = np.abs(q - qf), np.abs(r - rf), np.abs(s - sf)
    fix_q = (dq > dr) & (dq > ds)
    fix_r = ~fix_q & (dr > ds)
    q = np.where(fix_q, -r - s, q)
    r = np.where(fix_r, -q - s, r)
    return q.astype(np.int32), r.astype(np.int32)


def latlon_to_axial(lat, lon) -> tuple[np.ndarray, np.ndarray]:
    x = (np.asarray(lon, dtype=np.float64) - LON0) * KX
    y = (np.asarray(lat, dtype=np.float64) - LAT0) * KY
    qf = (SQRT3 / 3 * x - 1 / 3 * y) / SIDE
    rf = (2 / 3 * y) / SIDE
    return cube_round(qf, rf)


def axial_to_latlon(q, r) -> tuple[np.ndarray, np.ndarray]:
    q = np.asarray(q, dtype=np.float64)
    r = np.asarray(r, dtype=np.float64)
    cx = SIDE * SQRT3 * (q + r / 2)
    cy = SIDE * 1.5 * r
    return LAT0 + cy / KY, LON0 + cx / KX
