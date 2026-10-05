import { z } from "zod";
import { type Load, finalDeliveryStop, pickupStop } from "./load.js";

/** Over / short / damage and similar problems reported on a shipment. */
export const ExceptionType = z.enum(["DAMAGE", "SHORTAGE", "OVERAGE", "REFUSED", "OTHER"]);
export type ExceptionType = z.infer<typeof ExceptionType>;

export const LoadException = z.object({
  id: z.string(),
  loadId: z.string(),
  type: ExceptionType,
  note: z.string().max(1000),
  pieces: z.number().int().positive().optional(),
  reportedByAccountId: z.string(),
  reportedByOrgId: z.string().optional(),
  at: z.string(),
});
export type LoadException = z.infer<typeof LoadException>;

/** Grace after the window closes before an arrival counts as late. */
export const ON_TIME_GRACE_MINUTES = 15;

export const DRIVER_OVERALL_WINDOW = 1000;
export const DRIVER_BUSINESS_WINDOW = 100;

/**
 * Carrier windows scale with fleet size so a carrier is judged on the same
 * depth of history per truck as a single driver: 10 truckers means the last
 * 1,000 shipments for one business and the last 10,000 overall.
 */
export function carrierWindows(truckerCount: number): { overall: number; perBusiness: number } {
  const n = Math.max(1, truckerCount);
  return { overall: DRIVER_OVERALL_WINDOW * n, perBusiness: DRIVER_BUSINESS_WINDOW * n };
}

/** What happened on one delivered shipment, and who it counts for. */
export interface ShipmentOutcome {
  loadId: string;
  loadNumber: string;
  deliveredAt: string;
  carrierOrgId?: string;
  /** The shipper and, if brokered, the broker: the "businesses" this shipment was for. */
  businessOrgIds: string[];
  /** Drivers on the first leg (accountable for pickup). */
  pickupDriverIds: string[];
  /** Drivers on the final leg (accountable for delivery). */
  deliveryDriverIds: string[];
  /** Everyone who drove any leg (accountable for damage). */
  driverIds: string[];
  /** null when the event needed to judge it was never reported. */
  onTimePickup: boolean | null;
  onTimeDelivery: boolean | null;
  damageFree: boolean;
  exceptionTypes: ExceptionType[];
}

const late = (at: string | undefined, windowEnd: string, graceMin: number): boolean | null =>
  at ? Date.parse(at) <= Date.parse(windowEnd) + graceMin * 60_000 : null;

export function shipmentOutcome(load: Load, exceptions: LoadException[] = [], graceMinutes = ON_TIME_GRACE_MINUTES): ShipmentOutcome {
  if (!load.deliveredAt) throw new Error("Outcome needs a delivered load");
  const pu = pickupStop(load);
  const del = finalDeliveryStop(load);
  const loaded = load.events.find((e) => e.code === "LOADED")?.at ?? load.pickedUpAt;
  // Arrival is what the appointment measures; fall back to the delivered time.
  const arrived = load.events.find((e) => e.code === "ARRIVED_DELIVERY" && (!e.stopId || e.stopId === del.id))?.at ?? load.deliveredAt;
  const legs = [...load.legs].sort((a, b) => a.sequence - b.sequence);
  const mine = exceptions.filter((x) => x.loadId === load.id);
  return {
    loadId: load.id,
    loadNumber: load.loadNumber,
    deliveredAt: load.deliveredAt,
    carrierOrgId: load.carrierOrgId,
    businessOrgIds: [load.shipperOrgId, load.brokerOrgId].filter((x): x is string => !!x),
    pickupDriverIds: legs[0]?.driverAccountIds ?? [],
    deliveryDriverIds: legs[legs.length - 1]?.driverAccountIds ?? [],
    driverIds: [...new Set(legs.flatMap((l) => l.driverAccountIds))],
    onTimePickup: late(loaded, pu.window.end, graceMinutes),
    onTimeDelivery: late(arrived, del.window.end, graceMinutes),
    damageFree: !mine.some((x) => x.type === "DAMAGE"),
    exceptionTypes: [...new Set(mine.map((x) => x.type))],
  };
}

