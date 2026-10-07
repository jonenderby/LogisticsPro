import type { GeoPoint } from "./common.js";

const EARTH_RADIUS_M = 6_371_008.8;
export const METERS_PER_MILE = 1609.344;

const rad = (d: number) => (d * Math.PI) / 180;

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  return haversineMeters(a, b) / METERS_PER_MILE;
}

/** Straight-line distance times a circuity factor; a stand-in until a routing provider answers. */
export function estimatedRoadMiles(a: GeoPoint, b: GeoPoint, circuity = 1.18): number {
  return haversineMiles(a, b) * circuity;
}
