import { z } from "zod";
import { estimatedRoadMiles } from "./geo.js";
import type { Load } from "./load.js";

/**
 * Driver settlement: what a carrier owes each driver for a pay period, from
 * the loads they delivered, by the driver's pay rule, plus anything the office
 * adds or takes off (advances, bonuses, deductions).
 */

export const DriverPayRule = z.object({
  /** PERCENT of the load's linehaul, PER_MILE of loaded miles, or a flat PER_LOAD. */
  kind: z.enum(["PERCENT", "PER_MILE", "PER_LOAD"]),
  rate: z.number().positive().max(10_000),
});
export type DriverPayRule = z.infer<typeof DriverPayRule>;

export const SettlementLine = z.object({
  loadId: z.string(),
  loadNumber: z.string(),
  deliveredAt: z.string(),
  lane: z.string(),
  /** How the amount was worked out, in words: "$5,200.00 × 25%", "412 mi × $0.60". */
  basis: z.string(),
  /** The driver's part of the load: their legs' share of the miles, split with a team partner. */
  share: z.number(),
  amount: z.number(),
});
export type SettlementLine = z.infer<typeof SettlementLine>;

export const SettlementAdjustment = z.object({
  id: z.string(),
  description: z.string().min(1).max(80),
  /** Positive for pay added (a bonus, a reimbursement), negative for deductions and advances. */
  amount: z.number().refine((n) => n !== 0, "Enter an amount"),
  byAccountId: z.string(),
  at: z.string(),
});
export type SettlementAdjustment = z.infer<typeof SettlementAdjustment>;

export const SettlementStatement = z.object({
  id: z.string(),
  carrierOrgId: z.string(),
  driverAccountId: z.string(),
  driverName: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  rule: DriverPayRule.optional(),
  lines: z.array(SettlementLine),
  adjustments: z.array(SettlementAdjustment),
  total: z.number(),
  status: z.enum(["DRAFT", "APPROVED", "PAID"]),
  createdAt: z.string(),
  approvedAt: z.string().optional(),
  approvedByAccountId: z.string().optional(),
  paidAt: z.string().optional(),
  paidReference: z.string().optional(),
});
export type SettlementStatement = z.infer<typeof SettlementStatement>;

const r2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Miles between two stops of a load, through the stops between them. */
function milesBetween(load: Load, fromStopId: string, toStopId: string): number {
  const stops = [...load.stops].sort((a, b) => a.sequence - b.sequence);
  const from = stops.findIndex((s) => s.id === fromStopId);
  const to = stops.findIndex((s) => s.id === toStopId);
  if (from < 0 || to <= from) return 0;
  let miles = 0;
  for (let i = from + 1; i <= to; i++) {
    const a = stops[i - 1]!.address.geo;
    const b = stops[i]!.address.geo;
    if (a && b) miles += estimatedRoadMiles(a, b);
  }
  return miles;
}

/**
 * A driver's part of a load: for each leg they drove, that leg's share of the
 * load's miles (equal shares when miles are unknown), halved for a team.
 */
export function driverShare(load: Load, driverAccountId: string): { share: number; miles: number } {
  const legs = load.legs.length ? load.legs : [];
  const legMiles = legs.map((l) => milesBetween(load, l.fromStopId, l.toStopId));
  const total = legMiles.reduce((s, m) => s + m, 0);
  let share = 0;
  let miles = 0;
  legs.forEach((leg, i) => {
    if (!leg.driverAccountIds.includes(driverAccountId)) return;
    const part = total > 0 ? legMiles[i]! / total : 1 / legs.length;
    share += part / leg.driverAccountIds.length;
    miles += legMiles[i]! / leg.driverAccountIds.length;
  });
  return { share: Math.round(share * 10_000) / 10_000, miles: Math.round(miles) };
}

const laneOf = (load: Load) => {
  const s = [...load.stops].sort((a, b) => a.sequence - b.sequence);
  const a = s[0]?.address;
  const b = s[s.length - 1]?.address;
  return a && b ? `${a.city}, ${a.state} to ${b.city}, ${b.state}` : load.loadNumber;
};

/** One settlement line for a delivered load under a pay rule. */
export function settlementLine(load: Load, driverAccountId: string, rule: DriverPayRule): SettlementLine {
  const { share, miles } = driverShare(load, driverAccountId);
  const linehaul = load.rate?.amount ?? 0;
  const amount = rule.kind === "PERCENT" ? (linehaul * rule.rate * share) / 100 : rule.kind === "PER_MILE" ? miles * rule.rate : rule.rate * share;
  const split = share < 1 ? ` × ${Math.round(share * 100)}% of the load` : "";
  const basis =
    rule.kind === "PERCENT" ? `${usd(linehaul)} × ${rule.rate}%${split}` : rule.kind === "PER_MILE" ? `${miles} mi × ${usd(rule.rate)}` : `${usd(rule.rate)} per load${split}`;
  return { loadId: load.id, loadNumber: load.loadNumber, deliveredAt: load.deliveredAt ?? load.updatedAt, lane: laneOf(load), basis, share, amount: r2(amount) };
}

export function settlementTotal(s: Pick<SettlementStatement, "lines" | "adjustments">): number {
  return r2(s.lines.reduce((t, l) => t + l.amount, 0) + s.adjustments.reduce((t, a) => t + a.amount, 0));
}

/** The Monday-to-Sunday week before `today` (YYYY-MM-DD), the usual pay period. */
export function lastWeek(today: string): { start: string; end: string } {
  const d = new Date(`${today}T12:00:00Z`);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d.getTime() - (sinceMonday + 7) * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

/** A statement as CSV for payroll or accounting. */
export function settlementCsv(statements: SettlementStatement[]): string {
  const q = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["Driver", "Period start", "Period end", "Load", "Delivered", "Lane", "Basis", "Amount"]];
  for (const s of statements) {
    for (const l of s.lines) rows.push([s.driverName, s.periodStart, s.periodEnd, l.loadNumber, l.deliveredAt.slice(0, 10), l.lane, l.basis, l.amount.toFixed(2)]);
    for (const a of s.adjustments) rows.push([s.driverName, s.periodStart, s.periodEnd, "", "", "", a.description, a.amount.toFixed(2)]);
    rows.push([s.driverName, s.periodStart, s.periodEnd, "", "", "", "Total", s.total.toFixed(2)]);
  }
  return rows.map((r) => r.map(q).join(",")).join("\n") + "\n";
}
