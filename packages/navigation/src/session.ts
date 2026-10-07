import { type GeoPoint, type Permit, haversineMeters } from "@logisticspro/domain";
import { type Restriction, clears, corridorFromPermits } from "./compliance.js";
import { type PreparedLine, bearingDeg, pointAlong, prepareLine, snapToLine } from "./geometry.js";
import type { Maneuver, Route, TruckProfile } from "./route.js";
import { isDaylightTravel } from "./sun.js";

export interface GpsFix {
  lat: number;
  lng: number;
  at: string;
  speedMps?: number;
  accuracyM?: number;
}

export type NavEvent =
  | { type: "MANEUVER_APPROACHING"; maneuver: Maneuver; distanceM: number }
  | { type: "OFF_ROUTE"; deviationM: number }
  | { type: "REROUTE_REQUIRED"; from: GeoPoint }
  | { type: "BACK_ON_ROUTE" }
  | { type: "ARRIVED" }
  | { type: "CORRIDOR_WARNING"; deviationM: number; halfWidthM: number }
  | { type: "CORRIDOR_VIOLATION"; deviationM: number; notify: Array<"DISPATCH" | "ESCORT">; guidance: Guidance }
  | { type: "RETURNED_TO_CORRIDOR"; outsideForS: number }
  | { type: "WRONG_DIRECTION" }
  | { type: "RESTRICTION_AHEAD"; restriction: Restriction; distanceM: number; clears: boolean }
  | { type: "TRAVEL_WINDOW_CLOSED"; reason: string };

export interface Guidance {
  target: GeoPoint;
  bearingDeg: number;
  distanceM: number;
}

export interface NavState {
  mode: "STANDARD" | "OVERSIZE";
  status: "ON_ROUTE" | "OFF_ROUTE" | "DRIFTING" | "OFF_CORRIDOR" | "ARRIVED";
  snapped: GeoPoint;
  alongM: number;
  remainingM: number;
  etaS: number;
  deviationM: number;
  nextManeuver?: Maneuver;
  distanceToManeuverM?: number;
  guidance?: Guidance;
  events: NavEvent[];
}

abstract class BaseSession {
  protected line: PreparedLine;
  protected lastSegment = 0;
  protected maxAlong = 0;
  protected announced = new Set<string>();
  protected arrived = false;

  constructor(
    protected route: Route,
    protected readonly arriveM = 60,
  ) {
    this.line = prepareLine(route.geometry);
  }

  protected avgSpeedMps(): number {
    return this.route.durationS > 0 ? this.route.distanceM / this.route.durationS : 22;
  }

  protected maneuverInfo(alongM: number, events: NavEvent[]): Pick<NavState, "nextManeuver" | "distanceToManeuverM"> {
    const next = this.route.maneuvers.find((m) => (this.line.cumulative[Math.min(m.shapeIndex, this.line.cumulative.length - 1)] ?? 0) > alongM + 5);
    if (!next) return {};
    const dist = this.line.cumulative[Math.min(next.shapeIndex, this.line.cumulative.length - 1)]! - alongM;
    for (const threshold of [800, 150]) {
      const key = `m:${next.shapeIndex}:${threshold}`;
      if (dist <= threshold && !this.announced.has(key)) {
        this.announced.add(key);
        events.push({ type: "MANEUVER_APPROACHING", maneuver: next, distanceM: Math.round(dist) });
        break;
      }
    }
    return { nextManeuver: next, distanceToManeuverM: Math.round(dist) };
  }

  protected checkArrival(alongM: number, deviationM: number, events: NavEvent[]): boolean {
    if (!this.arrived && this.line.lengthM - alongM <= this.arriveM && deviationM <= this.arriveM * 2) {
      this.arrived = true;
      events.push({ type: "ARRIVED" });
    }
    return this.arrived;
  }
}

/**
 * Turn-by-turn on a truck-legal route. Leaving the route for several fixes
 * asks the app to fetch a new route from the routing provider.
 */
export class StandardNavigationSession extends BaseSession {
  private offCount = 0;
  private rerouteRequested = false;

