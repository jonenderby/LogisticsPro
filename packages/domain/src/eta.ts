import type { GeoPoint } from "./common.js";
import { type HosStart, driveTimeline } from "./hos.js";
import { estimatedRoadMiles } from "./geo.js";
import { type Load, type Stop, finalDeliveryStop, pickupStop } from "./load.js";

export type ArrivalStatus = "EARLY" | "ON_TIME" | "AT_RISK" | "LATE" | "UNKNOWN";

export interface Position {
  geo: GeoPoint;
  at: string;
  speedMps?: number;
  headingDeg?: number;
}

export interface ShipmentEta {
  loadId: string;
  status: ArrivalStatus;
  /** Estimated (or actual) arrival at the final delivery. */
  eta?: string;
  etaSource: "ARRIVED" | "CARRIER" | "COMPUTED" | "NONE";
  window: { start: string; end: string };
  /** Minutes between the ETA and the end of the delivery window (negative = late). */
  slackMinutes?: number;
  remainingMiles?: number;
  position?: Position & { stale: boolean; source: "DRIVER" | "STATUS" };
  nextStop?: { sequence: number; type: Stop["type"]; city: string; state: string };
  /** Plain-language reasons behind the status, most important first. */
  reasons: string[];
}

export interface EtaOptions {
  now: string;
  /** Latest phone position of the driver(s) on the active leg. */
  position?: Position;
  avgMph?: number;
  /** Time spent at each stop still ahead (loading, unloading, relay swaps). */
  dwellHours?: number;
  /** A position older than this while moving makes the shipment at risk. */
  staleAfterMinutes?: number;
  /** Arriving with less slack than this before the window closes is at risk. */
  atRiskMinutes?: number;
  graceMinutes?: number;
  /** The driver's hours left right now; without it the driver is assumed fresh. */
  hos?: HosStart;
  /** A road route for what is left, from a routing server; replaces the road-factor estimate. */
  route?: { miles: number; minutes: number };
}

const MIN = 60_000;
const H = 3_600_000;
const ACTIVE = ["BOOKED", "DISPATCHED", "AT_PICKUP", "IN_TRANSIT", "AT_DELIVERY"];
const ago = (ms: number) => (ms >= 2 * H ? `${Math.round(ms / H)} h` : `${Math.max(1, Math.round(ms / MIN))} min`);

/**
 * When will this shipment reach its final delivery, and how does that compare
 * with the delivery window?
 *
 * Distance uses straight-line miles times a road factor from the truck's last
 * known position through the stops still ahead; driving time follows
 * hours-of-service (or a team). A carrier-reported ETA wins when it is recent.
 */
