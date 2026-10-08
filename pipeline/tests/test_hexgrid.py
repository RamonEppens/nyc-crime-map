"""Tests for the axial hexagon grid: rounding must pick the nearest hexagon center."""
import importlib.util
import math
from pathlib import Path

import numpy as np

spec = importlib.util.spec_from_file_location("hexgrid", Path(__file__).resolve().parents[1] / "scripts" / "hexgrid.py")
hg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hg)


def to_m(lat, lon):
    return (np.asarray(lon) - hg.LON0) * hg.KX, (np.asarray(lat) - hg.LAT0) * hg.KY


def test_center_roundtrip():
    q = np.arange(-40, 41)
    r = np.arange(40, -41, -1)
    lat, lon = hg.axial_to_latlon(q, r)
    q2, r2 = hg.latlon_to_axial(lat, lon)
    assert (q2 == q).all() and (r2 == r).all()


def test_neighbors_are_sqrt3_side_apart():
    lat, lon = hg.axial_to_latlon([0, 1, 0, -1, 0, 1], [0, 0, 1, 1, -1, -1])
    x, y = to_m(lat, lon)
    d = np.hypot(x[1:] - x[0], y[1:] - y[0])
    assert np.allclose(d, hg.SIDE * math.sqrt(3))


def test_rounding_picks_nearest_center():
    rng = np.random.default_rng(1)
    lat = 40.73 + rng.uniform(-0.2, 0.2, 20000)
    lon = -73.95 + rng.uniform(-0.25, 0.25, 20000)
    q, r = hg.latlon_to_axial(lat, lon)
    x, y = to_m(lat, lon)
    best = None
    for dq, dr in [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1), (1, -1), (-1, 1)]:
        clat, clon = hg.axial_to_latlon(q + dq, r + dr)
        cx, cy = to_m(clat, clon)
        d = np.hypot(x - cx, y - cy)
        best = d if best is None else np.minimum(best, d)
        if dq == dr == 0:
            own = d
    assert np.allclose(own, best)                   # assigned center is the closest one
    assert own.max() <= hg.SIDE + 1e-6              # never farther than the circumradius
