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

/**
 * A business reporting that the carrier missed a pickup or delivery
 * appointment. It is charged to the carrier hauling the load when the
 * appointment was missed, and to the drivers on that leg, even if the load
 * later moves to another carrier. A driver who drives for several carriers
 * never causes a ding for a carrier that was not hauling the load.
 */
export const AppointmentMissKind = z.enum(["LATE", "NO_SHOW"]);
export type AppointmentMissKind = z.infer<typeof AppointmentMissKind>;

export const AppointmentMiss = z.object({
  id: z.string(),
  loadId: z.string(),
  loadNumber: z.string(),
  stopId: z.string(),
  stopType: z.enum(["PICKUP", "DELIVERY"]),
  /** The end of the stop's window: the appointment that was missed. */
  appointmentAt: z.string(),
  kind: AppointmentMissKind,
  minutesLate: z.number().int().positive().optional(),
  note: z.string().max(1000),
  /** Who was hauling when it was missed (see carrierKeyOf). */
  carrierKey: z.string(),
  carrierOrgId: z.string().optional(),
  externalCarrierKey: z.string().optional(),
  driverIds: z.array(z.string()),
  businessOrgIds: z.array(z.string()),
  reportedByAccountId: z.string(),
  reportedByOrgId: z.string(),
  at: z.string(),
  withdrawnAt: z.string().optional(),
  dispute: z.object({ note: z.string().max(1000), accountId: z.string(), at: z.string() }).optional(),
});
export type AppointmentMiss = z.infer<typeof AppointmentMiss>;

/**
 * The carrier accountable for a load. Carriers on the platform are keyed by
 * their org id. Carriers reached only by API or EDI are keyed per business
 * that set up the connection, so they get a score too.
 */
export function carrierKeyOf(load: Pick<Load, "carrierOrgId" | "externalCarrierKey" | "shipperOrgId" | "brokerOrgId">): string | undefined {
  if (load.carrierOrgId) return load.carrierOrgId;
  if (load.externalCarrierKey) return partnerCarrierKey(load.brokerOrgId ?? load.shipperOrgId, load.externalCarrierKey);
  return undefined;
}

export const partnerCarrierKey = (ownerOrgId: string, partnerKey: string) => `partner:${ownerOrgId}:${partnerKey}`;

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
  /** When the shipment ended for this carrier: delivery, or the missed appointment if it never delivered for them. */
  deliveredAt: string;
  carrierOrgId?: string;
  /** See carrierKeyOf; absent on records made before it existed, where carrierOrgId is the key. */
  carrierKey?: string;
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
  /** null when the carrier never delivered the freight (it lost the load after a missed appointment). */
  damageFree: boolean | null;
  exceptionTypes: ExceptionType[];
  /** A business reported a missed pickup or delivery appointment. */
  missedPickup?: boolean;
  missedDelivery?: boolean;
}

const active = (misses: AppointmentMiss[], loadId: string) => misses.filter((m) => m.loadId === loadId && !m.withdrawnAt);

const late = (at: string | undefined, windowEnd: string, graceMin: number): boolean | null =>
  at ? Date.parse(at) <= Date.parse(windowEnd) + graceMin * 60_000 : null;

export function shipmentOutcome(load: Load, exceptions: LoadException[] = [], graceMinutes = ON_TIME_GRACE_MINUTES, misses: AppointmentMiss[] = []): ShipmentOutcome {
  if (!load.deliveredAt) throw new Error("Outcome needs a delivered load");
  const pu = pickupStop(load);
  const del = finalDeliveryStop(load);
  const loaded = load.events.find((e) => e.code === "LOADED")?.at ?? load.pickedUpAt;
  // Arrival is what the appointment measures; fall back to the delivered time.
  const arrived = load.events.find((e) => e.code === "ARRIVED_DELIVERY" && (!e.stopId || e.stopId === del.id))?.at ?? load.deliveredAt;
  const legs = [...load.legs].sort((a, b) => a.sequence - b.sequence);
  const mine = exceptions.filter((x) => x.loadId === load.id);
  const key = carrierKeyOf(load);
  // Only this carrier's missed appointments count here; another carrier's stay with that carrier.
  const missed = active(misses, load.id).filter((m) => m.carrierKey === key);
  const puMiss = missed.find((m) => m.stopType === "PICKUP");
  const delMiss = missed.find((m) => m.stopType === "DELIVERY");
  const before = (windowEnd: string) => !!load.carrierSince && Date.parse(load.carrierSince) > Date.parse(windowEnd);
  const pickupDriverIds = puMiss?.driverIds.length ? puMiss.driverIds : (legs[0]?.driverAccountIds ?? []);
  const deliveryDriverIds = delMiss?.driverIds.length ? delMiss.driverIds : (legs[legs.length - 1]?.driverAccountIds ?? []);
  return {
    loadId: load.id,
    loadNumber: load.loadNumber,
    deliveredAt: load.deliveredAt,
    carrierOrgId: load.carrierOrgId,
    carrierKey: key,
    businessOrgIds: [load.shipperOrgId, load.brokerOrgId].filter((x): x is string => !!x),
    pickupDriverIds,
    deliveryDriverIds,
    driverIds: [...new Set([...legs.flatMap((l) => l.driverAccountIds), ...missed.flatMap((m) => m.driverIds)])],
    // A carrier that took the load after a window closed (a rescue after another carrier's no-show) is not judged on it.
    onTimePickup: puMiss ? false : before(pu.window.end) ? null : late(loaded, pu.window.end, graceMinutes),
    onTimeDelivery: delMiss ? false : before(del.window.end) ? null : late(arrived, del.window.end, graceMinutes),
    damageFree: !mine.some((x) => x.type === "DAMAGE"),
    exceptionTypes: [...new Set(mine.map((x) => x.type))],
    missedPickup: !!puMiss,
    missedDelivery: !!delMiss,
  };
}

