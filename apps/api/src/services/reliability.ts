import { type Load, carrierReliability, carrierWindows, driverReliability, shipmentOutcome } from "@logisticspro/domain";
import { type MemoryStore, driverCount } from "../store.js";

/** Keep the shipment's outcome current whenever a delivered load or its exceptions change. */
export function recordOutcome(store: MemoryStore, load: Load): void {
  if (!load.deliveredAt || load.status === "CANCELLED") return;
  store.outcomes.set(load.id, shipmentOutcome(load, store.exceptions.get(load.id) ?? []));
}

export function carrierProfile(store: MemoryStore, carrierOrgId: string, businessOrgId?: string) {
  const truckers = driverCount(store, carrierOrgId);
  return { truckers, windows: carrierWindows(truckers), ...carrierReliability([...store.outcomes.values()], carrierOrgId, truckers, businessOrgId) };
}

export function driverProfile(store: MemoryStore, accountId: string, businessOrgId?: string) {
  return driverReliability([...store.outcomes.values()], accountId, businessOrgId);
}
