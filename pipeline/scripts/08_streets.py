"""Streets, corners, complaints per street, precinct population and the comparison tables.

Inputs (offline):  data/reference/centerline.geojsonl, census_blocks2020.geojson, block_population.csv,
                   precincts.geojson (from 04/08_download_streets) and data/web/points.parquet,
                   nta.geojson, boroughs.geojson, precincts.geojson, meta.json (from 07_web_data).
Outputs (data/web/):
  streets.json            one entry per street (name + borough): display name, key, aliases,
                          borough, neighborhoods, length. Loaded by the search box on focus.
  street_segments.parquet segments with left/right house-number ranges and geometry, by street.
  street_corners.parquet  where two streets meet at the same level (overpasses are not corners).
  street_blocks.parquet   complaints per street x hundred-block x month x offense type.
  compare.json            what the details panel compares against: 200 m areas on a 100 m grid
                          (percentiles per type and year), streets (rate per 100 m), precinct
                          population (2020 Census blocks).
  precincts.geojson       + population per precinct (and the merged 105/113/116 area).

How complaints are assigned to streets (decisions #46-48):
  NYPD already places each complaint on the centerline, at mid-block or at an intersection.
  - At an intersection (within 3 m of a node where streets meet at the same level) the complaint
    counts for EVERY street that meets there; the citywide street average uses the same rule.
  - Otherwise it counts for the nearest street within 30 m. Ramps, paths, driveways and other
    non-street segments take part in "nearest" but count for no street (a complaint in a park
    path is not given to the avenue next to it).
  - Its house number is interpolated along that street's nearest segment (left and right ranges
    averaged); block = number // 100 * 100 (Queens hyphenated 37-12: block 37-00).

Usage (from pipeline/):  uv run scripts/08_streets.py [--root ..]
"""
from __future__ import annotations

import argparse
import csv
import json
import re
from collections import defaultdict
from pathlib import Path

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import shapely
from scipy.sparse import coo_matrix
from scipy.spatial import cKDTree
from shapely.geometry import LineString, MultiLineString, shape
from shapely.ops import linemerge, unary_union

from streetnames import ABBREV, DIRECTIONS, clave

ROOT = Path(__file__).resolve().parents[2]
CONFIG = Path(__file__).resolve().parents[2] / "config"

SEARCHABLE_RW = {1, 2, 3, 4, 5, 7, 10}        # street, highway, bridge, tunnel, boardwalk, step street, alley
FERRY_RW = 14                                  # ferry routes: not ground at all
NOT_A_STREET = re.compile(r"PEDESTRIAN|\bOPAS\b|\bOVPS\b|\bPED\b|\b(EN|ET|EX)\b|\bEXIT\b|ENTRANCE|ENTRY|\bRAMP\b|\bRP\b")
SNAP_M = 30.0              # a complaint further than this from any segment counts for no street
CORNER_M = 3.0             # a complaint this close to an intersection counts for every street there
GROUND_LEVEL_TOL = 0.75    # node matching tolerance in meters (endpoints of meeting segments coincide)
GRID_STEP_M = 100.0        # comparison grid for addresses / corners
RADIUS_M = 200.0
SHORT_STREET_M = 300.0     # streets shorter than this are left out of the street percentile
HYPHEN_BASE = 1_000_000    # Queens 37-12 -> 1_037_012 (never collides with a plain number)
YEARS = list(range(2016, 2026))


# ---------------------------------------------------------------- names
STREET_TYPES = {"STREET", "AVENUE", "PLACE", "ROAD", "DRIVE", "LANE", "TERRACE", "COURT", "BOULEVARD",
                "PARKWAY", "WALK", "LOOP", "PATH", "WAY", "ALLEY", "PLAZA", "CRESCENT", "SQUARE"}
SMALL = {"OF", "THE", "AND", "DE", "LA"}
ACRONYMS = {"FDR", "LGA", "JFK", "BQE", "US", "NY", "NYC", "MLK", "CUNY", "LIE", "PS", "IS", "JHS", "HS", "LIRR", "NYCHA"}


def ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def display_name(raw: str) -> str:
    """'W  42 ST' -> 'West 42nd Street', 'AVE OF THE AMERICAS' -> 'Avenue of the Americas',
    'ST MARKS PL' -> 'St Marks Place', 'AVE S' -> 'Avenue S'."""
    words = raw.split()
    last = len(words) - 1
    out = []
    for i, w in enumerate(words):
        if w == "ST":
            out.append("Street" if i == last and i > 0 else "St")
            continue
        if w == "DR":
            out.append("Dr" if i == 0 and last > 0 else "Drive")
            continue
        if w in DIRECTIONS and ((i == 0 and last > 0) or (i == last and i >= 2)):
            out.append(DIRECTIONS[w].title())
            continue
        if w in ACRONYMS:
            out.append(w)
            continue
        if w == "JR":
            out.append("Jr")
            continue
        w = ABBREV.get(w, w)
        if w.isdigit():
            out.append(ordinal(int(w)))
        elif w in SMALL and i > 0:
            out.append(w.lower())
        elif len(w) <= 1 or re.fullmatch(r"[A-Z]?\d+[A-Z]?", w):
            out.append(w)                       # 'Avenue S', 'Route 9A'
        elif w.startswith("MC") and len(w) > 2:
            out.append("Mc" + w[2:].title())
        else:
            out.append(w.title().replace("'S", "'s"))
    return " ".join(out)


def parse_hn(s: str | None) -> int:
    """'1234' -> 1234; '37-012' -> 1_037_012; empty / '0' -> -1."""
    if not s:
        return -1
    s = s.strip()
    m = re.fullmatch(r"(\d+)-(\d+)", s)
    if m:
        return HYPHEN_BASE + int(m.group(1)) * 1000 + int(m.group(2))
    m = re.fullmatch(r"(\d+)\D*", s)
    if not m or int(m.group(1)) == 0:
        return -1
    return int(m.group(1))