export interface ReliabilityScore {
  /** How many shipments are in this window (at most `window`). */
  shipments: number;
  window: number;
  onTimePickupPct: number | null;
  onTimeDeliveryPct: number | null;
  damageFreePct: number | null;
  /** Average of the three rates that have data. */
  score: number | null;
  oldest?: string;
  newest?: string;
}

const pct = (xs: boolean[]): number | null => (xs.length ? Math.round((xs.filter(Boolean).length / xs.length) * 1000) / 10 : null);

/**
 * Score the most recent `window` shipments. Each metric only counts the
 * shipments the subject was responsible for (`pick` decides).
 */
export function scoreWindow(
  outcomes: ShipmentOutcome[],
  window: number,
  pick: { pickup: (o: ShipmentOutcome) => boolean; delivery: (o: ShipmentOutcome) => boolean } = { pickup: () => true, delivery: () => true },
): ReliabilityScore {
  const recent = [...outcomes].sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt)).slice(0, window);
  const onTimePickupPct = pct(recent.filter((o) => pick.pickup(o) && o.onTimePickup !== null).map((o) => o.onTimePickup!));
  const onTimeDeliveryPct = pct(recent.filter((o) => pick.delivery(o) && o.onTimeDelivery !== null).map((o) => o.onTimeDelivery!));
  const damageFreePct = pct(recent.map((o) => o.damageFree));
  const parts = [onTimePickupPct, onTimeDeliveryPct, damageFreePct].filter((x): x is number => x !== null);
  return {
    shipments: recent.length,
    window,
    onTimePickupPct,
    onTimeDeliveryPct,
    damageFreePct,
    score: parts.length ? Math.round((parts.reduce((s, x) => s + x, 0) / parts.length) * 10) / 10 : null,
    oldest: recent[recent.length - 1]?.deliveredAt,
    newest: recent[0]?.deliveredAt,
  };
}

export interface ReliabilityProfile {
  overall: ReliabilityScore;
  /** Score with one business (present when a business was asked for). */
  forBusiness?: ReliabilityScore & { businessOrgId: string };
}

/** A trucker: last 1,000 shipments overall, last 100 per business. */
export function driverReliability(outcomes: ShipmentOutcome[], driverId: string, businessOrgId?: string): ReliabilityProfile {
  const mine = outcomes.filter((o) => o.driverIds.includes(driverId));
  const pick = { pickup: (o: ShipmentOutcome) => o.pickupDriverIds.includes(driverId), delivery: (o: ShipmentOutcome) => o.deliveryDriverIds.includes(driverId) };
  return {
    overall: scoreWindow(mine, DRIVER_OVERALL_WINDOW, pick),
    forBusiness: businessOrgId ? { ...scoreWindow(mine.filter((o) => o.businessOrgIds.includes(businessOrgId)), DRIVER_BUSINESS_WINDOW, pick), businessOrgId } : undefined,
  };
}

/** A carrier: windows grow with its trucker count (see carrierWindows). */
export function carrierReliability(outcomes: ShipmentOutcome[], carrierOrgId: string, truckerCount: number, businessOrgId?: string): ReliabilityProfile {
  const mine = outcomes.filter((o) => o.carrierOrgId === carrierOrgId);
  const w = carrierWindows(truckerCount);
  return {
    overall: scoreWindow(mine, w.overall),
    forBusiness: businessOrgId ? { ...scoreWindow(mine.filter((o) => o.businessOrgIds.includes(businessOrgId)), w.perBusiness), businessOrgId } : undefined,
  };
}

/** Per-business breakdown, busiest relationships first. */
export function reliabilityByBusiness(outcomes: ShipmentOutcome[], window: number, pick?: Parameters<typeof scoreWindow>[2]): Array<ReliabilityScore & { businessOrgId: string }> {
  const ids = new Set(outcomes.flatMap((o) => o.businessOrgIds));
  return [...ids]
    .map((id) => ({ ...scoreWindow(outcomes.filter((o) => o.businessOrgIds.includes(id)), window, pick), businessOrgId: id }))
    .sort((a, b) => b.shipments - a.shipments);
}
