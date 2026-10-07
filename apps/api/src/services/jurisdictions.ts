import { readFileSync } from "node:fs";
import type { GeoPoint } from "@logisticspro/domain";

export interface Jurisdiction {
  code: string;
  country: "US" | "CA";
  name: string;
}

interface Shape extends Jurisdiction {
  bbox: [number, number, number, number];
  /** Polygons of rings of [lng, lat]; the first ring is the outline, the rest are holes. */
  polygons: number[][][][];
}

/** IFTA members: the lower 48 states and ten Canadian provinces (not Alaska, Hawaii, DC or the territories). */
const NOT_MEMBERS = new Set(["US-AK", "US-HI", "US-DC", "CA-NT", "CA-NU", "CA-YT"]);
export const isIftaMember = (j: Jurisdiction) => !NOT_MEMBERS.has(`${j.country}-${j.code}`);

let shapes: Shape[] | undefined;
function load(): Shape[] {
  // US states (Census 1:500k) and Canadian provinces (Natural Earth 1:10m), simplified to about 100 m.
  shapes ??= (JSON.parse(readFileSync(new URL("../../data/jurisdictions.json", import.meta.url), "utf8")) as { jurisdictions: Shape[] }).jurisdictions;
  return shapes;
}

function inRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi! > y !== yj! > y && x < ((xj! - xi!) * (y - yi!)) / (yj! - yi!) + xi!) inside = !inside;
  }
  return inside;
}

/** The state or province a point is in, or undefined outside the US and Canada. */
export function jurisdictionAt(p: GeoPoint): Jurisdiction | undefined {
  for (const s of load()) {
    const [minX, minY, maxX, maxY] = s.bbox;
    if (p.lng < minX || p.lng > maxX || p.lat < minY || p.lat > maxY) continue;
    for (const poly of s.polygons) {
      if (!inRing(p.lng, p.lat, poly[0]!)) continue;
      if (poly.slice(1).some((hole) => inRing(p.lng, p.lat, hole))) continue;
      return { code: s.code, country: s.country, name: s.name };
    }
  }
  return undefined;
}

export function jurisdictionName(code: string): string | undefined {
  return jurisdictionInfo(code)?.name;
}

export function jurisdictionInfo(code: string): Jurisdiction | undefined {
  const s = load().find((x) => x.code === code);
  return s ? { code: s.code, country: s.country, name: s.name } : undefined;
}

/**
 * Split a straight stretch between two fixes by jurisdiction: where both ends
 * are in the same place it all goes there; otherwise the border is found by
 * halving the stretch, and the miles are shared at that point.
 */
export function splitByJurisdiction(a: GeoPoint, b: GeoPoint, miles: number): Array<{ code: string; miles: number }> {
  // A fix in no jurisdiction (in a small gap between the two data sets, or offshore) takes its neighbour's.
  const ja = jurisdictionAt(a)?.code ?? jurisdictionAt(b)?.code ?? "OTHER";
  const jb = jurisdictionAt(b)?.code ?? ja;
  if (ja === jb) return [{ code: ja, miles }];
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const code = jurisdictionAt({ lat: a.lat + (b.lat - a.lat) * mid, lng: a.lng + (b.lng - a.lng) * mid })?.code;
    if (code === ja) lo = mid;
    else hi = mid;
  }
  const f = (lo + hi) / 2;
  return [
    { code: ja, miles: miles * f },
    { code: jb, miles: miles * (1 - f) },
  ];
}
