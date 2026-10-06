import { type Load, haversineMiles, pickupStop } from "@logisticspro/domain";
import { LEGAL_TRUCK, StaticProvider, type TruckProfile } from "@logisticspro/navigation";
import type { AppContext } from "../http.js";
import { MOVING, activeLeg, positionForLoad } from "./tracking.js";

const REFRESH_AFTER_MS = 30 * 60_000;
/** Traffic changes faster than the road, so live-traffic times are refreshed more often. */
const TRAFFIC_REFRESH_AFTER_MS = 15 * 60_000;
const REROUTE_AFTER_MILES = 50;

const truckFor = (load: Load): TruckProfile =>
  load.oversize ? { heightIn: load.oversize.heightIn, widthIn: load.oversize.widthIn, lengthIn: load.oversize.lengthIn, grossWeightLb: load.oversize.grossWeightLb, axles: load.oversize.axles } : LEGAL_TRUCK;

/**
 * Route what is left of each moving load, so ETAs use real road distance and
 * driving time: from a live-traffic provider (HERE or TomTom) every 15
 * minutes when one is set up, otherwise from the routing server (Valhalla)
 * every 30 minutes, and after 50 miles either way. If the traffic provider
 * fails, Valhalla's time is used. Without either there is nothing better than
 * the estimate, so nothing is done.
 */
export async function refreshRoutes(ctx: AppContext, limit = 50): Promise<number> {
  const hasRouting = !(ctx.routing instanceof StaticProvider);
  if (!ctx.traffic && !hasRouting) return 0;
  const every = ctx.traffic ? TRAFFIC_REFRESH_AFTER_MS : REFRESH_AFTER_MS;
  const now = ctx.now();
  let done = 0;
  for (const load of ctx.store.loadsIn(...(MOVING as Load["status"][]))) {
    if (done >= limit) break;
    if (!MOVING.includes(load.status) || !load.pickedUpAt) continue;
    const p = positionForLoad(ctx.store, load);
    if (!p) continue;
    const prior = ctx.store.routeEstimates.get(load.id);
    if (prior && now.getTime() - Date.parse(prior.at) < every && haversineMiles(prior.from, p.geo) < REROUTE_AFTER_MILES) continue;
    const pu = pickupStop(load);
    const completed = new Set(load.legs.filter((l) => l.status === "COMPLETED").map((l) => l.toStopId));
    const ahead = [...load.stops].sort((a, b) => a.sequence - b.sequence).filter((s) => s.sequence > pu.sequence && !completed.has(s.id) && s.address.geo);
    if (!ahead.length || !activeLeg(load)) continue;
    const points = [p.geo, ...ahead.map((s) => s.address.geo!)];
    const base = { from: p.geo, to: ahead[ahead.length - 1]!.address.geo!, at: now.toISOString() };
    try {
      if (ctx.traffic) {
        try {
          const t = await ctx.traffic.travelTime(points, truckFor(load), now.toISOString());
          ctx.store.routeEstimates.set(load.id, { ...base, miles: t.distanceM / 1609.344, minutes: t.durationS / 60, trafficDelayMinutes: Math.round(t.trafficDelayS / 60), source: t.source });
          done++;
          continue;
        } catch (e) {
          if (!hasRouting) throw e;
        }
      }
      const route = await ctx.routing.route(points, truckFor(load), { departAt: now.toISOString() });
      ctx.store.routeEstimates.set(load.id, { ...base, miles: route.distanceM / 1609.344, minutes: route.durationS / 60, source: route.source });
      done++;
    } catch {
      // The estimate stays in use until a provider answers.
    }
  }
  for (const [id] of ctx.store.routeEstimates) if (!MOVING.includes(ctx.store.loads.get(id)?.status ?? "")) ctx.store.routeEstimates.delete(id);
  return done;
}
