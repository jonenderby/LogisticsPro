import { View } from "react-native";
import { useT } from "../state/MeProvider";
import { Body, Chip, Row, type Tone } from "./components";

export interface Score {
  shipments: number;
  window: number;
  onTimePickupPct: number | null;
  onTimeDeliveryPct: number | null;
  damageFreePct: number | null;
  missedAppointments?: number;
  score: number | null;
}

const fmt = (v: number | null) => (v === null ? "—" : `${v % 1 === 0 ? v : v.toFixed(1)}%`);
export const scoreTone = (s: number | null): Tone => (s === null ? "neutral" : s >= 95 ? "success" : s >= 85 ? "warning" : "danger");

/** One line: overall score chip plus the three rates and the window it covers. */
export function ScoreRow({ title, score }: { title: string; score: Score }) {
  const t = useT();
  return (
    <Row
      title={title}
      subtitle={score.shipments ? `${t("On-time pickup {pickup} · delivery {delivery} · damage-free {damage}", { pickup: fmt(score.onTimePickupPct), delivery: fmt(score.onTimeDeliveryPct), damage: fmt(score.damageFreePct) })}${score.missedAppointments ? `\n${t(score.missedAppointments === 1 ? "{n} missed appointment reported" : "{n} missed appointments reported", { n: score.missedAppointments })}` : ""}\n${t("Last {n} of up to {window} shipments", { n: score.shipments.toLocaleString(), window: score.window.toLocaleString() })}` : t("No delivered shipments yet (window: last {window})", { window: score.window.toLocaleString() })}
      right={<Chip label={score.score === null ? t("New") : `${fmt(score.score)}`} tone={scoreTone(score.score)} />}
    />
  );
}

export function ScoreChip({ label, score }: { label: string; score?: Score | null }) {
  const t = useT();
  if (!score) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Body secondary style={{ fontSize: 13 }}>{label}</Body>
      <Chip label={score.score === null ? t("New") : `${fmt(score.score)} · ${score.shipments}`} tone={scoreTone(score.score)} />
    </View>
  );
}
