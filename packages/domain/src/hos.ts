import { z } from "zod";
import type { GeoPoint } from "./common.js";
import { estimatedRoadMiles, haversineMiles } from "./geo.js";

/**
 * Hours of service for property-carrying drivers (FMCSA, 49 CFR 395.3):
 *
 * - 11 hours of driving after 10 consecutive hours off duty.
 * - No driving after the 14th hour since coming on duty (the "window").
 * - A 30-minute break from driving after 8 hours of driving.
 * - 60 hours on duty in 7 days or 70 in 8 days; 34 hours off restarts it.
 *
 * Off duty and sleeper berth both count as rest. Split sleeper-berth
 * pairings, adverse-conditions extensions and short-haul exceptions are not
 * modeled, so the clock can be more conservative than the law allows.
 */
export const DutyStatus = z.enum(["OFF_DUTY", "SLEEPER", "ON_DUTY", "DRIVING"]);
export type DutyStatus = z.infer<typeof DutyStatus>;

export const DutyEvent = z.object({
  status: DutyStatus,
  at: z.string(),
  /** DRIVER: set by the driver. AUTO: detected from the phone's movement. */
  source: z.enum(["DRIVER", "AUTO"]),
  note: z.string().max(200).optional(),
});
export type DutyEvent = z.infer<typeof DutyEvent>;

export const HosCycle = z.enum(["70/8", "60/7"]);
export type HosCycle = z.infer<typeof HosCycle>;

export const HOS = {
  driveMin: 11 * 60,
  windowMin: 14 * 60,
  breakAfterMin: 8 * 60,
  breakMin: 30,
  resetMin: 10 * 60,
  restartMin: 34 * 60,
  cycles: { "70/8": { limitMin: 70 * 60, days: 8 }, "60/7": { limitMin: 60 * 60, days: 7 } } as Record<HosCycle, { limitMin: number; days: number }>,
};

export type HosLimit = "DRIVING" | "WINDOW" | "BREAK" | "CYCLE";

export interface HosClock {
  status: DutyStatus;
  since: string;
  /** When the current shift began (first on-duty time after 10 hours off). Absent while rested. */
  shiftStart?: string;
  drivingUsedMin: number;
  drivingLeftMin: number;
  windowLeftMin: number;
  /** Driving time left before a 30-minute break is required. */
  breakLeftMin: number;
  cycle: HosCycle;
  cycleUsedMin: number;
  cycleLeftMin: number;
  /** Legal driving time left now: the smallest of the four. */
  availableMin: number;
  limitedBy: HosLimit;
  /** While resting: when 10 hours off is complete and a fresh shift is available. */
  restCompleteAt?: string;
  violations: string[];
}

interface Segment {
  status: DutyStatus;
  start: number;
  end: number;
}

const MIN = 60_000;
const rest = (s: DutyStatus) => s === "OFF_DUTY" || s === "SLEEPER";
const onDuty = (s: DutyStatus) => s === "ON_DUTY" || s === "DRIVING";
export const formatMinutes = (m: number) => {
  const v = Math.max(0, Math.round(m));
  return v >= 60 ? `${Math.floor(v / 60)} h${v % 60 ? ` ${v % 60} min` : ""}` : `${v} min`;
};

/** Duty segments up to `now`. Before the first event the driver is off duty. */
function segments(events: DutyEvent[], now: number): Segment[] {
  const sorted = [...events].filter((e) => Date.parse(e.at) <= now).sort((a, b) => a.at.localeCompare(b.at));
  const out: Segment[] = [];
  sorted.forEach((e, i) => {
    const start = Date.parse(e.at);
    const isLast = i + 1 === sorted.length;
    const end = isLast ? now : Date.parse(sorted[i + 1]!.at);
    // Keep a status that starts right now: it is the current one.
    if (end < start || (end === start && !isLast)) return;
    const last = out[out.length - 1];
    if (last && last.status === e.status && last.end === start) last.end = end;
    else out.push({ status: e.status, start, end });
  });
  return out;
}

