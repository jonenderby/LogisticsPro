import { z } from "zod";
import type { GeoPoint } from "./common.js";
import { haversineMeters } from "./geo.js";
import { formatMinutes } from "./hos.js";
import { type Load, type Stop } from "./load.js";

/** When the truck reached and left a stop, from its location. */
export type StopVisit = NonNullable<Load["visits"]>[number];

/** A carrier's detention terms: free time at each stop, then an hourly rate. */
export const DetentionTerms = z.object({
  freeHours: z.number().min(0).max(24).default(2),
  ratePerHour: z.number().min(0).max(1000).default(75),
  /** Billable time is rounded up to this many minutes. */
  roundToMinutes: z.number().int().min(1).max(60).default(15),
});
export type DetentionTerms = z.infer<typeof DetentionTerms>;
export const DEFAULT_DETENTION: DetentionTerms = { freeHours: 2, ratePerHour: 75, roundToMinutes: 15 };

/** Inside this distance the truck is at the stop; it has left beyond the larger one. */
export const ARRIVE_METERS = 800;
export const DEPART_METERS = 1_600;
/** Arriving later than this after the window closes forfeits detention. */
const LATE_GRACE_MIN = 15;
const MIN = 60_000;

export interface StopDetention {
  stopId: string;
  type: Stop["type"];
  name: string;
  city: string;
  arrivedAt?: string;
  departedAt?: string;
  /** Whether the time came from the truck's location or the driver's taps. */
  source?: StopVisit["source"];
  /** When the detention clock started: the appointment, or arrival if later. */
  clockStartAt?: string;
  /** Still at the stop. */
  atStop: boolean;
  /** Minutes over the free time, rounded up; 0 when none is owed. */
  billableMinutes: number;
  amount: number;
  /** Why none is owed (arrived late, no arrival recorded). */
  note?: string;
}

/**
 * Arrival and departure at each stop: the truck's location first, the
 * driver's taps (Arrived, Loaded, Delivered) where the location has none.
 */
export function stopTimes(load: Load): Map<string, { arrivedAt?: string; departedAt?: string; source?: StopVisit["source"] }> {
  const out = new Map<string, { arrivedAt?: string; departedAt?: string; source?: StopVisit["source"] }>();
  const ordered = [...load.stops].sort((a, b) => a.sequence - b.sequence);
  const firstPickup = ordered.find((s) => s.type === "PICKUP");
  const lastDelivery = [...ordered].reverse().find((s) => s.type === "DELIVERY");
  const event = (codes: string[], stop: Stop, fallback: boolean) => load.events.find((e) => codes.includes(e.code) && (e.stopId ? e.stopId === stop.id : fallback))?.at;
  for (const s of ordered) {
    const v = load.visits?.find((x) => x.stopId === s.id);
    const isFirstPickup = s === firstPickup;
    const isLastDelivery = s === lastDelivery;
    const arrivedTap = event(s.type === "PICKUP" ? ["ARRIVED_PICKUP"] : ["ARRIVED_DELIVERY"], s, isFirstPickup || isLastDelivery);
    const departedTap = event(s.type === "PICKUP" ? ["LOADED"] : ["DELIVERED"], s, isFirstPickup || isLastDelivery);
    out.set(s.id, { arrivedAt: v?.arrivedAt ?? arrivedTap, departedAt: v?.departedAt ?? departedTap, source: v ? "GEOFENCE" : arrivedTap ? "STATUS" : undefined });
  }
  return out;
}

export function detention(load: Load, terms: DetentionTerms = DEFAULT_DETENTION, nowIso: string): StopDetention[] {
  const now = Date.parse(nowIso);
  const times = stopTimes(load);
  return [...load.stops]
    .sort((a, b) => a.sequence - b.sequence)
    .filter((s) => s.type === "PICKUP" || s.type === "DELIVERY")
    .map((s) => {
      const t = times.get(s.id) ?? {};
      const base: StopDetention = { stopId: s.id, type: s.type, name: s.address.name, city: `${s.address.city}, ${s.address.state}`, arrivedAt: t.arrivedAt, departedAt: t.departedAt, source: t.source, atStop: !!t.arrivedAt && !t.departedAt, billableMinutes: 0, amount: 0 };
      if (!t.arrivedAt) return base;
      if (Date.parse(t.arrivedAt) > Date.parse(s.window.end) + LATE_GRACE_MIN * MIN) return { ...base, note: "Arrived after the appointment, so detention does not apply" };
      const start = Math.max(Date.parse(t.arrivedAt), Date.parse(s.window.start));
      const end = t.departedAt ? Date.parse(t.departedAt) : now;
      const over = (end - start) / MIN - terms.freeHours * 60;
      const billable = over > 0 ? Math.ceil(over / terms.roundToMinutes) * terms.roundToMinutes : 0;
      return { ...base, clockStartAt: new Date(start).toISOString(), billableMinutes: billable, amount: Math.round((billable / 60) * terms.ratePerHour * 100) / 100 };
    });
}

/** Invoice lines for detention owed, one per stop. */
export function detentionLines(rows: StopDetention[], terms: DetentionTerms): Array<{ code: "DETENTION"; description: string; quantity: number; rate: number; amount: number }> {
  return rows
    .filter((r) => r.billableMinutes > 0 && !r.atStop)
    .map((r) => ({ code: "DETENTION" as const, description: `Detention ${r.city}`.slice(0, 30), quantity: Math.round((r.billableMinutes / 60) * 100) / 100, rate: terms.ratePerHour, amount: r.amount }));
}

/**
 * Update stop visits from one location fix: arriving within 800 m of the
 * next stops, leaving beyond 1,600 m (so GPS jitter at the dock does not
 * flap). Returns the visits and what changed, or undefined when nothing did.
 */
export function updateVisits(load: Load, fix: { geo: GeoPoint; at: string }): { visits: StopVisit[]; arrived?: Stop; departed?: Stop } | undefined {
  const visits = [...(load.visits ?? [])];
  const open = visits.find((v) => !v.departedAt);
  if (open) {
    const stop = load.stops.find((s) => s.id === open.stopId);
    if (stop?.address.geo && haversineMeters(stop.address.geo, fix.geo) > DEPART_METERS) {
      visits[visits.indexOf(open)] = { ...open, departedAt: fix.at };
      return { visits, departed: stop };
    }
    return undefined;
  }
  const visited = new Set(visits.map((v) => v.stopId));
  const candidate = [...load.stops]
    .sort((a, b) => a.sequence - b.sequence)
    .find((s) => !visited.has(s.id) && s.address.geo && haversineMeters(s.address.geo, fix.geo) <= ARRIVE_METERS);
  if (!candidate) return undefined;
  visits.push({ stopId: candidate.id, arrivedAt: fix.at, source: "GEOFENCE" });
  return { visits, arrived: candidate };
}

export const describeDetention = (r: StopDetention) => (r.billableMinutes ? `${formatMinutes(r.billableMinutes)} detention, $${r.amount.toFixed(2)}` : r.note ?? "");
