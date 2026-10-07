import { z } from "zod";
import type { ArrivalStatus, ShipmentEta } from "./eta.js";

/** Arrival statuses a person can ask to be alerted about. */
export const AlertStatus = z.enum(["LATE", "AT_RISK", "EARLY", "ON_TIME"]);
export type AlertStatus = z.infer<typeof AlertStatus>;

export const isTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM");

/**
 * What a person wants to hear about, and when.
 *
 * - `instant`: a push the moment the app decides a shipment has become one of
 *   `statuses` (for example, it is now at risk, or now late).
 * - `schedule`: a summary of every shipment currently in one of `statuses`,
 *   pushed at set local times on set days.
 */
export const AlertPreferences = z.object({
  statuses: z.array(AlertStatus).min(1).max(4),
  instant: z.boolean(),
  timeZone: z.string().refine(isTimeZone, "Unknown time zone"),
  schedule: z
    .object({
      times: z.array(HHMM).min(1).max(6),
      /** 0 = Sunday ... 6 = Saturday. */
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      /** Skip a scheduled summary when nothing matches. */
      skipWhenEmpty: z.boolean().default(true),
    })
    .optional(),
});
export type AlertPreferences = z.infer<typeof AlertPreferences>;

export const DEFAULT_ALERT_PREFERENCES: AlertPreferences = { statuses: ["LATE", "AT_RISK"], instant: true, timeZone: "America/Chicago" };

/** A summary slot that fired late (the server was down) still goes out within this many minutes. */
export const SCHEDULE_CATCH_UP_MINUTES = 30;
/** The same load and status is not pushed to the same person again within this window. */
export const REPEAT_AFTER_MINUTES = 240;

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Wall-clock date, time and weekday in a time zone. */
export function localClock(at: Date, timeZone: string): { date: string; time: string; day: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, day };
}

/**
 * Scheduled summaries due at `now`, as stable keys ("2026-10-08T07:00") so the
 * caller can send each one once. A slot is due from its time until
 * SCHEDULE_CATCH_UP_MINUTES later.
 */
export function dueSlots(schedule: NonNullable<AlertPreferences["schedule"]>, timeZone: string, now: Date): string[] {
  const local = localClock(now, timeZone);
  if (!schedule.days.includes(local.day)) return [];
  const t = minutes(local.time);
  return schedule.times.filter((s) => t >= minutes(s) && t - minutes(s) <= SCHEDULE_CATCH_UP_MINUTES).map((s) => `${local.date}T${s}`);
}

/**
 * Whether a change in a shipment's arrival status is news. The first status
 * the app sees for a shipment is only news when it is bad (late or at risk);
 * otherwise every load would announce itself as "on time" when first seen.
 */
export function isAlertableChange(prev: ArrivalStatus | undefined, next: ArrivalStatus): next is AlertStatus {
  if (next === "UNKNOWN" || prev === next) return false;
  if (prev === undefined) return next === "LATE" || next === "AT_RISK";
  return true;
}

/** Suppress repeats when a shipment flips back and forth around a threshold. */
export function isRepeat(last: { status: string; at: string } | undefined, status: AlertStatus, now: Date): boolean {
  return !!last && last.status === status && now.getTime() - Date.parse(last.at) < REPEAT_AFTER_MINUTES * 60_000;
}

const formatter = (timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", minute: "2-digit" });
const clock = (iso: string | undefined, timeZone: string) => (iso ? formatter(timeZone).format(new Date(iso)) : "unknown");

export interface AlertSubject {
  loadNumber: string;
  origin: string;
  destination: string;
  eta: ShipmentEta;
}

const HEADLINE: Record<AlertStatus, (n: string) => string> = {
  LATE: (n) => `${n} will be late`,
  AT_RISK: (n) => `${n} is at risk of arriving late`,
  EARLY: (n) => `${n} will arrive early`,
  ON_TIME: (n) => `${n} is on time`,
};

/** The push for one shipment that just changed status. */
export function alertMessage(s: AlertSubject, status: AlertStatus, timeZone: string): { title: string; body: string } {
  const reason = s.eta.reasons[0];
  return {
    title: HEADLINE[status](s.loadNumber),
    body: `${s.origin} to ${s.destination}. ETA ${clock(s.eta.eta, timeZone)}, window ${clock(s.eta.window.start, timeZone)} to ${clock(s.eta.window.end, timeZone)}.${reason ? ` ${reason}.` : ""}`,
  };
}

const LABEL: Record<AlertStatus, string> = { LATE: "late", AT_RISK: "at risk", EARLY: "early", ON_TIME: "on time" };
const ORDER: AlertStatus[] = ["LATE", "AT_RISK", "EARLY", "ON_TIME"];

/** The scheduled summary: counts in the title, the most urgent shipments in the body. */
export function digestMessage(items: Array<AlertSubject & { status: AlertStatus }>, statuses: AlertStatus[], timeZone: string, maxLines = 5): { title: string; body: string } {
  if (!items.length) return { title: "Shipments: nothing to report", body: `No shipments are ${statuses.map((s) => LABEL[s]).join(" or ")} right now.` };
  const sorted = [...items].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (a.eta.eta ?? "").localeCompare(b.eta.eta ?? ""));
  const counts = ORDER.filter((s) => statuses.includes(s))
    .map((s) => [s, sorted.filter((i) => i.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${LABEL[s]}`);
  const lines = sorted.slice(0, maxLines).map((i) => `${i.loadNumber} ${LABEL[i.status]}, ETA ${clock(i.eta.eta, timeZone)} (${i.destination})`);
  if (sorted.length > maxLines) lines.push(`and ${sorted.length - maxLines} more`);
  return { title: `Shipments: ${counts.join(", ")}`, body: lines.join("\n") };
}