/**
 * Outcomes for carriers that missed an appointment on this load but did not
 * deliver it (the load was cancelled or moved to another carrier). Each
 * counts once against that carrier and the drivers it had on the leg.
 */
export function missedAppointmentOutcomes(load: Load, misses: AppointmentMiss[]): ShipmentOutcome[] {
  const delivering = load.deliveredAt && load.status !== "CANCELLED" ? carrierKeyOf(load) : undefined;
  const byCarrier = new Map<string, AppointmentMiss[]>();
  for (const m of active(misses, load.id)) if (m.carrierKey !== delivering) byCarrier.set(m.carrierKey, [...(byCarrier.get(m.carrierKey) ?? []), m]);
  return [...byCarrier.values()].map((ms) => {
    const pu = ms.find((m) => m.stopType === "PICKUP");
    const del = ms.find((m) => m.stopType === "DELIVERY");
    return {
      loadId: load.id,
      loadNumber: load.loadNumber,
      deliveredAt: ms.map((m) => m.appointmentAt).sort().at(-1)!,
      carrierOrgId: ms[0]!.carrierOrgId,
      carrierKey: ms[0]!.carrierKey,
      businessOrgIds: ms[0]!.businessOrgIds,
      pickupDriverIds: pu?.driverIds ?? [],
      deliveryDriverIds: del?.driverIds ?? [],
      driverIds: [...new Set(ms.flatMap((m) => m.driverIds))],
      onTimePickup: pu ? false : null,
      onTimeDelivery: del ? false : null,
      damageFree: null,
      exceptionTypes: [],
      missedPickup: !!pu,
      missedDelivery: !!del,
    };
  });
}

export interface ReliabilityScore {
  /** How many shipments are in this window (at most `window`). */
  shipments: number;
  window: number;
  onTimePickupPct: number | null;
  onTimeDeliveryPct: number | null;
  damageFreePct: number | null;
  /** Pickup and delivery appointments a business reported as missed, in this window. */
  missedAppointments: number;
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
  const damageFreePct = pct(recent.filter((o) => o.damageFree !== null).map((o) => o.damageFree!));
  const missedAppointments = recent.reduce((n, o) => n + (o.missedPickup && pick.pickup(o) ? 1 : 0) + (o.missedDelivery && pick.delivery(o) ? 1 : 0), 0);
  const parts = [onTimePickupPct, onTimeDeliveryPct, damageFreePct].filter((x): x is number => x !== null);
  return {
    shipments: recent.length,
    window,
    onTimePickupPct,
    onTimeDeliveryPct,
    damageFreePct,
    missedAppointments,
    score: parts.length ? Math.round((parts.reduce((s, x) => s + x, 0) / parts.length) * 10) / 10 : null,
    oldest: recent[recent.length - 1]?.deliveredAt,
    newest: recent[0]?.deliveredAt,
  };
}

export interface ReliabilityProfile {
  overall: ReliabilityScore;
  /** Score with one business (present when a business was asked for). */
  forBusiness?: ReliabilityScore & { businessOrgId: string };
  /** A driver's shipments for one carrier (present when a carrier was asked for). */
  forCarrier?: ReliabilityScore & { carrierKey: string };
}

const carrierOf = (o: ShipmentOutcome) => o.carrierKey ?? o.carrierOrgId;

/**
 * A trucker: last 1,000 shipments overall, last 100 per business. A trucker
 * who drives for several carriers has one record; `carrierKey` narrows it to
 * the shipments hauled for one of them.
 */
export function driverReliability(outcomes: ShipmentOutcome[], driverId: string, businessOrgId?: string, carrierKey?: string): ReliabilityProfile {
  const mine = outcomes.filter((o) => o.driverIds.includes(driverId));
  const pick = { pickup: (o: ShipmentOutcome) => o.pickupDriverIds.includes(driverId), delivery: (o: ShipmentOutcome) => o.deliveryDriverIds.includes(driverId) };
  return {
    overall: scoreWindow(mine, DRIVER_OVERALL_WINDOW, pick),
    forBusiness: businessOrgId ? { ...scoreWindow(mine.filter((o) => o.businessOrgIds.includes(businessOrgId)), DRIVER_BUSINESS_WINDOW, pick), businessOrgId } : undefined,
    forCarrier: carrierKey ? { ...scoreWindow(mine.filter((o) => carrierOf(o) === carrierKey), DRIVER_OVERALL_WINDOW, pick), carrierKey } : undefined,
  };
}

/**
 * A carrier: windows grow with its trucker count (see carrierWindows). Only
 * shipments this carrier hauled count, so a trucker shared with another
 * carrier never moves this carrier's score with the other carrier's loads.
 */
export function carrierReliability(outcomes: ShipmentOutcome[], carrierKey: string, truckerCount: number, businessOrgId?: string): ReliabilityProfile {
  const mine = outcomes.filter((o) => carrierOf(o) === carrierKey);
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