export function hosClock(events: DutyEvent[], nowIso: string, cycle: HosCycle = "70/8"): HosClock {
  const now = Date.parse(nowIso);
  const segs = segments(events, now);
  const current = segs[segs.length - 1];
  const status: DutyStatus = current?.status ?? "OFF_DUTY";
  const violations: string[] = [];

  // Walk the log once, resetting the shift after 10 hours of rest and the
  // break counter after 30 minutes without driving.
  let shiftStart: number | undefined;
  let drivingUsed = 0;
  let drivingSinceBreak = 0;
  let restRun = 0;
  let nonDrivingRun = 0;
  let restRunStart: number | undefined;
  let lastRestartEnd = -Infinity;
  for (const s of segs) {
    const len = (s.end - s.start) / MIN;
    if (rest(s.status)) {
      if (restRun === 0) restRunStart = s.start;
      restRun += len;
      if (restRun >= HOS.resetMin) {
        shiftStart = undefined;
        drivingUsed = 0;
        drivingSinceBreak = 0;
      }
      if (restRun >= HOS.restartMin) lastRestartEnd = s.end;
    } else {
      restRun = 0;
      restRunStart = undefined;
      shiftStart ??= s.start;
    }
    if (s.status === "DRIVING") {
      nonDrivingRun = 0;
      const windowEnd = shiftStart! + HOS.windowMin * MIN;
      if (s.end > windowEnd) violations.push(`Drove ${formatMinutes((s.end - Math.max(s.start, windowEnd)) / MIN)} after the 14-hour window closed`);
      if (drivingUsed < HOS.driveMin && drivingUsed + len > HOS.driveMin) violations.push(`Drove ${formatMinutes(drivingUsed + len - HOS.driveMin)} past the 11-hour driving limit`);
      if (drivingSinceBreak < HOS.breakAfterMin && drivingSinceBreak + len > HOS.breakAfterMin) violations.push("Drove more than 8 hours without a 30-minute break");
      drivingUsed += len;
      drivingSinceBreak += len;
    } else {
      nonDrivingRun += len;
      if (nonDrivingRun >= HOS.breakMin) drivingSinceBreak = 0;
    }
  }

  const { limitMin, days } = HOS.cycles[cycle];
  const cycleFrom = Math.max(now - days * 24 * 60 * MIN, lastRestartEnd);
  const cycleUsed = segs.filter((s) => onDuty(s.status)).reduce((m, s) => m + Math.max(0, Math.min(s.end, now) - Math.max(s.start, cycleFrom)) / MIN, 0);

  const drivingLeft = HOS.driveMin - drivingUsed;
  const windowLeft = shiftStart === undefined ? HOS.windowMin : HOS.windowMin - (now - shiftStart) / MIN;
  const breakLeft = HOS.breakAfterMin - drivingSinceBreak;
  const cycleLeft = limitMin - cycleUsed;
  const limits: Array<[HosLimit, number]> = [
    ["DRIVING", drivingLeft],
    ["WINDOW", windowLeft],
    ["BREAK", breakLeft],
    ["CYCLE", cycleLeft],
  ];
  const [limitedBy, available] = limits.reduce((a, b) => (b[1] < a[1] ? b : a));
  const round = (m: number) => Math.max(0, Math.round(m));
  return {
    status,
    since: new Date(current?.start ?? now).toISOString(),
    shiftStart: shiftStart === undefined ? undefined : new Date(shiftStart).toISOString(),
    drivingUsedMin: Math.round(drivingUsed),
    drivingLeftMin: round(drivingLeft),
    windowLeftMin: round(windowLeft),
    breakLeftMin: round(breakLeft),
    cycle,
    cycleUsedMin: Math.round(cycleUsed),
    cycleLeftMin: round(cycleLeft),
    availableMin: round(available),
    limitedBy,
    restCompleteAt: rest(status) && restRunStart !== undefined && restRun < HOS.resetMin ? new Date(restRunStart + HOS.resetMin * MIN).toISOString() : undefined,
    violations: [...new Set(violations)],
  };
}

export interface TrackPoint {
  geo: GeoPoint;
  at: string;
  speedMps?: number;
}

/**
 * Miles driven between two times from the phone's location trail. Close
 * fixes are joined straight; gaps (app closed) use a road-distance estimate;
 * jumps faster than a truck can go are GPS glitches and are skipped.
 */
export function milesDriven(track: TrackPoint[], from: string, to: string): number {
  const pts = track.filter((p) => p.at >= from && p.at <= to).sort((a, b) => a.at.localeCompare(b.at));
  let miles = 0;
  let a = pts[0];
  for (const b of pts.slice(1)) {
    const hours = (Date.parse(b.at) - Date.parse(a!.at)) / 3_600_000;
    const d = hours > 5 / 60 ? estimatedRoadMiles(a!.geo, b.geo) : haversineMiles(a!.geo, b.geo);
    // A fix that implies over 90 mph is a glitch: drop it and measure from the last good fix.
    if (hours <= 0 || d / hours > 90) continue;
    miles += d;
    a = b;
  }
  return Math.round(miles * 10) / 10;
}

/**
 * Whether a location fix shows the truck moving (over 5 mph). A jump faster
 * than a truck can go (a first fix far from the last one, a GPS glitch) is
 * not taken as driving.
 */
export function isMoving(prev: TrackPoint | undefined, next: TrackPoint): boolean {
  if (next.speedMps !== undefined) return next.speedMps >= 2.24;
  if (!prev) return false;
  const hours = (Date.parse(next.at) - Date.parse(prev.at)) / 3_600_000;
  if (hours <= 0) return false;
  const mph = haversineMiles(prev.geo, next.geo) / hours;
  return mph >= 5 && mph <= 90;
}

/** Stopped this long while driving, the driver is switched to on duty (not driving), as an ELD does. */
export const AUTO_STOP_MINUTES = 5;
