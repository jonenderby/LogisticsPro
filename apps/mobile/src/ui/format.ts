export const miles = (meters: number) => {
  const mi = meters / 1609.344;
  return mi < 0.1 ? `${Math.round(meters * 3.28084)} ft` : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
};

export const when = (iso?: string) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

export const money = (amount?: number, currency = "USD") =>
  amount === undefined ? "—" : amount.toLocaleString(undefined, { style: "currency", currency });

export const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** "2026-10-06 08:00" in local time -> ISO string */
export function parseLocal(input: string): string | undefined {
  const m = input.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function parseCoords(input: string): { lat: number; lng: number } | undefined {
  const m = input.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return undefined;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : undefined;
}
