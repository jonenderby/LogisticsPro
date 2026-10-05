import { formatMinutes } from "@logisticspro/domain";

export interface StopDetentionView {
  stopId: string;
  type: string;
  name: string;
  city: string;
  arrivedAt?: string;
  departedAt?: string;
  source?: "GEOFENCE" | "STATUS";
  atStop: boolean;
  billableMinutes: number;
  amount: number;
  note?: string;
}
export interface DetentionView {
  terms: { freeHours: number; ratePerHour: number };
  stops: StopDetentionView[];
  total: number;
}

const t = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/** "Arrived Tue 12:40 PM · left 4:10 PM · detention 1 h 15 min, $100.00" */
export function visitLine(v?: StopDetentionView): string {
  if (!v?.arrivedAt) return "";
  const parts = [`Arrived ${t(v.arrivedAt)}`, v.departedAt ? `left ${t(v.departedAt)}` : "still there"];
  if (v.billableMinutes) parts.push(`detention ${formatMinutes(v.billableMinutes)}, $${v.amount.toFixed(2)}${v.atStop ? " so far" : ""}`);
  else if (v.note) parts.push(v.note);
  return `${parts.join(" · ")}${v.source === "GEOFENCE" ? " (truck location)" : ""}`;
}
