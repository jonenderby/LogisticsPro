import type { GeoPoint } from "./common.js";
import { estimatedRoadMiles } from "./geo.js";
import { FRESH_DRIVER, type HosStart, afterRest, driveTimeline, formatMinutes } from "./hos.js";
import { type Load, finalDeliveryStop, pickupStop } from "./load.js";

const MIN = 60_000;

export interface LoadMatch {
  loadId: string;
  /** Empty miles from the truck to the pickup. */
  deadheadMiles: number;
  loadedMiles: number;
  /** Rate divided by loaded plus empty miles. */
  ratePerMile?: number;
  /** When the driver can be at the pickup and at the delivery, rests included. */
  pickupAt: string;
  deliveryAt: string;
  /** The driver can legally make both windows. */
  feasible: boolean;
  /** Why not, or what it takes (a rest on the way). */
  reasons: string[];
}

export interface MatchOptions {
  now: string;
  /** Where the truck is. */
  from: GeoPoint;
  /** The driver's hours left now; fresh when absent. */
  hos?: HosStart;
  team?: boolean;
  avgMph?: number;
  /** Hours at each stop to load or unload. */
  dwellHours?: number;
  graceMinutes?: number;
}

/**
 * Whether a driver can legally take a load: reach the pickup before its
 * window closes and deliver within the delivery window, driving the empty
 * miles and the loaded miles under hours-of-service rules from where they
 * are and the hours they have left.
 */
export function matchLoad(load: Load, o: MatchOptions): LoadMatch | undefined {
  const pu = pickupStop(load);
  const del = finalDeliveryStop(load);
  const stops = [...load.stops].sort((a, b) => a.sequence - b.sequence);
  if (!pu.address.geo || stops.some((s) => !s.address.geo)) return undefined;
  const mph = o.avgMph ?? 50;
  const dwell = (o.dwellHours ?? 1) * 60;
  const grace = (o.graceMinutes ?? 15) * MIN;
  const now = Date.parse(o.now);
  const reasons: string[] = [];
  let feasible = true;

  if (load.teamRequired && !o.team) {
    feasible = false;
    reasons.push("Needs a team");
  }

  const deadheadMiles = estimatedRoadMiles(o.from, pu.address.geo);
  const toPickup = driveTimeline((deadheadMiles / mph) * 60, o.hos ?? FRESH_DRIVER, { team: o.team });
  const pickupAt = Math.max(now + toPickup.elapsedMin * MIN, Date.parse(pu.window.start));
  if (now + toPickup.elapsedMin * MIN > Date.parse(pu.window.end) + grace) {
    feasible = false;
    reasons.push(`Can't reach the pickup before its window closes${toPickup.resets ? " with the rest you need on the way" : ""}`);
  }

  // Waiting for the window and loading count as time off the wheel.
  const wait = (pickupAt - (now + toPickup.elapsedMin * MIN)) / MIN + dwell;
  let clock = afterRest(toPickup.end, wait);
  let loadedMiles = 0;
  let t = pickupAt + dwell * MIN;
  let rests = toPickup.resets;
  for (let i = stops.indexOf(pu) + 1; i < stops.length; i++) {
    const miles = estimatedRoadMiles(stops[i - 1]!.address.geo!, stops[i]!.address.geo!);
    loadedMiles += miles;
    const leg = driveTimeline((miles / mph) * 60, clock, { team: o.team });
    rests += leg.resets;
    t += leg.elapsedMin * MIN;
    if (stops[i] !== del) {
      clock = afterRest(leg.end, dwell);
      t += dwell * MIN;
    }
  }
  if (t > Date.parse(del.window.end) + grace) {
    feasible = false;
    reasons.push(`Would deliver ${formatMinutes((t - Date.parse(del.window.end)) / MIN)} after the window closes`);
  }
  if (feasible && rests) reasons.push(`Includes ${rests === 1 ? "a 10-hour rest" : `${rests} 10-hour rests`} on the way`);

  const total = deadheadMiles + loadedMiles;
  return {
    loadId: load.id,
    deadheadMiles: Math.round(deadheadMiles),
    loadedMiles: Math.round(loadedMiles),
    ratePerMile: load.rate && total > 0 ? Math.round((load.rate.amount / total) * 100) / 100 : undefined,
    pickupAt: new Date(pickupAt).toISOString(),
    deliveryAt: new Date(t).toISOString(),
    feasible,
    reasons,
  };
}

/** Loads a driver can legally take first, best paying per mile first. */
export function rankMatches(matches: LoadMatch[]): LoadMatch[] {
  return [...matches].sort((a, b) => Number(b.feasible) - Number(a.feasible) || (b.ratePerMile ?? 0) - (a.ratePerMile ?? 0) || a.deadheadMiles - b.deadheadMiles);
}
