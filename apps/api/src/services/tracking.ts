import { type Load, type ShipmentEta, finalDeliveryStop, pickupStop, shipmentEta } from "@logisticspro/domain";
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

export function etaFor(store: MemoryStore, load: Load, now: Date): ShipmentEta {
  const p = positionForLoad(store, load);
  return shipmentEta(load, { now: now.toISOString(), position: p ? { geo: p.geo, at: p.at, speedMps: p.speedMps, headingDeg: p.headingDeg } : undefined });
}

export function lane(load: Load) {
  const pu = pickupStop(load).address;
  const del = finalDeliveryStop(load).address;
  return { origin: `${pu.city}, ${pu.state}`, destination: `${del.city}, ${del.state}` };
}
