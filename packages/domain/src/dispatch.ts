import { z } from "zod";
import { Address, DomainError, GeoPoint, newId } from "./common.js";
import { estimatedRoadMiles, haversineMiles } from "./geo.js";
import type { DistributionCenter } from "./organization.js";
import { type Leg, type Load, type Stop, finalDeliveryStop, pickupStop, totalWeightLb } from "./load.js";

const PLANNABLE = ["BOOKED", "DISPATCHED"];

/** Build sequential legs over the load's stops: stop[i] -> stop[i+1]. */
export function legsForStops(stops: Stop[], existing: Leg[] = []): Leg[] {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);
  const legs: Leg[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i]!;
    const to = ordered[i + 1]!;
    const prior = existing.find((l) => l.fromStopId === from.id && l.toStopId === to.id);
    legs.push(prior ? { ...prior, sequence: i + 1 } : { id: newId("leg"), sequence: i + 1, fromStopId: from.id, toStopId: to.id, driverAccountIds: [], status: "PLANNED" });
  }
  return legs;
}

/**
 * A driver handoff happens only at RELAY or CROSS_DOCK stops. Intermediate
 * pickups and drops on a multi-stop load stay on the same truck, so legs are
 * cut at handoff points rather than at every stop.
 */
export function handoffLegs(stops: Stop[], existing: Leg[] = []): Leg[] {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);
  const cuts = ordered.filter((s, i) => i === 0 || i === ordered.length - 1 || s.type === "RELAY" || s.type === "CROSS_DOCK");
  return legsForStops(cuts, existing);
}

export const RelayPoint = z.object({
  address: Address,
  /** Insert after the stop with this sequence number (defaults to just before final delivery). */
  afterSequence: z.number().int().positive().optional(),
  window: z.object({ start: z.string(), end: z.string() }).optional(),
});
export type RelayPoint = z.infer<typeof RelayPoint>;

/**
 * Break the transportation into relay legs (e.g. New York -> Nashville swap -> Houston).
 * Each relay point becomes an intermediate stop where the trucker changes.
 */
export function planRelay(load: Load, points: RelayPoint[], now = new Date().toISOString()): Load {
  if (!PLANNABLE.includes(load.status)) {
    throw new DomainError("NOT_PLANNABLE", `Relays are planned on booked loads before pickup (load is ${load.status})`, 409);
  }
  if (points.length === 0) throw new DomainError("NO_RELAYS", "Provide at least one relay point");
  let stops = load.stops.filter((s) => s.type !== "RELAY").sort((a, b) => a.sequence - b.sequence);
  for (const p of points) {
    const idx = p.afterSequence !== undefined ? stops.findIndex((s) => s.sequence === p.afterSequence) + 1 : stops.length - 1;
    if (idx < 1 || idx > stops.length - 1) throw new DomainError("BAD_RELAY", "Relay must come after the pickup and before final delivery");
    const prev = stops[idx - 1]!;
    const relay: Stop = {
      id: newId("stop"),
      sequence: 0,
      type: "RELAY",
      address: p.address,
      window: p.window ?? prev.window,
      instructions: "Driver relay: hand off trailer and paperwork to the next driver.",
    };
    stops = [...stops.slice(0, idx), relay, ...stops.slice(idx)];
    stops = stops.map((s, i) => ({ ...s, sequence: i + 1 }));
  }
  return { ...load, stops, legs: handoffLegs(stops, load.legs), version: load.version + 1, updatedAt: now };
}

export interface LegAssignment {
  driverAccountIds: string[];
  tractorId?: string;
  trailerId?: string;
}

