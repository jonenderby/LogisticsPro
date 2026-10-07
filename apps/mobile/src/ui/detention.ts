import { formatMinutes } from "@logisticspro/domain";
import { type Translate, translator } from "@logisticspro/workspace";

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

const at = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
const en = translator("en");

/** "Arrived Tue 12:40 PM · left 4:10 PM · detention 1 h 15 min, $100.00" */
export function visitLine(v?: StopDetentionView, t: Translate = en): string {
  if (!v?.arrivedAt) return "";
  const parts = [t("Arrived {time}", { time: at(v.arrivedAt) }), v.departedAt ? t("left {time}", { time: at(v.departedAt) }) : t("still there")];
  if (v.billableMinutes) parts.push(t(v.atStop ? "detention {time}, {amount} so far" : "detention {time}, {amount}", { time: formatMinutes(v.billableMinutes), amount: `$${v.amount.toFixed(2)}` }));
  else if (v.note) parts.push(v.note);
  return `${parts.join(" · ")}${v.source === "GEOFENCE" ? ` ${t("(truck location)")}` : ""}`;
}
