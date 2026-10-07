import type { GeoPoint } from "@logisticspro/domain";

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const toJulian = (d: Date) => d.getTime() / 86_400_000 + 2_440_587.5;
const fromJulian = (j: number) => new Date((j - 2_440_587.5) * 86_400_000);

/**
 * Sunrise and sunset for the solar day containing `at` (sunrise equation,
 * accurate to a couple of minutes). Returns null during polar day/night.
 */
export function sunTimes(at: Date, geo: GeoPoint): { sunrise: Date; sunset: Date } | null {
  // Shift to approximate local solar time so we pick the right calendar day.
  const local = new Date(at.getTime() + (geo.lng / 360) * 86_400_000);
  const noonUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 12);
  const n = Math.round(toJulian(new Date(noonUtc)) - 2_451_545.0 + 0.0008);
  const jStar = n - geo.lng / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 0.0003 * Math.sin(rad(3 * M));
  const lambda = (M + C + 180 + 102.9372) % 360;
  const jTransit = 2_451_545.0 + jStar + 0.0053 * Math.sin(rad(M)) - 0.0069 * Math.sin(rad(2 * lambda));
  const sinDec = Math.sin(rad(lambda)) * Math.sin(rad(23.4397));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosW = (Math.sin(rad(-0.833)) - Math.sin(rad(geo.lat)) * sinDec) / (Math.cos(rad(geo.lat)) * cosDec);
  if (cosW < -1 || cosW > 1) return null;
  const w = deg(Math.acos(cosW));
  return { sunrise: fromJulian(jTransit - w / 360), sunset: fromJulian(jTransit + w / 360) };
}

/** Most state OS/OW permits allow travel from 30 minutes before sunrise to 30 minutes after sunset. */
export function isDaylightTravel(at: Date, geo: GeoPoint, graceMinutes = 30): boolean {
  const s = sunTimes(at, geo);
  if (!s) return false;
  const g = graceMinutes * 60_000;
  return at.getTime() >= s.sunrise.getTime() - g && at.getTime() <= s.sunset.getTime() + g;
}

/** Weekend by approximate local solar time (longitude / 15 hours). */
export function isWeekendLocal(at: Date, geo: GeoPoint): boolean {
  const local = new Date(at.getTime() + Math.round(geo.lng / 15) * 3_600_000);
  const day = local.getUTCDay();
  return day === 0 || day === 6;
}
