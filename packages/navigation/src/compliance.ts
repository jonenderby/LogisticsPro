import { type GeoPoint, type Permit, haversineMeters } from "@logisticspro/domain";
import { prepareLine, snapToLine } from "./geometry.js";
import type { TruckProfile } from "./route.js";
import { isDaylightTravel, isWeekendLocal } from "./sun.js";

export type RestrictionType = "LOW_CLEARANCE" | "WEIGHT_LIMIT" | "WIDTH_LIMIT" | "LENGTH_LIMIT" | "NO_OVERSIZE" | "CONSTRUCTION";

export interface Restriction {
  id: string;
  type: RestrictionType;
  at: GeoPoint;
  /** Inches for clearance/width/length, pounds for weight. */
  limit?: number;
  description: string;
}

export interface Conflict {
  kind: "PERMIT_NOT_VALID" | "PERMIT_GAP" | "RESTRICTION" | "DAYLIGHT_ONLY" | "NO_WEEKEND_TRAVEL";
  message: string;
  permitNumber?: string;
  restrictionId?: string;
  at?: GeoPoint;
}

/** Height clearance buffer drivers are trained to keep (3 inches). */
export const CLEARANCE_BUFFER_IN = 3;

/** Does the truck physically clear this restriction? */
export function clears(r: Restriction, t: TruckProfile): boolean {
  switch (r.type) {
    case "LOW_CLEARANCE":
      return r.limit === undefined || t.heightIn + CLEARANCE_BUFFER_IN <= r.limit;
    case "WEIGHT_LIMIT":
      return r.limit === undefined || t.grossWeightLb <= r.limit;
    case "WIDTH_LIMIT":
      return r.limit === undefined || t.widthIn <= r.limit;
    case "LENGTH_LIMIT":
      return r.limit === undefined || t.lengthIn <= r.limit;
    case "NO_OVERSIZE":
      return false;
    case "CONSTRUCTION":
      return r.limit === undefined || t.widthIn <= r.limit;
  }
}

/** Join permit routes (in order) into the single mandatory corridor. */
export function corridorFromPermits(permits: Permit[]): GeoPoint[] {
  const out: GeoPoint[] = [];
  for (const p of permits) {
    const pts = out.length && haversineMeters(out[out.length - 1]!, p.route[0]!) < 1 ? p.route.slice(1) : p.route;
    out.push(...pts);
  }
  return out;
}

export interface TripCheck {
  ok: boolean;
  corridor: GeoPoint[];
  conflicts: Conflict[];
  escortsRequired: number;
}

/**
 * Pre-trip check for an oversize/overweight move: every permit valid at
 * departure, permits chain without gaps, no restriction on the corridor the
 * load cannot clear, and departure inside the permitted travel window.
 */
export function checkOversizeTrip(input: { permits: Permit[]; truck: TruckProfile; restrictions: Restriction[]; departAt: string; corridorHalfWidthM?: number }): TripCheck {
  const conflicts: Conflict[] = [];
  const depart = new Date(input.departAt);
  if (input.permits.length === 0) {
    return { ok: false, corridor: [], conflicts: [{ kind: "PERMIT_NOT_VALID", message: "Oversize loads need at least one state permit with a route" }], escortsRequired: 0 };
  }
  input.permits.forEach((p, i) => {
    if (depart < new Date(p.validFrom) || depart > new Date(p.validTo)) {
      conflicts.push({ kind: "PERMIT_NOT_VALID", permitNumber: p.permitNumber, message: `${p.state} permit ${p.permitNumber} is valid ${p.validFrom} to ${p.validTo}` });
    }
    const next = input.permits[i + 1];
    if (next) {
      const gap = haversineMeters(p.route[p.route.length - 1]!, next.route[0]!);
      if (gap > 500) conflicts.push({ kind: "PERMIT_GAP", permitNumber: next.permitNumber, message: `${Math.round(gap)} m gap between the ${p.state} and ${next.state} permit routes` });
    }
  });
  const corridor = corridorFromPermits(input.permits);
  const line = prepareLine(corridor);
  const half = input.corridorHalfWidthM ?? 30;
  for (const r of input.restrictions) {
    const snap = snapToLine(line, r.at);
    if (snap.offsetM > half + 20) continue;
    if (!clears(r, input.truck)) {
      conflicts.push({ kind: "RESTRICTION", restrictionId: r.id, at: r.at, message: `${r.description} is on the permitted route and the load does not clear it` });
    }
  }
  const first = input.permits[0]!;
  if (input.permits.some((p) => p.daylightOnly) && !isDaylightTravel(depart, first.route[0]!)) {
    conflicts.push({ kind: "DAYLIGHT_ONLY", message: "Permit allows daylight travel only (30 min before sunrise to 30 min after sunset)" });
  }
  if (input.permits.some((p) => p.noWeekends) && isWeekendLocal(depart, first.route[0]!)) {
    conflicts.push({ kind: "NO_WEEKEND_TRAVEL", message: "Permit does not allow weekend travel" });
  }
  return { ok: conflicts.length === 0, corridor, conflicts, escortsRequired: Math.max(0, ...input.permits.map((p) => p.escortsRequired)) };
}
