import { type Translate, translator, tx } from "@logisticspro/workspace";
import { Chip, type Tone } from "./components";

const en = translator("en");

export type Arrival = "LATE" | "AT_RISK" | "ON_TIME" | "EARLY" | "UNKNOWN";
export interface Eta {
  status: Arrival;
  eta?: string;
  etaSource: "ARRIVED" | "CARRIER" | "COMPUTED" | "NONE";
  window: { start: string; end: string };
  slackMinutes?: number;
  remainingMiles?: number;
  nextStop?: { city: string; state: string; type: string };
  reasons: string[];
}
export const ARRIVAL: Record<Arrival, { label: string; tone: Tone; color: string }> = {
  LATE: { label: tx("Late"), tone: "danger", color: "#D32F2F" },
  AT_RISK: { label: tx("At risk"), tone: "warning", color: "#EF8A00" },
  ON_TIME: { label: tx("On time"), tone: "success", color: "#2E7D32" },
  EARLY: { label: tx("Early"), tone: "info", color: "#1D5FD1" },
  UNKNOWN: { label: tx("No ETA"), tone: "neutral", color: "#7A7A80" },
};

export const time = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
export const ago = (iso?: string, t: Translate = en) => {
  if (!iso) return t("never");
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? t("just now") : m < 120 ? t("{n} min ago", { n: m }) : t("{n} h ago", { n: Math.round(m / 60) });
};
export const etaLine = (e: Eta, t: Translate = en) =>
  e.eta
    ? t(e.etaSource === "ARRIVED" ? "Arrived {time}" : e.etaSource === "CARRIER" ? "ETA {time} (carrier) · window {start}–{end}" : "ETA {time} · window {start}–{end}", { time: time(e.eta), start: time(e.window.start), end: new Date(e.window.end).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) })
    : t("Window {start}", { start: time(e.window.start) });

export function ArrivalChip({ eta }: { eta: Eta }) {
  return <Chip label={ARRIVAL[eta.status].label} tone={ARRIVAL[eta.status].tone} />;
}
