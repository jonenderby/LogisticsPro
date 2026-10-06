import { type DutyStatus, HOS, type HosLimit, formatMinutes } from "@logisticspro/domain";
import { Text, View } from "react-native";
import type { HosView } from "../api/types";
import { Banner, Body, Segmented } from "./components";
import { useT } from "../state/MeProvider";
import { useTheme } from "./theme";

export const DUTY: Record<DutyStatus, string> = { OFF_DUTY: "Off duty", SLEEPER: "Sleeper", ON_DUTY: "On duty", DRIVING: "Driving" };

const LIMIT: Record<HosLimit, string> = {
  BREAK: "until your 30-minute break",
  DRIVING: "of your 11-hour driving limit",
  WINDOW: "before your 14-hour window closes",
  CYCLE: "of your weekly cycle",
};
const STOP: Record<HosLimit, string> = {
  BREAK: "Take a 30-minute break before driving again.",
  DRIVING: "You have used your 11 hours of driving. Take 10 hours off.",
  WINDOW: "Your 14-hour window has closed. Take 10 hours off.",
  CYCLE: "You have used your weekly hours. 34 hours off restarts them.",
};

const clock = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/** Green with room to spare, amber in the last 2 hours, red in the last 30 minutes. */
function useLeftColor() {
  const { colors } = useTheme();
  return (left: number) => (left <= 30 ? colors.danger : left <= 120 ? "#EF8A00" : "#2E7D32");
}

function Meter({ label, leftMin, totalMin }: { label: string; leftMin: number; totalMin: number }) {
  const { colors, metrics } = useTheme();
  const t = useT();
  const color = useLeftColor()(leftMin);
  const used = Math.min(1, Math.max(0, 1 - leftMin / totalMin));
  return (
    <View accessible accessibilityLabel={t("{label}: {left} left of {total}", { label, left: formatMinutes(leftMin), total: formatMinutes(totalMin) })} style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ color: colors.text, fontSize: metrics.callout }}>{label}</Text>
        <Text style={{ color, fontSize: metrics.callout, fontWeight: "600" }}>{t("{time} left", { time: formatMinutes(leftMin) })}</Text>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.surfaceVariant, overflow: "hidden" }}>
        <View style={{ width: `${used * 100}%`, height: 6, backgroundColor: color }} />
      </View>
    </View>
  );
}

/**
 * Legal driving time left now and why, miles driven this shift and about how
 * far the remaining time goes, and the duty status switch. `full` adds a
 * meter for each limit.
 */
export const ELD_NAME = { MOTIVE: "Motive", SAMSARA: "Samsara", GEOTAB: "Geotab" } as const;

export function HosSummary({ hos, onStatus, full }: { hos: HosView; onStatus: (s: DutyStatus) => void; full?: boolean }) {
  const { colors } = useTheme();
  const t = useT();
  const color = useLeftColor()(hos.availableMin);
  const cycle = HOS.cycles[hos.cycle];
  return (
    <View style={{ padding: 16, gap: 12 }}>
      <View accessible accessibilityLabel={`${formatMinutes(hos.availableMin)} ${t("left to drive")} ${t(LIMIT[hos.limitedBy])}`}>
        {hos.availableMin > 0 ? (
          <>
            <Text style={{ color, fontSize: 30, fontWeight: "700" }}>{formatMinutes(hos.availableMin)}</Text>
            <Body secondary>{`${t("left to drive")} ${t(LIMIT[hos.limitedBy])}`}</Body>
          </>
        ) : (
          <>
            <Text style={{ color: colors.danger, fontSize: 24, fontWeight: "700" }}>{t("Stop driving")}</Text>
            <Body secondary>{t(STOP[hos.limitedBy])}</Body>
          </>
        )}
      </View>
      <View style={{ flexDirection: "row", gap: 24, flexWrap: "wrap" }}>
        <View>
          <Text style={{ color: colors.text, fontSize: 20, fontWeight: "600" }}>{`${Math.round(hos.milesThisShift)} mi`}</Text>
          <Body secondary style={{ fontSize: 13 }}>{t("driven this shift")}</Body>
        </View>
        <View>
          <Text style={{ color: colors.text, fontSize: 20, fontWeight: "600" }}>{t("about {n} mi", { n: hos.milesLeft })}</Text>
          <Body secondary style={{ fontSize: 13 }}>{t(hos.avgMphSource === "SHIFT" ? "more you can drive at {mph} mph, your pace" : "more you can drive at {mph} mph", { mph: hos.avgMph })}</Body>
        </View>
      </View>
      {hos.restCompleteAt ? <Body secondary>{t("A fresh 11 hours from {time}.", { time: clock(hos.restCompleteAt) })}</Body> : null}
      {hos.source === "ELD" && hos.eld ? (
        <Body secondary>{t("{status} on your {eld} ELD, updated {time}. Change duty status on the ELD.", { status: t(DUTY[hos.status]), eld: ELD_NAME[hos.eld.provider], time: clock(hos.eld.asOf) })}</Body>
      ) : (
        <Segmented options={(Object.keys(DUTY) as DutyStatus[]).map((s) => ({ value: s, label: t(DUTY[s]) }))} value={hos.status} onChange={onStatus} />
      )}
      {full ? (
        <View style={{ gap: 12 }}>
          <Meter label={t("Driving (11 h)")} leftMin={hos.drivingLeftMin} totalMin={HOS.driveMin} />
          <Meter label={t("Shift window (14 h)")} leftMin={hos.windowLeftMin} totalMin={HOS.windowMin} />
          <Meter label={t("Until a 30-minute break (8 h)")} leftMin={hos.breakLeftMin} totalMin={HOS.breakAfterMin} />
          <Meter label={t(hos.cycle === "70/8" ? "Cycle (70 h in 8 days)" : "Cycle (60 h in 7 days)")} leftMin={hos.cycleLeftMin} totalMin={cycle.limitMin} />
        </View>
      ) : null}
      {hos.violations.length ? <Banner tone="danger" title={t("Hours exceeded this shift")} message={hos.violations.join("\n")} /> : null}
    </View>
  );
}