/** Assign one driver, or two for a team. Team-required loads reject solo assignments. */
export function assignLeg(load: Load, legId: string, a: LegAssignment, now = new Date().toISOString()): Load {
  const legs = load.legs.length ? load.legs : handoffLegs(load.stops);
  const leg = legs.find((l) => l.id === legId);
  if (!leg) throw new DomainError("LEG_NOT_FOUND", `Leg ${legId} not found`, 404);
  if (leg.status === "COMPLETED") throw new DomainError("LEG_DONE", "Leg is already completed", 409);
  const drivers = [...new Set(a.driverAccountIds)];
  if (drivers.length < 1 || drivers.length > 2) throw new DomainError("BAD_TEAM", "A leg takes one driver or a two-driver team");
  if ((load.teamRequired || load.service === "TEAM_EXPEDITED") && drivers.length !== 2) {
    throw new DomainError("TEAM_REQUIRED", "This expedited load requires a two-driver team");
  }
  const updated = legs.map((l) => (l.id === legId ? { ...l, driverAccountIds: drivers, tractorId: a.tractorId, trailerId: a.trailerId, status: l.status === "PLANNED" ? ("ASSIGNED" as const) : l.status } : l));
  return { ...load, legs: updated, version: load.version + 1, updatedAt: now };
}

export interface TransitEstimate {
  miles: number;
  drivingHours: number;
  totalHours: number;
  restBreaks: number;
  team: boolean;
}

/**
 * FMCSA hours-of-service approximation for property carriers:
 * 11h driving per duty period, a 30-minute break after 8h driving, 10h off duty
 * between periods. A team keeps the truck moving while one driver rests.
 */
export function estimateTransit(miles: number, opts: { team?: boolean; avgMph?: number; stopHours?: number } = {}): TransitEstimate {
  const mph = opts.avgMph ?? 50;
  const drivingHours = miles / mph;
  const stopHours = opts.stopHours ?? 0;
  if (opts.team) {
    // Swap every ~10h with a short changeover; no 10h reset needed for the truck.
    const swaps = Math.max(0, Math.ceil(drivingHours / 10) - 1);
    return { miles, drivingHours, totalHours: drivingHours + swaps * 0.25 + stopHours, restBreaks: swaps, team: true };
  }
  const periods = Math.max(1, Math.ceil(drivingHours / 11));
  const resets = periods - 1;
  const lastPeriod = drivingHours - resets * 11;
  const thirtyMinBreaks = resets * 1 + (lastPeriod > 8 ? 1 : 0);
  const totalHours = drivingHours + resets * 10 + thirtyMinBreaks * 0.5 + stopHours;
  return { miles, drivingHours, totalHours, restBreaks: resets + thirtyMinBreaks, team: false };
}

export function loadMiles(load: Pick<Load, "stops">): number {
  const ordered = [...load.stops].sort((a, b) => a.sequence - b.sequence);
  let miles = 0;
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i]!.address.geo;
    const b = ordered[i + 1]!.address.geo;
    if (!a || !b) throw new DomainError("NO_GEO", "Every stop needs coordinates to estimate miles");
    miles += estimatedRoadMiles(a, b);
  }
  return miles;
}

// ---------------------------------------------------------------------------
// LTL consolidation through a distribution center
// ---------------------------------------------------------------------------

export interface ConsolidationOptions {
  maxWeightLb?: number;
  maxLinearFt?: number;
  now?: string;
}

export interface ConsolidatedTrailer {
  id: string;
  destinationZip3: string;
  loadIds: string[];
  weightLb: number;
  linearFt: number;
  deliverySequence: string[];
}

export interface ConsolidationPlan {
  id: string;
  dcId: string;
  carrierOrgId: string;
  trailers: ConsolidatedTrailer[];
  loads: Load[];
}

/** Standard 48"x40" pallets load two across, so each pair uses ~4 linear feet. */
export function linearFeet(load: Pick<Load, "items">): number {
  let ft = 0;
  for (const item of load.items) {
    if (item.dimsIn) {
      const perRow = item.dimsIn.width <= 50 ? 2 : 1;
      ft += Math.ceil(item.pieces / perRow) * (item.dimsIn.length / 12);
    } else if (item.packaging === "PLT" || item.packaging === "SKD") {
      ft += Math.ceil(item.pieces / 2) * 4;
    } else {
      ft += Math.max(1, item.weightLb / 1000);
    }
  }
  return Math.round(ft * 10) / 10;
}

/**
 * Route several LTL/partial loads through one of the carrier's distribution
 * centers and combine those headed to the same area (3-digit ZIP) onto shared
 * linehaul trailers. Each load gets a pickup->DC leg and a DC->delivery leg.
 */
