import type { AppContext } from "../http.js";
import { HttpError } from "../http.js";
import { recordFix } from "./hos.js";
import { recordMiles } from "./ifta.js";
import { recordStopVisits } from "./stops.js";

export interface Fix {
  lat: number;
  lng: number;
  at?: string;
  speedMps?: number;
  headingDeg?: number;
  accuracyM?: number;
}

/** Is this driver's hours-of-service record kept by a connected ELD? */
export const onEld = (ctx: AppContext, accountId: string) => ctx.store.eldDrivers.has(accountId);

/**
 * Record one location fix from a driver's phone or their truck's ELD: the
 * latest position, the trail (miles, fuel tax), stop arrival and departure,
 * and, for phones of drivers without an ELD, automatic duty status.
 */
export function acceptLocation(ctx: AppContext, accountId: string, b: Fix, now: Date, source: "PHONE" | "ELD" = "PHONE"): void {
  const at = b.at ? new Date(b.at) : now;
  if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime() + 5 * 60_000) throw new HttpError(400, "INVALID_REQUEST", "Position time is invalid");
  const prior = ctx.store.positions.get(accountId);
  if (!prior || prior.at <= at.toISOString()) {
    ctx.store.positions.set(accountId, { accountId, geo: { lat: b.lat, lng: b.lng }, at: at.toISOString(), speedMps: b.speedMps, headingDeg: b.headingDeg, accuracyM: b.accuracyM, source });
  }
  const prev = ctx.store.tracks.get(accountId)?.at(-1);
  const point = { geo: { lat: b.lat, lng: b.lng }, at: at.toISOString(), speedMps: b.speedMps };
  recordFix(ctx.store, accountId, point, now, { autoDuty: source === "PHONE" && !onEld(ctx, accountId) });
  recordMiles(ctx, accountId, prev, point);
  recordStopVisits(ctx, accountId, { geo: { lat: b.lat, lng: b.lng }, at: at.toISOString() });
}