export function shipmentEta(load: Load, o: EtaOptions): ShipmentEta {
  const now = Date.parse(o.now);
  const grace = (o.graceMinutes ?? 15) * MIN;
  const dwell = (o.dwellHours ?? 1) * H;
  const final = finalDeliveryStop(load);
  const window = { start: final.window.start, end: final.window.end };
  const out: ShipmentEta = { loadId: load.id, status: "UNKNOWN", etaSource: "NONE", window, reasons: [] };
  const notes: string[] = [];
  const classify = (etaMs: number) => {
    out.slackMinutes = Math.round((Date.parse(window.end) - etaMs) / MIN);
    if (etaMs > Date.parse(window.end) + grace) return "LATE" as const;
    if (etaMs < Date.parse(window.start)) return "EARLY" as const;
    return "ON_TIME" as const;
  };

  // Already at the delivery: judge the actual arrival.
  const arrived = [...load.events].reverse().find((e) => e.code === "ARRIVED_DELIVERY" && (!e.stopId || e.stopId === final.id));
  if (arrived && (load.status === "AT_DELIVERY" || load.status === "DELIVERED")) {
    out.eta = arrived.at;
    out.etaSource = "ARRIVED";
    out.status = classify(Date.parse(arrived.at));
    out.reasons.push(out.status === "LATE" ? "Arrived after the delivery window" : out.status === "EARLY" ? "Arrived before the delivery window opened" : "Arrived within the delivery window");
    return out;
  }
  if (!ACTIVE.includes(load.status)) {
    out.reasons.push(load.status === "TENDERED" ? "Waiting for the carrier to accept" : `Load is ${load.status.toLowerCase()}`);
    return out;
  }

  const pickup = pickupStop(load);
  const pickedUp = !!load.pickedUpAt;
  const ordered = [...load.stops].sort((a, b) => a.sequence - b.sequence);
  const doneStops = new Set(load.legs.filter((l) => l.status === "COMPLETED").map((l) => l.toStopId));
  const ahead = ordered.filter((s) => (pickedUp ? s.sequence > pickup.sequence : s.sequence >= pickup.sequence) && !doneStops.has(s.id));
  const next = ahead[0];
  if (next) out.nextStop = { sequence: next.sequence, type: next.type, city: next.address.city, state: next.address.state };

  // Where is the truck? Prefer the driver's phone, else the last status with a location.
  const lastGeoEvent = [...load.events].reverse().find((e) => e.geo);
  let pos: ShipmentEta["position"];
  if (o.position) pos = { ...o.position, source: "DRIVER", stale: false };
  if (lastGeoEvent?.geo && (!pos || lastGeoEvent.at > pos.at)) pos = { geo: lastGeoEvent.geo, at: lastGeoEvent.at, source: "STATUS", stale: false };
  if (pos) {
    const age = now - Date.parse(pos.at);
    pos.stale = pickedUp && age > (o.staleAfterMinutes ?? 120) * MIN;
    out.position = pos;
  }

  // Remaining distance.
  let from: GeoPoint | undefined = pickedUp ? pos?.geo : undefined;
  let start = now;
  if (!pickedUp) {
    from = pickup.address.geo;
    start = Math.max(now, Date.parse(pickup.window.start)) + dwell; // load, then depart
  }
  const legs = pickedUp ? ahead : ahead.filter((s) => s.id !== pickup.id);
  if (!from || legs.some((s) => !s.address.geo)) {
    out.reasons.push(!from ? (pickedUp ? "No location reported since pickup" : "Pickup has no map location") : "A stop ahead has no map location");
  } else {
    let miles = 0;
    let here = from;
    for (const s of legs) {
      miles += estimatedRoadMiles(here, s.address.geo!);
      here = s.address.geo!;
    }
    // A routed distance and time, when one is available for the truck's position, beats the estimate.
    const routed = pickedUp && o.route && o.route.miles > 0;
    if (routed) miles = o.route!.miles;
    out.remainingMiles = Math.round(miles);
    const team = load.teamRequired || load.service === "TEAM_EXPEDITED";
    const drivingMin = routed ? o.route!.minutes : (miles / (o.avgMph ?? 50)) * 60;
    // Driving rules apply from the driver's real clock once rolling; before pickup assume a fresh driver.
    const timeline = driveTimeline(drivingMin, pickedUp ? o.hos : undefined, { team });
    const stopsBetween = Math.max(0, legs.length - 1);
    const computed = start + timeline.elapsedMin * MIN + stopsBetween * dwell;
    // Information, not a risk: added after the status is decided.
    if (timeline.restarts) notes.push("Includes a 34-hour restart: the driver is out of weekly hours");
    else if (timeline.resets) notes.push(`Includes ${timeline.resets === 1 ? "a 10-hour rest" : `${timeline.resets} 10-hour rests`} under driving-hour rules`);
    out.eta = new Date(computed).toISOString();
    out.etaSource = "COMPUTED";
  }

  // A recent ETA from the carrier (ETA update or delay) takes precedence.
  const reported = [...load.events].reverse().find((e) => e.eta);
  if (reported?.eta && now - Date.parse(reported.at) < 12 * H) {
    const computed = out.eta;
    out.eta = reported.eta;
    out.etaSource = "CARRIER";
    if (computed && Date.parse(computed) - Date.parse(reported.eta) > H) out.reasons.push("Our estimate is more than an hour later than the carrier's");
  }
  if (!out.eta) return out;

  const base = classify(Date.parse(out.eta));
  out.status = base;
  if (base === "LATE") {
    out.reasons.unshift(`Expected ${ago(-out.slackMinutes! * MIN)} after the delivery window closes`);
    if (out.etaSource === "COMPUTED") out.reasons.push(...notes);
    return out;
  }

  // At-risk signals.
  const risks: string[] = [];
  if (out.slackMinutes! < (o.atRiskMinutes ?? 60)) risks.push(`Only ${ago(Math.max(0, out.slackMinutes!) * MIN)} of slack before the window closes`);
  if (!pickedUp && now > Date.parse(pickup.window.end) + grace) risks.push("Pickup window has passed without a pickup");
  if (pos?.stale) risks.push(`No location update for ${ago(now - Date.parse(pos.at))}`);
  const delay = [...load.events].reverse().find((e) => e.code === "DELAYED" && now - Date.parse(e.at) < 12 * H);
  if (delay) risks.push(`Delay reported${delay.note ? `: ${delay.note}` : ""}`);
  const activeLeg = load.legs.find((l) => l.status === "IN_PROGRESS") ?? load.legs.find((l) => l.status !== "COMPLETED");
  if (!pickedUp && (!activeLeg || activeLeg.driverAccountIds.length === 0) && Date.parse(pickup.window.start) - now < 12 * H) risks.push("No driver assigned and pickup is within 12 h");
  if (out.reasons.length) risks.push(...out.reasons.splice(0));
  if (risks.length) {
    out.status = "AT_RISK";
    out.reasons = risks;
  } else {
    out.reasons.push(base === "EARLY" ? `Expected ${ago((Date.parse(window.start) - Date.parse(out.eta)))} before the window opens` : "On track for the delivery window");
  }
  if (out.etaSource === "COMPUTED") out.reasons.push(...notes);
  return out;
}

export function summarizeEtas(etas: ShipmentEta[]): Record<ArrivalStatus, number> {
  const s: Record<ArrivalStatus, number> = { LATE: 0, AT_RISK: 0, ON_TIME: 0, EARLY: 0, UNKNOWN: 0 };
  for (const e of etas) s[e.status]++;
  return s;
}

/** Most urgent first: late, at risk, unknown, on time, early; then by ETA. */
export function byUrgency(a: ShipmentEta, b: ShipmentEta): number {
  const rank: Record<ArrivalStatus, number> = { LATE: 0, AT_RISK: 1, UNKNOWN: 2, ON_TIME: 3, EARLY: 4 };
  return rank[a.status] - rank[b.status] || (a.eta ?? "9").localeCompare(b.eta ?? "9");
}