  constructor(
    route: Route,
    private readonly opts: { offRouteM?: number; confirmFixes?: number; arriveM?: number } = {},
  ) {
    super(route, opts.arriveM);
  }

  replaceRoute(route: Route): void {
    this.route = route;
    this.line = prepareLine(route.geometry);
    this.lastSegment = 0;
    this.maxAlong = 0;
    this.offCount = 0;
    this.rerouteRequested = false;
    this.announced.clear();
  }

  update(fix: GpsFix): NavState {
    const events: NavEvent[] = [];
    const p = { lat: fix.lat, lng: fix.lng };
    const snap = snapToLine(this.line, p, this.lastSegment);
    const tolerance = Math.max(this.opts.offRouteM ?? 60, (fix.accuracyM ?? 0) * 1.5);
    let status: NavState["status"] = "ON_ROUTE";
    if (snap.offsetM > tolerance) {
      this.offCount++;
      status = "OFF_ROUTE";
      if (this.offCount === 1) events.push({ type: "OFF_ROUTE", deviationM: Math.round(snap.offsetM) });
      if (this.offCount >= (this.opts.confirmFixes ?? 3) && !this.rerouteRequested) {
        this.rerouteRequested = true;
        events.push({ type: "REROUTE_REQUIRED", from: p });
      }
    } else {
      if (this.offCount > 0) events.push({ type: "BACK_ON_ROUTE" });
      this.offCount = 0;
      this.rerouteRequested = false;
      this.lastSegment = snap.segment;
      this.maxAlong = Math.max(this.maxAlong, snap.alongM);
    }
    const along = status === "ON_ROUTE" ? snap.alongM : this.maxAlong;
    if (this.checkArrival(along, snap.offsetM, events)) status = "ARRIVED";
    const remaining = Math.max(0, this.line.lengthM - along);
    const speed = fix.speedMps && fix.speedMps > 3 ? (fix.speedMps + this.avgSpeedMps()) / 2 : this.avgSpeedMps();
    return { mode: "STANDARD", status, snapped: snap.point, alongM: Math.round(along), remainingM: Math.round(remaining), etaS: Math.round(remaining / speed), deviationM: Math.round(snap.offsetM), ...this.maneuverInfo(along, events), events };
  }
}

export interface Violation {
  startedAt: string;
  endedAt?: string;
  maxDeviationM: number;
  firstPoint: GeoPoint;
}

/**
 * Strict navigation for oversize/overweight loads. The permitted route is the
 * only route: there is no rerouting. The truck must stay inside a corridor
 * around it; drifting warns the driver, leaving it is a logged violation that
 * notifies dispatch (and escorts) and guides the driver back to the route.
 */
export class OversizeNavigationSession extends BaseSession {
  private readonly halfWidth: number;
  private readonly warnAt: number;
  private outsideSince?: string;
  private wrongWayCount = 0;
  private windowClosed = false;
  private readonly restrictionsAlong: Array<{ r: Restriction; alongM: number }>;
  readonly violations: Violation[] = [];
  private readonly permits: Permit[];

  constructor(
    permits: Permit[],
    private readonly truck: TruckProfile,
    private readonly opts: { corridorHalfWidthM?: number; warnRatio?: number; restrictions?: Restriction[]; lookaheadM?: number; escorts?: number; mph?: number } = {},
  ) {
    const geometry = corridorFromPermits(permits);
    const tmp = prepareLine(geometry);
    const mps = (opts.mph ?? 45) * 0.44704;
    super({ geometry, distanceM: tmp.lengthM, durationS: tmp.lengthM / mps, maneuvers: [{ shapeIndex: geometry.length - 1, instruction: "Arrive at permitted destination", type: "arrive" }], source: "permit" });
    this.permits = permits;
    this.halfWidth = opts.corridorHalfWidthM ?? 30;
    this.warnAt = this.halfWidth * (opts.warnRatio ?? 0.6);
    this.restrictionsAlong = (opts.restrictions ?? [])
      .map((r) => ({ r, snap: snapToLine(this.line, r.at) }))
      .filter((x) => x.snap.offsetM <= this.halfWidth + 20)
      .map((x) => ({ r: x.r, alongM: x.snap.alongM }))
      .sort((a, b) => a.alongM - b.alongM);
  }

