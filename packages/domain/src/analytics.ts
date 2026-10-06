import { estimatedRoadMiles } from "./geo.js";
import type { Load } from "./load.js";
import type { ShipmentOutcome } from "./reliability.js";
import { carrierKeyOf } from "./reliability.js";

/**
 * A shipper's or broker's view of its freight over a period: how often
 * carriers deliver on time, by carrier and by lane, what it costs per mile,
 * and how that rate moves week to week.
 */

export interface AnalyticsTotals {
  loads: number;
  spend: number;
  miles: number;
  /** Spend per loaded mile; undefined with no miles. */
  costPerMile?: number;
  /** Share of judged deliveries (and pickups) that were on time, 0-1; undefined when none were judged. */
  onTimeDelivery?: number;
  onTimePickup?: number;
  damageFree?: number;
}

export interface CarrierRow extends AnalyticsTotals {
  carrierKey: string;
  name: string;
}

export interface LaneRow extends AnalyticsTotals {
  lane: string;
  origin: string;
  destination: string;
  averageRate: number;
}

export interface WeekRow {
  /** Monday, YYYY-MM-DD (UTC). */
  weekStart: string;
  loads: number;
  costPerMile?: number;
  onTimeDelivery?: number;
}

export interface ShipperAnalytics {
  from: string;
  to: string;
  totals: AnalyticsTotals;
  /** The same measures for the equal-length period just before, for change. */
  previous: AnalyticsTotals;
  byCarrier: CarrierRow[];
  byLane: LaneRow[];
  weekly: WeekRow[];
}

/** Loaded miles along the stops in order, skipping stops without coordinates. */
function loadedMiles(load: Load): number {
  const stops = [...load.stops].sort((a, b) => a.sequence - b.sequence).filter((s) => s.address.geo);
  let miles = 0;
  for (let i = 1; i < stops.length; i++) miles += estimatedRoadMiles(stops[i - 1]!.address.geo!, stops[i]!.address.geo!);
  return miles;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const share = (xs: Array<boolean | null | undefined>) => {
  const judged = xs.filter((x): x is boolean => typeof x === "boolean");
  return judged.length ? r2(judged.filter(Boolean).length / judged.length) : undefined;
};

function totals(rows: Array<{ load: Load; outcome?: ShipmentOutcome; miles: number }>): AnalyticsTotals {
  const spend = r2(rows.reduce((s, r) => s + (r.load.rate?.amount ?? 0), 0));
  const miles = Math.round(rows.reduce((s, r) => s + (r.load.rate ? r.miles : 0), 0));
  return {
    loads: rows.length,
    spend,
    miles,
    costPerMile: miles > 0 ? r2(spend / miles) : undefined,
    onTimeDelivery: share(rows.map((r) => r.outcome?.onTimeDelivery)),
    onTimePickup: share(rows.map((r) => r.outcome?.onTimePickup)),
    damageFree: share(rows.map((r) => r.outcome?.damageFree)),
  };
}

/** Monday of the UTC week containing `iso`. */
export function weekStart(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

const place = (a: { city: string; state: string }) => `${a.city}, ${a.state}`;

export function shipperAnalytics(input: {
  orgId: string;
  loads: Load[];
  outcomes: ShipmentOutcome[];
  from: string;
  to: string;
  carrierName: (key: string, load: Load) => string;
  /** Carriers shown on their own; the rest fold into "Other". */
  maxCarriers?: number;
  maxLanes?: number;
}): ShipperAnalytics {
  const mine = input.loads.filter((l) => (l.shipperOrgId === input.orgId || l.brokerOrgId === input.orgId) && l.deliveredAt && l.status !== "CANCELLED");
  const outcome = new Map(input.outcomes.map((o) => [o.loadId, o]));
  const span = Date.parse(input.to) - Date.parse(input.from);
  const prevFrom = new Date(Date.parse(input.from) - span).toISOString();
  const rowsIn = (from: string, to: string) =>
    mine.filter((l) => l.deliveredAt! >= from && l.deliveredAt! < to).map((load) => ({ load, outcome: outcome.get(load.id), miles: loadedMiles(load) }));
  const rows = rowsIn(input.from, input.to);

  const group = <K extends string>(key: (r: (typeof rows)[number]) => K) => {
    const m = new Map<K, typeof rows>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return [...m];
  };

  const maxCarriers = input.maxCarriers ?? 8;
  const carriers = group((r) => carrierKeyOf(r.load) ?? "unknown")
    .map(([key, rs]) => ({ carrierKey: key, name: input.carrierName(key, rs[0]!.load), rows: rs }))
    .sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));
  const shown = carriers.slice(0, carriers.length > maxCarriers ? maxCarriers - 1 : maxCarriers);
  const rest = carriers.slice(shown.length);
  const byCarrier: CarrierRow[] = [
    ...shown.map((c) => ({ carrierKey: c.carrierKey, name: c.name, ...totals(c.rows) })),
    ...(rest.length ? [{ carrierKey: "other", name: `Other (${rest.length})`, ...totals(rest.flatMap((c) => c.rows)) }] : []),
  ];

  const byLane: LaneRow[] = group((r) => {
    const stops = [...r.load.stops].sort((a, b) => a.sequence - b.sequence);
    return `${place(stops[0]!.address)} → ${place(stops.at(-1)!.address)}`;
  })
    .map(([lane, rs]) => {
      const stops = [...rs[0]!.load.stops].sort((a, b) => a.sequence - b.sequence);
      const t = totals(rs);
      return { lane, origin: place(stops[0]!.address), destination: place(stops.at(-1)!.address), ...t, averageRate: r2(t.spend / rs.length) };
    })
    .sort((a, b) => b.loads - a.loads || a.lane.localeCompare(b.lane))
    .slice(0, input.maxLanes ?? 10);

  // Every week in the period, so gaps show as gaps rather than being skipped.
  const weekly: WeekRow[] = [];
  const weeks = new Map(group((r) => weekStart(r.load.deliveredAt!)));
  for (let w = weekStart(input.from); w < input.to; w = new Date(Date.parse(w) + 7 * 86_400_000).toISOString().slice(0, 10)) {
    const t = totals(weeks.get(w) ?? []);
    weekly.push({ weekStart: w, loads: t.loads, costPerMile: t.costPerMile, onTimeDelivery: t.onTimeDelivery });
  }

  return { from: input.from, to: input.to, totals: totals(rows), previous: totals(rowsIn(prevFrom, input.from)), byCarrier, byLane, weekly };
}
