import { type GeoPoint, haversineMeters } from "@logisticspro/domain";

const R = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function bearingDeg(a: GeoPoint, b: GeoPoint): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Point at `distance` metres along `bearing` from `from`. */
export function destination(from: GeoPoint, bearing: number, distanceM: number): GeoPoint {
  const dr = distanceM / R;
  const b = rad(bearing);
  const lat1 = rad(from.lat);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(b));
  const lng2 = rad(from.lng) + Math.atan2(Math.sin(b) * Math.sin(dr) * Math.cos(lat1), Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: deg(lat2), lng: ((deg(lng2) + 540) % 360) - 180 };
}

export interface PreparedLine {
  points: GeoPoint[];
  /** cumulative[i] = metres from start to points[i]. */
  cumulative: number[];
  lengthM: number;
}

export function prepareLine(points: GeoPoint[]): PreparedLine {
  if (points.length < 2) throw new Error("a route needs at least two points");
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1]! + haversineMeters(points[i - 1]!, points[i]!));
  return { points, cumulative, lengthM: cumulative[cumulative.length - 1]! };
}

export interface Snap {
  segment: number;
  /** 0..1 along the segment. */
  t: number;
  point: GeoPoint;
  /** Perpendicular distance from the fix to the line. */
  offsetM: number;
  /** Distance from route start to the snapped point. */
  alongM: number;
}

function snapSegment(line: PreparedLine, i: number, p: GeoPoint): Snap {
  const a = line.points[i]!;
  const b = line.points[i + 1]!;
  // Local equirectangular projection around the fix: accurate at segment scale.
  const k = Math.cos(rad(p.lat));
  const ax = rad(a.lng - p.lng) * k * R;
  const ay = rad(a.lat - p.lat) * R;
  const bx = rad(b.lng - p.lng) * k * R;
  const by = rad(b.lat - p.lat) * R;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const px = ax + t * dx;
  const py = ay + t * dy;
  const segLen = line.cumulative[i + 1]! - line.cumulative[i]!;
  return {
    segment: i,
    t,
    point: { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) },
    offsetM: Math.hypot(px, py),
    alongM: line.cumulative[i]! + t * segLen,
  };
}

/**
 * Snap a fix to the line. With a hint, search forward from the last known
 * segment first so a route that doubles back on itself does not jump ahead.
 */
export function snapToLine(line: PreparedLine, p: GeoPoint, hintSegment?: number, window = 50): Snap {
  const n = line.points.length - 1;
  let best: Snap | undefined;
  const consider = (from: number, to: number) => {
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) {
      const s = snapSegment(line, i, p);
      if (!best || s.offsetM < best.offsetM) best = s;
    }
  };
  if (hintSegment !== undefined) {
    consider(hintSegment - 2, hintSegment + window);
    if (best && best.offsetM < 100) return best;
  }
  consider(0, n);
  return best!;
}

export function pointAlong(line: PreparedLine, alongM: number): GeoPoint {
  const d = Math.max(0, Math.min(line.lengthM, alongM));
  let i = 0;
  while (i < line.cumulative.length - 2 && line.cumulative[i + 1]! < d) i++;
  const segLen = line.cumulative[i + 1]! - line.cumulative[i]!;
  const t = segLen === 0 ? 0 : (d - line.cumulative[i]!) / segLen;
  const a = line.points[i]!;
  const b = line.points[i + 1]!;
  return { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
}

/** Google encoded polyline (precision 5) or Valhalla/OSRM polyline6 (precision 6). */
export function decodePolyline(encoded: string, precision = 5): GeoPoint[] {
  const factor = 10 ** precision;
  const out: GeoPoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lng += next();
    out.push({ lat: lat / factor, lng: lng / factor });
  }
  return out;
}

export function encodePolyline(points: GeoPoint[], precision = 5): string {
  const factor = 10 ** precision;
  let prevLat = 0;
  let prevLng = 0;
  let out = "";
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * factor);
    const lng = Math.round(p.lng * factor);
    enc(lat - prevLat);
    enc(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out;
}
