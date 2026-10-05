import { AUTO_STOP_MINUTES, type DutyEvent, type HosClock, type Load, type TrackPoint, hosClock, isMoving, milesDriven } from "@logisticspro/domain";
import type { MemoryStore } from "../store.js";
import { MOVING, activeLeg } from "./tracking.js";

const KEEP_MS = 9 * 86_400_000;
const DEFAULT_MPH = 50;

export interface HosView extends HosClock {
  /** Miles driven since the shift started, from the phone's location trail. */
  milesThisShift: number;
  /** About how many more miles the legal driving time left allows, at `avgMph`. */
  milesLeft: number;
  avgMph: number;
  avgMphSource: "SHIFT" | "DEFAULT";
}

export function hosFor(store: MemoryStore, accountId: string, now: Date): HosView {
  const clock = hosClock(store.dutyLogs.get(accountId) ?? [], now.toISOString(), store.hosSettings.get(accountId)?.cycle ?? "70/8");
  const milesThisShift = clock.shiftStart ? milesDriven(store.tracks.get(accountId) ?? [], clock.shiftStart, now.toISOString()) : 0;
  // Use this shift's own pace once there is enough of it, within sane bounds.
  const measured = clock.drivingUsedMin >= 30 && milesThisShift > 0 ? milesThisShift / (clock.drivingUsedMin / 60) : undefined;
  const avgMph = measured ? Math.round(Math.min(65, Math.max(25, measured))) : DEFAULT_MPH;
  return { ...clock, milesThisShift, milesLeft: Math.round((clock.availableMin / 60) * avgMph), avgMph, avgMphSource: measured ? "SHIFT" : "DEFAULT" };
}

/** A team truck: either driver could be at the wheel, so movement says nothing about who is driving. */
export function onTeamTruck(store: MemoryStore, accountId: string): boolean {
  return [...store.loads.values()].some((l: Load) => MOVING.includes(l.status) && (activeLeg(l)?.driverAccountIds.length ?? 0) > 1 && activeLeg(l)!.driverAccountIds.includes(accountId));
}

function prune<T extends { at: string }>(items: T[], now: Date, keepLastBefore = false): T[] {
  const cutoff = new Date(now.getTime() - KEEP_MS).toISOString();
  const old = items.filter((i) => i.at < cutoff);
  const recent = items.filter((i) => i.at >= cutoff);
  return keepLastBefore && old.length ? [old[old.length - 1]!, ...recent] : recent;
}

export function setDutyStatus(store: MemoryStore, accountId: string, e: DutyEvent, now: Date): void {
  const log = store.dutyLogs.get(accountId) ?? [];
  if (log[log.length - 1]?.status === e.status) return;
  store.dutyLogs.set(accountId, prune([...log, e].sort((a, b) => a.at.localeCompare(b.at)), now, true));
  if (e.status !== "DRIVING") store.stoppedSince.delete(accountId);
}

/**
 * Add a location fix to the driver's trail and, like an ELD, switch them to
 * Driving when the truck moves and back to On duty after it has been stopped
 * for 5 minutes. Not done for team trucks, where drivers set it themselves.
 */
export function recordFix(store: MemoryStore, accountId: string, fix: TrackPoint, now: Date, opts: { autoDuty: boolean }): void {
  const track = store.tracks.get(accountId) ?? [];
  const prev = track[track.length - 1];
  if (prev && fix.at <= prev.at) return;
  store.tracks.set(accountId, prune([...track, fix], now));
  if (!opts.autoDuty || onTeamTruck(store, accountId)) return;
  const status = store.dutyLogs.get(accountId)?.at(-1)?.status ?? "OFF_DUTY";
  if (isMoving(prev, fix)) {
    store.stoppedSince.delete(accountId);
    if (status !== "DRIVING") setDutyStatus(store, accountId, { status: "DRIVING", at: fix.at, source: "AUTO" }, now);
    return;
  }
  if (status !== "DRIVING") return;
  const since = store.stoppedSince.get(accountId) ?? fix.at;
  store.stoppedSince.set(accountId, since);
  if (Date.parse(fix.at) - Date.parse(since) >= AUTO_STOP_MINUTES * 60_000) {
    setDutyStatus(store, accountId, { status: "ON_DUTY", at: since, source: "AUTO", note: "Stopped" }, now);
  }
}
