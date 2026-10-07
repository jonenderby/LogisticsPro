import { type Load, carrierReliability, carrierWindows, driverReliability, missedAppointmentOutcomes, shipmentOutcome } from "@logisticspro/domain";
import { type MemoryStore, driverCount } from "../store.js";

/**
 * Keep a load's outcomes current whenever it, its exceptions or its missed
 * appointments change. The carrier that delivered gets one outcome; a carrier
 * that missed an appointment and then lost the load gets its own, so each
 * ding lands on the carrier that was hauling at the time and on no other.
 */
export function recordOutcome(store: MemoryStore, load: Load): void {
  const misses = store.appointmentMisses.get(load.id) ?? [];
  store.outcomes.delete(load.id);
  for (const m of misses) store.outcomes.delete(`${load.id}#${m.carrierKey}`);
  if (load.deliveredAt && load.status !== "CANCELLED") store.outcomes.set(load.id, shipmentOutcome(load, store.exceptions.get(load.id) ?? [], undefined, misses));
  for (const o of missedAppointmentOutcomes(load, misses)) store.outcomes.set(`${load.id}#${o.carrierKey}`, o);
}

/** Carriers reached only by API or EDI have no driver roster; they are scored on the single-truck window. */
export function carrierProfile(store: MemoryStore, carrierKey: string, businessOrgId?: string) {
  const truckers = carrierKey.startsWith("partner:") ? 1 : driverCount(store, carrierKey);
  return { truckers, windows: carrierWindows(truckers), ...carrierReliability([...store.outcomes.values()], carrierKey, truckers, businessOrgId) };
}

export function driverProfile(store: MemoryStore, accountId: string, businessOrgId?: string, carrierKey?: string) {
  return driverReliability([...store.outcomes.values()], accountId, businessOrgId, carrierKey);
}
