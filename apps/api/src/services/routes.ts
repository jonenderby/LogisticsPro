import { type Load, haversineMiles, pickupStop } from "@logisticspro/domain";
import { LEGAL_TRUCK, StaticProvider, type TruckProfile } from "@logisticspro/navigation";
import type { AppContext } from "../http.js";
import { MOVING, activeLeg, positionForLoad } from "./tracking.js";

const REFRESH_AFTER_MS = 30 * 60_000;
const REROUTE_AFTER_MILES = 50;

const truckFor = (load: Load): TruckProfile =>
  load.oversize ? { heightIn: load.oversize.heightIn, widthIn: load.oversize.widthIn, lengthIn: load.oversize.lengthIn, grossWeightLb: load.oversize.grossWeightLb, axles: load.oversize.axles } : LEGAL_TRUCK;

/**
 * Ask the routing server (Valhalla) for the truck route over what is left of
 * each moving load, every 30 minutes or after 50 miles, so ETAs use real road
 * distance and speeds. Without a routing server there is nothing better than
 * the estimate, so nothing is done.
 */
export async function refreshRoutes(ctx: AppContext, limit = 50): Promise<number> {
  if (ctx.routing instanceof StaticProvider) return 0;
  const now = ctx.now();
  let done = 0;
  for (const load of ctx.store.loadsIn(...(MOVING as Load["status"][]))) {
    if (done >= limit) break;
    if (!MOVING.includes(load.status) || !load.pickedUpAt) continue;
    const p = positionForLoad(ctx.store, load);
    if (!p) continue;
    const prior = ctx.store.routeEstimates.get(load.id);
    if (prior && now.getTime() - Date.parse(prior.at) < REFRESH_AFTER_MS && haversineMiles(prior.from, p.geo) < REROUTE_AFTER_MILES) continue;
    const pu = pickupStop(load);
    const completed = new Set(load.legs.filter((l) => l.status === "COMPLETED").map((l) => l.toStopId));
    const ahead = [...load.stops].sort((a, b) => a.sequence - b.sequence).filter((s) => s.sequence > pu.sequence && !completed.has(s.id) && s.address.geo);
    if (!ahead.length || !activeLeg(load)) continue;
    try {
      const route = await ctx.routing.route([p.geo, ...ahead.map((s) => s.address.geo!)], truckFor(load), { departAt: now.toISOString() });
      ctx.store.routeEstimates.set(load.id, { from: p.geo, to: ahead[ahead.length - 1]!.address.geo!, miles: route.distanceM / 1609.344, minutes: route.durationS / 60, at: now.toISOString(), source: route.source });
      done++;
    } catch {
      // The estimate stays in use until the routing server answers.
    }
  }
  for (const [id] of ctx.store.routeEstimates) if (!MOVING.includes(ctx.store.loads.get(id)?.status ?? "")) ctx.store.routeEstimates.delete(id);
  return done;
}
