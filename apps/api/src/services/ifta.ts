import { type TrackPoint, estimatedRoadMiles, haversineMiles } from "@logisticspro/domain";
import type { AppContext } from "../http.js";
import { splitByJurisdiction } from "./jurisdictions.js";
import { MOVING, activeLeg } from "./tracking.js";

/** A team phone that has not reported for this long hands mileage over to the other phone. */
const REPORTER_STALE_MS = 10 * 60_000;

/** The truck and carrier a driver's miles count for right now. */
export function vehicleOf(ctx: AppContext, accountId: string): { carrierOrgId?: string; vehicle: string; label: string; crew: string[] } {
  const load = [...ctx.store.loads.values()].find((l) => MOVING.includes(l.status) && activeLeg(l)?.driverAccountIds.includes(accountId));
  const leg = load ? activeLeg(load) : undefined;
  const crew = leg?.driverAccountIds ?? [accountId];
  const account = ctx.store.accounts.get(accountId);
  const carrierOrgId = load?.carrierOrgId ?? account?.driver?.homeCarrierOrgId ?? ctx.store.memberships.find((m) => m.accountId === accountId && m.roles.includes("DRIVER"))?.orgId;
  if (leg?.tractorId) return { carrierOrgId, vehicle: `unit:${leg.tractorId}`, label: `Unit ${leg.tractorId}`, crew };
  // A team without a unit number shares one truck, filed under the first driver.
  const owner = ctx.store.accounts.get(crew[0]!) ?? account;
  return { carrierOrgId, vehicle: `driver:${owner?.id ?? accountId}`, label: `${owner?.name ?? "Driver"}'s truck`, crew };
}

/**
 * On a team truck both phones report the same trip; only one counts. That is
 * the first driver whose phone has reported recently.
 */
function reporterOf(ctx: AppContext, crew: string[], at: string): string | undefined {
  if (crew.length < 2) return crew[0];
  const now = Date.parse(at);
  return crew.find((id) => {
    const p = ctx.store.positions.get(id);
    return p && now - Date.parse(p.at) < REPORTER_STALE_MS;
  });
}

/**
 * Credit the stretch between two location fixes to the states and provinces
 * it ran through, for the carrier's fuel-tax report. Only moving stretches
 * count (no GPS drift while parked, no jumps faster than a truck can go).
 */
export function recordMiles(ctx: AppContext, accountId: string, prev: TrackPoint | undefined, fix: TrackPoint): void {
  if (!prev || fix.at <= prev.at) return;
  const hours = (Date.parse(fix.at) - Date.parse(prev.at)) / 3_600_000;
  const straight = haversineMiles(prev.geo, fix.geo);
  const mph = straight / hours;
  if (mph < 5 || mph > 90 || straight < 0.01) return;
  const miles = hours > 5 / 60 ? estimatedRoadMiles(prev.geo, fix.geo) : straight;
  const { carrierOrgId, vehicle, label, crew } = vehicleOf(ctx, accountId);
  if (!carrierOrgId || reporterOf(ctx, crew, fix.at) !== accountId) return;
  const date = fix.at.slice(0, 10);
  const key = `${carrierOrgId}|${vehicle}|${date}`;
  const day = ctx.store.jurisdictionMiles.get(key) ?? { carrierOrgId, vehicle, vehicleLabel: label, date, miles: {} };
  const next = { ...day, miles: { ...day.miles } };
  for (const part of splitByJurisdiction(prev.geo, fix.geo, miles)) next.miles[part.code] = Math.round(((next.miles[part.code] ?? 0) + part.miles) * 1000) / 1000;
  ctx.store.jurisdictionMiles.set(key, next);
}