export function planConsolidation(loads: Load[], dc: DistributionCenter, carrierOrgId: string, opts: ConsolidationOptions = {}): ConsolidationPlan {
  const maxWeight = opts.maxWeightLb ?? 44_000;
  const maxFt = opts.maxLinearFt ?? 53;
  const now = opts.now ?? new Date().toISOString();
  if (loads.length < 2) throw new DomainError("TOO_FEW", "Consolidation needs at least two loads");
  for (const l of loads) {
    if (l.mode === "FTL") throw new DomainError("NOT_LTL", `Load ${l.loadNumber} is FTL; only LTL/partial loads consolidate`);
    if (l.carrierOrgId !== carrierOrgId) throw new DomainError("NOT_YOURS", `Load ${l.loadNumber} is not booked to this carrier`, 403);
    if (l.pickedUpAt) throw new DomainError("ALREADY_PICKED_UP", `Load ${l.loadNumber} is already picked up`, 409);
    if (l.stops.filter((s) => s.type === "DELIVERY").length !== 1) throw new DomainError("MULTI_DROP", `Load ${l.loadNumber} has multiple deliveries`);
    if (l.oversize) throw new DomainError("OVERSIZE", `Load ${l.loadNumber} is oversize and moves on its own permit`);
  }

  const byZip3 = new Map<string, Load[]>();
  for (const l of loads) {
    const zip3 = finalDeliveryStop(l).address.postalCode.slice(0, 3);
    byZip3.set(zip3, [...(byZip3.get(zip3) ?? []), l]);
  }

  const planId = newId("cons");
  const trailers: ConsolidatedTrailer[] = [];
  for (const [zip3, group] of byZip3) {
    // First-fit decreasing by weight.
    const sorted = [...group].sort((a, b) => totalWeightLb(b) - totalWeightLb(a));
    const bins: ConsolidatedTrailer[] = [];
    for (const l of sorted) {
      const w = totalWeightLb(l);
      const ft = linearFeet(l);
      if (w > maxWeight || ft > maxFt) throw new DomainError("TOO_BIG", `Load ${l.loadNumber} exceeds a single trailer`);
      let bin = bins.find((b) => b.weightLb + w <= maxWeight && b.linearFt + ft <= maxFt);
      if (!bin) {
        bin = { id: newId("trl"), destinationZip3: zip3, loadIds: [], weightLb: 0, linearFt: 0, deliverySequence: [] };
        bins.push(bin);
      }
      bin.loadIds.push(l.id);
      bin.weightLb += w;
      bin.linearFt = Math.round((bin.linearFt + ft) * 10) / 10;
    }
    for (const bin of bins) bin.deliverySequence = nearestNeighbor(dc.geo, bin.loadIds.map((id) => group.find((g) => g.id === id)!));
    trailers.push(...bins);
  }

  const updated = loads.map((l) => {
    const pu = pickupStop(l);
    const del = finalDeliveryStop(l);
    const trailer = trailers.find((t) => t.loadIds.includes(l.id))!;
    const dock: Stop = {
      id: newId("stop"),
      sequence: 2,
      type: "CROSS_DOCK",
      address: { ...dc.address, geo: dc.geo },
      window: pu.window,
      instructions: `Cross-dock at ${dc.name}; outbound on trailer ${trailer.id} to ${trailer.destinationZip3}xx.`,
    };
    const stops: Stop[] = [{ ...pu, sequence: 1 }, dock, { ...del, sequence: 3 }];
    const legs = handoffLegs(stops).map((leg) => (leg.sequence === 2 ? { ...leg, consolidationId: planId, trailerId: trailer.id } : { ...leg, consolidationId: planId }));
    return { ...l, stops, legs, version: l.version + 1, updatedAt: now };
  });
  return { id: planId, dcId: dc.id, carrierOrgId, trailers, loads: updated };
}

function nearestNeighbor(start: GeoPoint, loads: Load[]): string[] {
  const remaining = [...loads];
  const order: string[] = [];
  let here = start;
  while (remaining.length) {
    let best = 0;
    let bestD = Infinity;
    remaining.forEach((l, i) => {
      const g = finalDeliveryStop(l).address.geo;
      const d = g ? haversineMiles(here, g) : Infinity;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const [next] = remaining.splice(best, 1);
    order.push(next!.id);
    here = finalDeliveryStop(next!).address.geo ?? here;
  }
  return order;
}


