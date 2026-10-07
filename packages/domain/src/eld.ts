import { z } from "zod";
import { type DutyStatus, HOS, type HosClock, type HosLimit } from "./hos.js";

/**
 * Electronic logging devices. A carrier connects its ELD account (Motive,
 * Samsara or Geotab) once; its drivers' hours-of-service clocks and its
 * trucks' GPS then come from the ELD, which is the legal record, instead of
 * being estimated from the phone.
 */

export const EldProvider = z.enum(["MOTIVE", "SAMSARA", "GEOTAB"]);
export type EldProvider = z.infer<typeof EldProvider>;

export interface EldDriver {
  externalId: string;
  name: string;
  email?: string;
  phone?: string;
  licenseNumber?: string;
}

/** Time left on each hours-of-service clock, as the ELD reports it. */
export interface EldClock {
  externalDriverId: string;
  status?: DutyStatus;
  driveLeftMin: number;
  shiftLeftMin: number;
  cycleLeftMin: number;
  /** Driving time until a 30-minute break is due; absent when the ELD doesn't report it. */
  breakLeftMin?: number;
  asOf: string;
}

export interface EldVehicleLocation {
  externalVehicleId: string;
  /** Unit number. */
  name: string;
  lat: number;
  lng: number;
  speedMps?: number;
  headingDeg?: number;
  at: string;
  /** The driver logged in to this truck, when the ELD knows. */
  externalDriverId?: string;
}

/** An ELD clock is used while it is this fresh; after that, the phone's estimate takes over again. */
export const ELD_FRESH_MS = 15 * 60_000;

/**
 * The app's hours clock with the ELD's remaining times in place of the
 * estimate. What the ELD doesn't report (shift start, cycle used) comes
 * from the estimate.
 */
export function withEldClock(estimate: HosClock, eld: EldClock): HosClock {
  const left = { DRIVING: eld.driveLeftMin, WINDOW: eld.shiftLeftMin, BREAK: eld.breakLeftMin ?? Number.POSITIVE_INFINITY, CYCLE: eld.cycleLeftMin } as const;
  const limitedBy = (Object.keys(left) as HosLimit[]).reduce((a, b) => (left[b] < left[a] ? b : a));
  const cycleTotal = estimate.cycle === "60/7" ? 60 * 60 : 70 * 60;
  return {
    ...estimate,
    status: eld.status ?? estimate.status,
    drivingUsedMin: Math.max(0, HOS.driveMin - eld.driveLeftMin),
    drivingLeftMin: Math.max(0, eld.driveLeftMin),
    windowLeftMin: Math.max(0, eld.shiftLeftMin),
    breakLeftMin: Math.max(0, eld.breakLeftMin ?? estimate.breakLeftMin),
    cycleUsedMin: Math.max(0, cycleTotal - eld.cycleLeftMin),
    cycleLeftMin: Math.max(0, eld.cycleLeftMin),
    availableMin: Math.max(0, Math.round(Math.min(eld.driveLeftMin, eld.shiftLeftMin, eld.cycleLeftMin, eld.breakLeftMin ?? Number.POSITIVE_INFINITY))),
    limitedBy,
    // The ELD is the record of violations; the estimate's guesses don't apply.
    violations: [],
  };
}

const norm = (s?: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Match ELD drivers to the carrier's drivers on Logistics Pro: by email
 * first, then by CDL number, then by exact name. Only one-to-one matches.
 */
export function matchEldDrivers(eld: EldDriver[], members: Array<{ accountId: string; name: string; email: string; cdlNumber?: string }>): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  const pass = (key: (d: EldDriver) => string, mkey: (m: (typeof members)[number]) => string) => {
    for (const d of eld) {
      if (out.has(d.externalId) || !key(d)) continue;
      const hits = members.filter((m) => !used.has(m.accountId) && mkey(m) && mkey(m) === key(d));
      if (hits.length === 1) {
        out.set(d.externalId, hits[0]!.accountId);
        used.add(hits[0]!.accountId);
      }
    }
  };
  pass((d) => (d.email ?? "").trim().toLowerCase(), (m) => m.email.trim().toLowerCase());
  pass((d) => norm(d.licenseNumber), (m) => norm(m.cdlNumber));
  pass((d) => norm(d.name), (m) => norm(m.name));
  return out;
}