def block_of(hn: int) -> int:
    if hn < 0:
        return -1
    if hn >= HYPHEN_BASE:
        return (hn // 1000) * 1000
    return (hn // 100) * 100


# ---------------------------------------------------------------- geometry helpers
class Local:
    """Local meters, same constants as the hexagon grid (pipeline/scripts/hexgrid.py, meta.json)."""
    def __init__(self, grid: dict):
        self.lon0, self.lat0, self.kx, self.ky = grid["lon0"], grid["lat0"], grid["kx"], grid["ky"]

    def xy(self, lon, lat):
        return (np.asarray(lon) - self.lon0) * self.kx, (np.asarray(lat) - self.lat0) * self.ky

    def lonlat(self, x, y):
        return np.asarray(x) / self.kx + self.lon0, np.asarray(y) / self.ky + self.lat0

    def line(self, coords):
        c = np.asarray(coords, dtype=float)
        x, y = self.xy(c[:, 0], c[:, 1])
        return LineString(np.column_stack([x, y]))


def single_line(geom: dict) -> list[list[list[float]]]:
    """Coordinates of a (Multi)LineString as one or more merged parts."""
    g = shape(geom)
    if isinstance(g, MultiLineString):
        g = linemerge(g)
    parts = list(g.geoms) if hasattr(g, "geoms") else [g]
    return [list(p.coords) for p in parts if len(p.coords) >= 2]


# ---------------------------------------------------------------- main steps
def load_segments(ref: Path, loc: Local):
    """Returns segments (dicts) and the street table. A street = borough + official name."""
    aliases_manual = defaultdict(list)
    for r in csv.DictReader(open(CONFIG / "street_aliases.csv", encoding="utf-8")):
        aliases_manual[(int(r["borocode"]), r["official_name"])].append(r["alias"])
    segs = []
    street_index: dict[tuple[int, str], int] = {}
    streets: list[dict] = []
    code_names: dict[str, set] = defaultdict(set)
    with open(ref / "centerline.geojsonl", encoding="utf-8") as f:
        for line in f:
            feat = json.loads(line)
            p = feat["properties"]
            rw = int(p.get("rw_type") or 0)
            if rw == FERRY_RW or not feat.get("geometry"):
                continue
            raw = " ".join((p.get("full_street_name") or "").split())
            boro = int(p.get("boroughcode") or 0)
            searchable = rw in SEARCHABLE_RW and raw and not NOT_A_STREET.search(raw) and boro in range(1, 6)
            sid = -1
            if searchable:
                key = (boro, raw)
                if key not in street_index:
                    street_index[key] = len(streets)
                    streets.append({"raw": raw, "boro": boro, "length": 0.0, "nta_len": defaultdict(float)})
                sid = street_index[key]
                code_names[p.get("b5sc") or ""].add(key)
            for coords in single_line(feat["geometry"]):
                segs.append({
                    "street": sid, "coords": coords, "geom": loc.line(coords),
                    "lf": parse_hn(p.get("l_low_hn")), "lt": parse_hn(p.get("l_high_hn")),
                    "rf": parse_hn(p.get("r_low_hn")), "rt": parse_hn(p.get("r_high_hn")),
                    "from_level": int(p.get("from_level_code") or 13), "to_level": int(p.get("to_level_code") or 13),
                })
    # Aliases: other searchable names sharing the same street code in the same borough, plus the
    # manual list (6th Avenue, FDR Drive, BQE...).
    for st in streets:
        st["aliases"] = set(aliases_manual.get((st["boro"], st["raw"]), []))
    for keys in code_names.values():
        if len(keys) < 2 or len(keys) > 4:     # big groups are unrelated names under one code
            continue
        for k in keys:
            for other in keys:
                if other != k and other[0] == k[0]:
                    streets[street_index[k]]["aliases"].add(other[1])
    return segs, streets


def corners_and_nodes(segs, loc: Local):
    """Nodes where two or more different streets meet at the same level."""
    node_streets: dict[tuple, set] = defaultdict(set)
    q = lambda v: int(round(v / GROUND_LEVEL_TOL))
    for s in segs:
        if s["street"] < 0:
            continue
        x0, y0 = s["geom"].coords[0]
        x1, y1 = s["geom"].coords[-1]
        node_streets[(q(x0), q(y0), s["from_level"])].add(s["street"])
        node_streets[(q(x1), q(y1), s["to_level"])].add(s["street"])
    nodes = [(k, v) for k, v in node_streets.items() if len(v) >= 2]
    xy = np.array([[k[0] * GROUND_LEVEL_TOL, k[1] * GROUND_LEVEL_TOL] for k, _ in nodes])
    return nodes, xy


def assign(segs, nodes, node_xy, px, py):
    """For every complaint location: list of (street, segment index)."""
    geoms = np.array([s["geom"] for s in segs], dtype=object)
    tree = shapely.STRtree(geoms)
    pts = shapely.points(px, py)
    ip, ig = tree.query(pts, predicate="dwithin", distance=SNAP_M)
    d = shapely.distance(pts[ip], geoms[ig])
    order = np.lexsort((d, ip))
    ip, ig, d = ip[order], ig[order], d[order]
    street_of = np.array([s["street"] for s in segs])

    # nearest segment per location, and nearest segment per (location, street)
    nearest = {}
    per_street: dict[tuple[int, int], int] = {}
    for a, g in zip(ip.tolist(), ig.tolist()):
        if a not in nearest:
            nearest[a] = g
        st = street_of[g]
        if st >= 0 and (a, st) not in per_street:
            per_street[(a, st)] = g

    ntree = cKDTree(node_xy)
    near_node = ntree.query_ball_point(np.column_stack([px, py]), r=CORNER_M)
    out: list[list[tuple[int, int]]] = [[] for _ in range(len(px))]
    corner_locs = 0
    for a in range(len(px)):
        streets_here: set = set()
        for ni in near_node[a]:
            streets_here |= nodes[ni][1]
        if len(streets_here) >= 2:
            corner_locs += 1
            for st in sorted(streets_here):
                g = per_street.get((a, st))
                if g is not None:
                    out[a].append((st, g))
        elif a in nearest and street_of[nearest[a]] >= 0:
            g = nearest[a]
            out[a].append((int(street_of[g]), g))
    return out, corner_locs, pts


def house_number(seg, pt) -> int:
    t = float(shapely.line_locate_point(seg["geom"], pt, normalized=True))
    vals = []
    for lo, hi in ((seg["lf"], seg["lt"]), (seg["rf"], seg["rt"])):
        if lo > 0 and hi > 0 and (lo >= HYPHEN_BASE) == (hi >= HYPHEN_BASE):
            vals.append(lo + t * (hi - lo))
    return int(round(sum(vals) / len(vals))) if vals else -1


def percentiles(values: np.ndarray) -> list:
    return [round(float(v), 3) for v in np.percentile(values, np.arange(101))]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=ROOT)
    args = ap.parse_args()
    ref, web = args.root / "data" / "reference", args.root / "data" / "web"
    meta = json.loads((web / "meta.json").read_text(encoding="utf-8"))
    loc = Local(meta["grid"])

    print("Segments")
    segs, streets = load_segments(ref, loc)
    print(f"  {len(segs):,} segments, {len(streets):,} searchable streets")

    # Lengths and neighborhoods per street (by segment midpoint)
    nta = json.loads((web / "nta.geojson").read_text(encoding="utf-8"))["features"]
    nta_geoms = np.array([shape(f["geometry"]) for f in nta], dtype=object)
    nta_codes = [f["properties"]["code"] for f in nta]
    nta_tree = shapely.STRtree(nta_geoms)
    mids = [(i, s) for i, s in enumerate(segs) if s["street"] >= 0]
    mid_ll = [LineString(s["coords"]).interpolate(0.5, normalized=True) for _, s in mids]
    hit_seg, hit_nta = nta_tree.query(np.array(mid_ll, dtype=object), predicate="within")
    seg_nta = dict(zip(hit_seg.tolist(), hit_nta.tolist()))
    for k, (_, s) in enumerate(mids):
        st = streets[s["street"]]
        st["length"] += s["geom"].length
        if k in seg_nta:
            st["nta_len"][nta_codes[seg_nta[k]]] += s["geom"].length

    print("Corners")
    nodes, node_xy = corners_and_nodes(segs, loc)
    print(f"  {len(nodes):,} intersections")

    print("Assigning complaint locations to streets")
    con = duckdb.connect()
    locs = con.execute(f"SELECT lat, lon, sum(n)::BIGINT AS n FROM read_parquet('{(web / 'points.parquet').as_posix()}') "
                       "GROUP BY 1, 2 ORDER BY 1, 2").fetchnumpy()
    px, py = loc.xy(locs["lon"].astype(float), locs["lat"].astype(float))
    pairs, corner_locs, pts = assign(segs, nodes, node_xy, px, py)
    rows_ls = {"lat": [], "lon": [], "street": [], "hn": [], "block": []}
    for a, lst in enumerate(pairs):
        for st, g in lst:
            hn = house_number(segs[g], pts[a])
            rows_ls["lat"].append(locs["lat"][a]); rows_ls["lon"].append(locs["lon"][a])
            rows_ls["street"].append(st); rows_ls["hn"].append(hn); rows_ls["block"].append(block_of(hn))
    n_total = int(locs["n"].sum())
    with_street = int(sum(locs["n"][a] for a, lst in enumerate(pairs) if lst))
    at_corner = int(sum(locs["n"][a] for a, lst in enumerate(pairs) if len(lst) >= 2))
    with_hn = int(sum(locs["n"][a] for a, lst in enumerate(pairs) if lst and any(
        house_number(segs[g], pts[a]) > 0 for _, g in lst[:1])))
    print(f"  complaints on the map: {n_total:,}; with a street {with_street / n_total:.1%}; "
          f"at an intersection {at_corner / n_total:.1%}; with a house number {with_hn / n_total:.1%}")

    con.register("ls", pa.table({"lat": pa.array(rows_ls["lat"], pa.float32()), "lon": pa.array(rows_ls["lon"], pa.float32()),
                                 "street": pa.array(rows_ls["street"], pa.int32()), "block": pa.array(rows_ls["block"], pa.int32())}))
    con.execute(f"""COPY (
        SELECT ls.street, ls.block, p.m, p.cat, sum(p.n)::INTEGER AS n
        FROM read_parquet('{(web / 'points.parquet').as_posix()}') p JOIN ls USING (lat, lon)
        GROUP BY ALL ORDER BY street, block, m, cat)
        TO '{(web / 'street_blocks.parquet').as_posix()}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 16384)""")

    # Per street per (type, year) totals for the street comparison
    st_tot = con.execute(f"""
        SELECT ls.street, p.m // 12 + 2016 AS year, p.cat, sum(p.n)::BIGINT AS n
        FROM read_parquet('{(web / 'points.parquet').as_posix()}') p JOIN ls USING (lat, lon)
        GROUP BY ALL""").fetchnumpy()
    city_mc = con.execute(f"""
        SELECT p.m, p.cat, sum(p.n)::BIGINT AS n
        FROM read_parquet('{(web / 'points.parquet').as_posix()}') p JOIN ls USING (lat, lon)
        GROUP BY ALL ORDER BY 1, 2""").fetchall()

    print("Writing street files")
    seg_rows = [s for s in segs if s["street"] >= 0]
    seg_rows.sort(key=lambda s: s["street"])
    to_int = lambda c: [int(round(v * 1e5)) for xy in c for v in xy]
    pq.write_table(pa.table({
        "street": pa.array([s["street"] for s in seg_rows], pa.int32()),
        "lf": pa.array([s["lf"] for s in seg_rows], pa.int32()), "lt": pa.array([s["lt"] for s in seg_rows], pa.int32()),
        "rf": pa.array([s["rf"] for s in seg_rows], pa.int32()), "rt": pa.array([s["rt"] for s in seg_rows], pa.int32()),
        "xy": pa.array([to_int(s["coords"]) for s in seg_rows], pa.list_(pa.int32())),
    }), web / "street_segments.parquet", compression="zstd", row_group_size=2048)
    corner_rows = []
    for (kx, ky, _lvl), sts in nodes:
        lon, lat = loc.lonlat(kx * GROUND_LEVEL_TOL, ky * GROUND_LEVEL_TOL)
        s_list = sorted(sts)
        for i in range(len(s_list)):
            for j in range(i + 1, len(s_list)):
                corner_rows.append((s_list[i], s_list[j], int(round(float(lon) * 1e5)), int(round(float(lat) * 1e5))))
    corner_rows.sort()
    pq.write_table(pa.table({
        "a": pa.array([r[0] for r in corner_rows], pa.int32()), "b": pa.array([r[1] for r in corner_rows], pa.int32()),
        "x": pa.array([r[2] for r in corner_rows], pa.int32()), "y": pa.array([r[3] for r in corner_rows], pa.int32()),
    }), web / "street_corners.parquet", compression="zstd", row_group_size=8192)

    streets_out = []
    for st in streets:
        ntas = sorted(st["nta_len"].items(), key=lambda kv: -kv[1])
        streets_out.append([display_name(st["raw"]), clave(st["raw"]), " | ".join(display_name(a) for a in sorted(st["aliases"])),
                            st["boro"], [c for c, _ in ntas[:3]], len(ntas), round(st["length"])])
    (web / "streets.json").write_text(json.dumps({
        "fields": ["name", "key", "aliases", "boro", "ntas", "n_ntas", "length_m"], "streets": streets_out},
        separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"  streets.json {len(streets_out):,} streets; {len(seg_rows):,} segments; {len(corner_rows):,} corner pairs")

    print("Comparison: 200 m areas on a 100 m grid")
    boros = json.loads((web / "boroughs.geojson").read_text(encoding="utf-8"))["features"]
    land = unary_union([shapely.make_valid(shapely.transform(shape(f["geometry"]),
                                                             lambda c: np.column_stack(loc.xy(c[:, 0], c[:, 1]))))
                        for f in boros])
    shapely.prepare(land)
    x0, y0, x1, y1 = land.bounds
    gx, gy = np.meshgrid(np.arange(x0, x1, GRID_STEP_M), np.arange(y0, y1, GRID_STEP_M))
    gx, gy = gx.ravel(), gy.ravel()
    inside = shapely.contains_xy(land, gx, gy)
    gx, gy = gx[inside], gy[inside]
    print(f"  {len(gx):,} grid points on land")
    series = con.execute(f"""
        SELECT lat, lon, m // 12 + 2016 AS year, cat, sum(n)::BIGINT AS n
        FROM read_parquet('{(web / 'points.parquet').as_posix()}') GROUP BY ALL""").fetchnumpy()
    loc_index = {(la, lo): i for i, (la, lo) in enumerate(zip(locs["lat"].tolist(), locs["lon"].tolist()))}
    li = np.array([loc_index[(la, lo)] for la, lo in zip(series["lat"].tolist(), series["lon"].tolist())])
    ncat = len(meta["categories"])
    col_type = series["cat"].astype(int) + 1                    # 0 = all types
    col_year = series["year"].astype(int) - YEARS[0]
    W = np.zeros((len(px), (ncat + 1) * len(YEARS)), dtype=np.float32)
    np.add.at(W, (li, col_type * len(YEARS) + col_year), series["n"].astype(np.float32))
    np.add.at(W, (li, col_year), series["n"].astype(np.float32))
    near = cKDTree(np.column_stack([gx, gy])).sparse_distance_matrix(cKDTree(np.column_stack([px, py])), RADIUS_M,
                                                                     output_type="coo_matrix")
    M = coo_matrix((np.ones_like(near.data, dtype=np.float32), (near.row, near.col)), shape=(len(gx), len(px))).tocsr()
    counts = M @ W                                              # grid points x (type, year)
    point_cmp = {}
    for t in range(ncat + 1):
        block = counts[:, t * len(YEARS):(t + 1) * len(YEARS)]
        key = "all" if t == 0 else str(t - 1)
        point_cmp[key] = {str(y): percentiles(block[:, k]) for k, y in enumerate(YEARS)}
        point_cmp[key]["avg"] = percentiles(block.mean(axis=1))

    print("Comparison: streets, rate per 100 m")
    length = np.array([st["length"] for st in streets])
    S = np.zeros((len(streets), (ncat + 1) * len(YEARS)), dtype=np.float64)
    c_type = st_tot["cat"].astype(int) + 1
    c_year = st_tot["year"].astype(int) - YEARS[0]
    np.add.at(S, (st_tot["street"], c_type * len(YEARS) + c_year), st_tot["n"])
    np.add.at(S, (st_tot["street"], c_year), st_tot["n"])
    long_enough = length >= SHORT_STREET_M
    street_cmp = {}
    for t in range(ncat + 1):
        block = S[:, t * len(YEARS):(t + 1) * len(YEARS)]
        key = "all" if t == 0 else str(t - 1)
        rates = block[long_enough] / length[long_enough, None] * 100
        street_cmp[key] = {str(y): percentiles(rates[:, k]) for k, y in enumerate(YEARS)}
        street_cmp[key]["avg"] = percentiles(rates.mean(axis=1))

    print("Precinct population (2020 Census blocks)")
    pop = {r["geoid"]: int(r["population"]) for r in csv.DictReader(open(ref / "block_population.csv", encoding="utf-8"))}
    blocks = json.loads((ref / "census_blocks2020.geojson").read_text(encoding="utf-8"))["features"]
    bpts = np.array([shape(f["geometry"]).representative_point() for f in blocks], dtype=object)
    bpop = np.array([pop.get(f["properties"]["geoid"], 0) for f in blocks])
    pcts = json.loads((ref / "precincts.geojson").read_text(encoding="utf-8"))["features"]
    pgeoms = np.array([shape(f["geometry"]) for f in pcts], dtype=object)
    pnums = [int(float(f["properties"]["precinct"])) for f in pcts]
    hb, hp = shapely.STRtree(pgeoms).query(bpts, predicate="within")
    pct_pop: dict[int, int] = defaultdict(int)
    for b, p in zip(hb.tolist(), hp.tolist()):
        pct_pop[pnums[p]] += int(bpop[b])
    placed = sum(pct_pop.values())
    print(f"  {placed:,} of {int(bpop.sum()):,} residents placed in a precinct")

    web_pcts = json.loads((web / "precincts.geojson").read_text(encoding="utf-8"))
    for f in web_pcts["features"]:
        pr = f["properties"]
        pr["population"] = sum(pct_pop.get(p, 0) for p in pr["merged"]) if "merged" in pr else pct_pop.get(pr["pct"], 0)
    (web / "precincts.geojson").write_text(json.dumps(web_pcts, separators=(",", ":")), encoding="utf-8")

    compare = {
        "about": "Percentiles (0..100) of complaints in 200 m circles around points every 100 m on land, and of "
                 "street rates per 100 m (streets >= 300 m), per offense type (all, or category code) and report year; "
                 "'avg' = average per year 2016-2025. street_city: complaints assigned to streets by month x category "
                 "(intersections count for every street there) and the total street length, for the street index.",
        "grid_points": int(len(gx)), "radius_m": RADIUS_M, "step_m": GRID_STEP_M,
        "point": point_cmp, "street": street_cmp, "short_street_m": SHORT_STREET_M,
        "street_city": {"length_m": round(float(length.sum())), "m_cat_n": [list(map(int, r)) for r in city_mc]},
        "precinct_population": {str(k): v for k, v in sorted(pct_pop.items())},
        "assignment": {"complaints_on_map": n_total, "with_street": with_street, "at_intersection": at_corner,
                       "with_house_number": with_hn},
    }
    (web / "compare.json").write_text(json.dumps(compare, separators=(",", ":")), encoding="utf-8")
    print("Done.")


if __name__ == "__main__":
    main()
