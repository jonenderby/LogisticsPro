import { z } from "zod";

/**
 * IFTA: carriers report, each quarter, the miles driven and fuel bought in
 * every member state and province. Tax is owed on fuel burned in each
 * jurisdiction (its miles divided by the fleet's miles per gallon), less the
 * tax already paid on fuel bought there.
 */
export const FuelPurchase = z.object({
  id: z.string(),
  carrierOrgId: z.string(),
  /** Unit number, or "driver:<accountId>" when the truck has none. */
  vehicle: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Two-letter state or province code. */
  jurisdiction: z.string().regex(/^[A-Z]{2}$/),
  gallons: z.number().positive().max(1000),
  amount: z.number().nonnegative().optional(),
  vendor: z.string().max(80).optional(),
  enteredByAccountId: z.string(),
  createdAt: z.string(),
});
export type FuelPurchase = z.infer<typeof FuelPurchase>;

/** Miles per jurisdiction for one truck on one day (UTC). */
export interface DailyMiles {
  carrierOrgId: string;
  vehicle: string;
  vehicleLabel: string;
  date: string;
  miles: Record<string, number>;
}

export const Quarter = z.string().regex(/^\d{4}-Q[1-4]$/);

export function quarterOf(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return `${y}-Q${Math.floor((m! - 1) / 3) + 1}`;
}

export function quarterDates(quarter: string): { from: string; to: string } {
  const [y, q] = [Number(quarter.slice(0, 4)), Number(quarter.slice(-1))];
  const start = new Date(Date.UTC(y, (q - 1) * 3, 1));
  const end = new Date(Date.UTC(y, q * 3, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

export interface IftaRow {
  jurisdiction: string;
  name?: string;
  member: boolean;
  miles: number;
  /** Fuel burned there: miles divided by the fleet's miles per gallon. */
  taxableGallons?: number;
  paidGallons: number;
  /** Positive: tax owed on these gallons. Negative: a credit. */
  netGallons?: number;
}

export interface IftaReport {
  quarter: string;
  from: string;
  to: string;
  totalMiles: number;
  totalGallons: number;
  /** Fleet miles per gallon for the quarter; unknown until fuel is entered. */
  mpg?: number;
  rows: IftaRow[];
  vehicles: Array<{ vehicle: string; label: string; miles: number; gallons: number }>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Build the quarter's report from daily miles and fuel purchases. Miles are whole, as filed. */
export function iftaReport(
  quarter: string,
  days: DailyMiles[],
  purchases: FuelPurchase[],
  info: (code: string) => { name?: string; member: boolean } = () => ({ member: true }),
): IftaReport {
  const { from, to } = quarterDates(quarter);
  const inQ = (d: string) => d >= from && d <= to;
  const miles = new Map<string, number>();
  const vehicles = new Map<string, { vehicle: string; label: string; miles: number; gallons: number }>();
  for (const d of days.filter((x) => inQ(x.date))) {
    const v = vehicles.get(d.vehicle) ?? { vehicle: d.vehicle, label: d.vehicleLabel, miles: 0, gallons: 0 };
    for (const [code, m] of Object.entries(d.miles)) {
      miles.set(code, (miles.get(code) ?? 0) + m);
      v.miles += m;
    }
    vehicles.set(d.vehicle, v);
  }
  const paid = new Map<string, number>();
  for (const p of purchases.filter((x) => inQ(x.date))) {
    paid.set(p.jurisdiction, (paid.get(p.jurisdiction) ?? 0) + p.gallons);
    const v = vehicles.get(p.vehicle) ?? { vehicle: p.vehicle, label: p.vehicle, miles: 0, gallons: 0 };
    v.gallons += p.gallons;
    vehicles.set(p.vehicle, v);
  }
  const totalMiles = Math.round([...miles.values()].reduce((s, m) => s + m, 0));
  const totalGallons = r2([...paid.values()].reduce((s, g) => s + g, 0));
  const mpg = totalGallons > 0 && totalMiles > 0 ? r2(totalMiles / totalGallons) : undefined;
  const codes = [...new Set([...miles.keys(), ...paid.keys()])].sort();
  const rows = codes.map((code): IftaRow => {
    const m = Math.round(miles.get(code) ?? 0);
    const taxable = mpg ? r2(m / mpg) : undefined;
    const p = r2(paid.get(code) ?? 0);
    return { jurisdiction: code, ...info(code), miles: m, taxableGallons: taxable, paidGallons: p, netGallons: taxable === undefined ? undefined : r2(taxable - p) };
  });
  return { quarter, from, to, totalMiles, totalGallons, mpg, rows, vehicles: [...vehicles.values()].map((v) => ({ ...v, miles: Math.round(v.miles), gallons: r2(v.gallons) })) };
}

export function iftaCsv(r: IftaReport): string {
  const head = "Jurisdiction,Name,IFTA member,Miles,Taxable gallons,Tax-paid gallons,Net taxable gallons";
  const esc = (s: string | undefined) => (s && /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : (s ?? ""));
  const lines = r.rows.map((x) => [x.jurisdiction, esc(x.name), x.member ? "yes" : "no", x.miles, x.taxableGallons ?? "", x.paidGallons, x.netGallons ?? ""].join(","));
  return [`# IFTA ${r.quarter} (${r.from} to ${r.to}). Total miles ${r.totalMiles}, gallons ${r.totalGallons}, fleet MPG ${r.mpg ?? "n/a"}`, head, ...lines].join("\n") + "\n";
}
