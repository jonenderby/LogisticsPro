import { Chip, type Tone } from "./components";

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
  LATE: { label: "Late", tone: "danger", color: "#D32F2F" },
  AT_RISK: { label: "At risk", tone: "warning", color: "#EF8A00" },
  ON_TIME: { label: "On time", tone: "success", color: "#2E7D32" },
  EARLY: { label: "Early", tone: "info", color: "#1D5FD1" },
  UNKNOWN: { label: "No ETA", tone: "neutral", color: "#7A7A80" },
};

export const time = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
export const ago = (iso?: string) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
export const etaLine = (e: Eta) =>
  e.eta ? `${e.etaSource === "ARRIVED" ? "Arrived" : "ETA"} ${time(e.eta)}${e.etaSource === "CARRIER" ? " (carrier)" : ""} · window ${time(e.window.start)}–${new Date(e.window.end).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : `Window ${time(e.window.start)}`;

export function ArrivalChip({ eta }: { eta: Eta }) {
  return <Chip label={ARRIVAL[eta.status].label} tone={ARRIVAL[eta.status].tone} />;
}