  private guidance(from: GeoPoint): Guidance {
    // Rejoin slightly ahead of the furthest permitted progress, never behind it.
    const target = pointAlong(this.line, this.maxAlong + 50);
    return { target, bearingDeg: Math.round(bearingDeg(from, target)), distanceM: Math.round(haversineMeters(from, target)) };
  }

  update(fix: GpsFix): NavState {
    const events: NavEvent[] = [];
    const p = { lat: fix.lat, lng: fix.lng };
    const snap = snapToLine(this.line, p, this.lastSegment);
    // GPS error eats into the corridor only up to a point; a 20 m fix error is not a violation by itself.
    const effective = Math.max(0, snap.offsetM - Math.min(fix.accuracyM ?? 0, 15));
    let status: NavState["status"] = "ON_ROUTE";
    let guidance: Guidance | undefined;

    if (effective > this.halfWidth) {
      status = "OFF_CORRIDOR";
      guidance = this.guidance(p);
      if (!this.outsideSince) {
        this.outsideSince = fix.at;
        this.violations.push({ startedAt: fix.at, maxDeviationM: Math.round(snap.offsetM), firstPoint: p });
        events.push({ type: "CORRIDOR_VIOLATION", deviationM: Math.round(snap.offsetM), notify: (this.opts.escorts ?? 0) > 0 ? ["DISPATCH", "ESCORT"] : ["DISPATCH"], guidance });
      } else {
        const v = this.violations[this.violations.length - 1]!;
        v.maxDeviationM = Math.max(v.maxDeviationM, Math.round(snap.offsetM));
      }
    } else {
      if (this.outsideSince) {
        const v = this.violations[this.violations.length - 1]!;
        v.endedAt = fix.at;
        events.push({ type: "RETURNED_TO_CORRIDOR", outsideForS: Math.round((Date.parse(fix.at) - Date.parse(this.outsideSince)) / 1000) });
        this.outsideSince = undefined;
      }
      if (effective > this.warnAt) {
        status = "DRIFTING";
        events.push({ type: "CORRIDOR_WARNING", deviationM: Math.round(snap.offsetM), halfWidthM: this.halfWidth });
      }
      // Wrong way: progress keeps going backwards along the permitted route.
      if (snap.alongM < this.maxAlong - 150) {
        this.wrongWayCount++;
        if (this.wrongWayCount === 2) events.push({ type: "WRONG_DIRECTION" });
      } else {
        this.wrongWayCount = 0;
      }
      this.lastSegment = snap.segment;
      this.maxAlong = Math.max(this.maxAlong, snap.alongM);
    }

    const along = this.maxAlong;
    for (const { r, alongM } of this.restrictionsAlong) {
      const d = alongM - along;
      const key = `r:${r.id}`;
      if (d > 0 && d <= (this.opts.lookaheadM ?? 8000) && !this.announced.has(key)) {
        this.announced.add(key);
        events.push({ type: "RESTRICTION_AHEAD", restriction: r, distanceM: Math.round(d), clears: clears(r, this.truck) });
      }
    }

    const daylightOnly = this.permits.some((x) => x.daylightOnly);
    if (daylightOnly) {
      const ok = isDaylightTravel(new Date(fix.at), p);
      if (!ok && !this.windowClosed) events.push({ type: "TRAVEL_WINDOW_CLOSED", reason: "Permit allows daylight travel only; find a safe place to park." });
      this.windowClosed = !ok;
    }

    if (status !== "OFF_CORRIDOR" && this.checkArrival(along, snap.offsetM, events)) status = "ARRIVED";
    const remaining = Math.max(0, this.line.lengthM - along);
    const speed = fix.speedMps && fix.speedMps > 3 ? fix.speedMps : this.avgSpeedMps();
    return { mode: "OVERSIZE", status, snapped: snap.point, alongM: Math.round(along), remainingM: Math.round(remaining), etaS: Math.round(remaining / speed), deviationM: Math.round(snap.offsetM), guidance, ...this.maneuverInfo(along, events), events };
  }
}
