// Geometry helpers. The hexagon grid parameters come from meta.json (written by the pipeline's
// hexgrid.py), so these functions and the data always use the same grid.

let grid;
export function setGrid(g) { grid = g; }

/** Hexagon (q, r) -> center [lon, lat]. */
export function hexCenter(q, r) {
  const cx = grid.side * Math.sqrt(3) * (q + r / 2);
  const cy = grid.side * 1.5 * r;
  return [grid.lon0 + cx / grid.kx, grid.lat0 + cy / grid.ky];
}

/** [lon, lat] -> hexagon {q, r} (pointy-top axial, cube rounding), same formula as hexgrid.py. */
export function hexAt([lon, lat]) {
  const x = (lon - grid.lon0) * grid.kx;
  const y = (lat - grid.lat0) * grid.ky;
  const qf = ((Math.sqrt(3) / 3) * x - y / 3) / grid.side;
  const rf = ((2 / 3) * y) / grid.side;
  const sf = -qf - rf;
  let q = Math.round(qf), r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

/** Outline of a hexagon as a GeoJSON polygon (vertices at 30°, 90°, ...: pointy-top). */
export function hexPolygon(q, r) {
  const [lon, lat] = hexCenter(q, r);
  const ring = [];
  for (let k = 0; k <= 6; k++) {
    const a = ((30 + 60 * k) * Math.PI) / 180;
    ring.push([lon + (grid.side * Math.cos(a)) / grid.kx, lat + (grid.side * Math.sin(a)) / grid.ky]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Feature from a GeoJSON FeatureCollection that contains the point, or null. */
export function featureAt(collection, point) {
  for (const f of collection.features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const [outer, ...holes] of polys) {
      if (inRing(point, outer) && !holes.some((h) => inRing(point, h))) return f;
    }
  }
  return null;
}

/** Distance in meters between two [lon, lat] points (local projection of the grid). */
export function meters([lon1, lat1], [lon2, lat2]) {
  return Math.hypot((lon2 - lon1) * grid.kx, (lat2 - lat1) * grid.ky);
}

/** A circle of `radius` meters around [lon, lat] as a GeoJSON polygon. */
export function circlePolygon([lon, lat], radius, steps = 64) {
  const ring = [];
  for (let k = 0; k <= steps; k++) {
    const a = (2 * Math.PI * k) / steps;
    ring.push([lon + (radius * Math.cos(a)) / grid.kx, lat + (radius * Math.sin(a)) / grid.ky]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

/** Bounding box [[w, s], [e, n]] of a GeoJSON feature. */
export function bounds(feature) {
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c) => (typeof c[0] === 'number'
    ? (w = Math.min(w, c[0]), e = Math.max(e, c[0]), s = Math.min(s, c[1]), n = Math.max(n, c[1]))
    : c.forEach(walk));
  walk(feature.geometry.coordinates);
  return [[w, s], [e, n]];
}

/** Degrees of latitude / longitude spanning `m` meters. */
export const degLat = (m) => m / grid.ky;
export const degLon = (m) => m / grid.kx;
