import { type GeoPoint, type Load, type ShipmentEta, finalDeliveryStop, haversineMiles, pickupStop, shipmentEta } from "@logisticspro/domain";
import { currentHosClock } from "./hos.js";
import type { DriverPosition, MemoryStore } from "../store.js";

export const UNDELIVERED = ["POSTED", "TENDERED", "BOOKED", "DISPATCHED", "AT_PICKUP", "IN_TRANSIT", "AT_DELIVERY"];
export const MOVING = ["DISPATCHED", "AT_PICKUP", "IN_TRANSIT", "AT_DELIVERY"];
/** A driver with no location for this long shows as offline. */
export const OFFLINE_AFTER_MS = 2 * 3_600_000;

/** The leg being driven now (or next), whose drivers' phones locate the load. */
export function activeLeg(load: Load) {
  return load.legs.find((l) => l.status === "IN_PROGRESS") ?? load.legs.find((l) => l.status !== "COMPLETED");
}

export function positionForLoad(store: MemoryStore, load: Load): DriverPosition | undefined {
  const leg = activeLeg(load);
  if (!leg || !MOVING.includes(load.status)) return undefined;
  return leg.driverAccountIds
    .map((id) => store.positions.get(id))
    .filter((p): p is DriverPosition => !!p)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
}

/** Routes older than this are not used. */
const ROUTE_MAX_AGE_MS = 2 * 3_600_000;

/**
 * The routed remainder of a load, scaled to how far the truck has come since
 * it was routed, so a route stays useful between refreshes.
 */
export function routeFor(store: MemoryStore, load: Load, pos: GeoPoint, now: Date): { miles: number; minutes: number } | undefined {
  const r = store.routeEstimates.get(load.id);
  if (!r || now.getTime() - Date.parse(r.at) > ROUTE_MAX_AGE_MS) return undefined;
  const then = haversineMiles(r.from, r.to);
  if (then <= 0) return undefined;
  const ratio = Math.min(1.2, haversineMiles(pos, r.to) / then);
  return { miles: r.miles * ratio, minutes: r.minutes * ratio };
}

/**
 * Arrival estimate for a load, using the solo driver's real hours of service
 * (a team keeps rolling) and a routed distance and time when the routing
 * server has one.
 */
export function etaFor(store: MemoryStore, load: Load, now: Date): ShipmentEta {
  const p = positionForLoad(store, load);
  const leg = activeLeg(load);
  const solo = leg?.driverAccountIds.length === 1 ? leg.driverAccountIds[0]! : undefined;
  const log = solo ? store.dutyLogs.get(solo) : undefined;
  const hos = solo && (log?.length || store.eldDrivers.has(solo)) ? currentHosClock(store, solo, now) : undefined;
  return shipmentEta(load, {
    now: now.toISOString(),
    position: p ? { geo: p.geo, at: p.at, speedMps: p.speedMps, headingDeg: p.headingDeg } : undefined,
    hos,
    route: p ? routeFor(store, load, p.geo, now) : undefined,
  });
}

export function lane(load: Load) {
  const pu = pickupStop(load).address;
  const del = finalDeliveryStop(load).address;
  return { origin: `${pu.city}, ${pu.state}`, destination: `${del.city}, ${del.state}` };
}
