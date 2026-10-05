import { DEFAULT_DETENTION, type DetentionTerms, type GeoPoint, type Load, detention, updateVisits } from "@logisticspro/domain";
import { type AppContext, saveLoad } from "../http.js";
import { activeLeg } from "./tracking.js";

/** Loads whose stops are being worked: arrival and departure are recorded. */
const WORKING = ["DISPATCHED", "AT_PICKUP", "IN_TRANSIT", "AT_DELIVERY"];

export function detentionTerms(ctx: AppContext, load: Load): DetentionTerms {
  return (load.carrierOrgId && ctx.store.orgs.get(load.carrierOrgId)?.detention) || DEFAULT_DETENTION;
}

/**
 * Record arrival and departure at the stops of the loads this driver is
 * driving, from one location fix. On arrival, prompt the driver to confirm
 * with one tap if they have not reported it.
 */
export function recordStopVisits(ctx: AppContext, accountId: string, fix: { geo: GeoPoint; at: string }): void {
  for (const load of ctx.store.loads.values()) {
    if (!WORKING.includes(load.status) || !activeLeg(load)?.driverAccountIds.includes(accountId)) continue;
    const r = updateVisits(load, fix);
    if (!r) continue;
    saveLoad(ctx, { ...load, visits: r.visits, updatedAt: ctx.now().toISOString() });
    const stop = r.arrived;
    if (!stop || (stop.type !== "PICKUP" && stop.type !== "DELIVERY")) continue;
    const reported = stop.type === "PICKUP" ? ["AT_PICKUP", "IN_TRANSIT", "AT_DELIVERY"].includes(load.status) : load.status === "AT_DELIVERY";
    if (!reported) ctx.notifier.atStop([accountId], load, stop.address.name, stop.type);
  }
}

/** Job: tell the shipper and dispatch once when free time runs out at a stop. */
export function checkDetention(ctx: AppContext): number {
  const now = ctx.now().toISOString();
  let sent = 0;
  for (const load of ctx.store.loads.values()) {
    const open = load.visits?.filter((v) => !v.departedAt && !v.detentionNotifiedAt);
    if (!open?.length) continue;
    const terms = detentionTerms(ctx, load);
    const rows = detention(load, terms, now);
    let visits = load.visits!;
    for (const v of open) {
      const row = rows.find((r) => r.stopId === v.stopId);
      if (!row?.billableMinutes) continue;
      ctx.notifier.detentionStarted(load, row, terms.ratePerHour);
      visits = visits.map((x) => (x === v ? { ...x, detentionNotifiedAt: now } : x));
      sent++;
    }
    if (visits !== load.visits) saveLoad(ctx, { ...load, visits });
  }
  return sent;
}
