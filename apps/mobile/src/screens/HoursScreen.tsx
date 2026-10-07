import type { DutyStatus, HosCycle } from "@logisticspro/domain";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { api, errorMessage } from "../api/client";
import type { HosView } from "../api/types";
import { useMe, useT } from "../state/MeProvider";
import { Empty, Padded, Row, Screen, Section, Segmented } from "../ui/components";
import { notify } from "../ui/dialog";
import { DUTY, HosSummary } from "../ui/Hos";

/** Change duty status and refresh everything that shows hours. */
export function useDutyStatus(onDone: (h: HosView) => void) {
  const { refresh } = useMe();
  const t = useT();
  return async (status: DutyStatus) => {
    try {
      onDone(await api.post<HosView>("/v1/me/duty-status", { status }));
      await refresh();
    } catch (e) {
      notify(t("Couldn't change duty status"), errorMessage(e));
    }
  };
}

/**
 * The driver's hours of service: time left under each limit, miles this
 * shift, the duty log for the last 8 days and the weekly cycle.
 */
export function HoursScreen() {
  const t = useT();
  const [hos, setHos] = useState<HosView>();
  const load = useCallback(async () => setHos(await api.get<HosView>("/v1/me/hos")), []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const setStatus = useDutyStatus(() => void load());
  if (!hos) return null;
  return (
    <Screen onRefresh={load}>
      <Section title={t("Hours of service")} footer={t(hos.source === "ELD" ? "From your carrier's ELD, the legal record, every few minutes. Miles this shift come from your truck's GPS." : "An estimate from your duty status and your phone's location while the app is open. It is not an ELD: your ELD's record is the legal one.")}>
        <HosSummary hos={hos} onStatus={setStatus} full />
      </Section>
      <Section title={t("Weekly cycle")} footer={t("Use the cycle your carrier runs. 34 hours off in a row restarts it.")}>
        <Padded>
          <Segmented<HosCycle>
            options={[
              { value: "70/8", label: t("70 h / 8 days") },
              { value: "60/7", label: t("60 h / 7 days") },
            ]}
            value={hos.cycle}
            onChange={async (cycle) => setHos(await api.put<HosView>("/v1/me/hos-settings", { cycle }))}
          />
        </Padded>
      </Section>
      <Section title={t("Duty log, last 8 days")} footer={t("Driving and On duty marked Auto were set from the truck's movement: driving when it moves, on duty after 5 minutes stopped.")}>
        {hos.log?.length ? null : <Empty title={t("No duty changes yet")} message={t("Set your status above when you start your day.")} />}
        {hos.log?.map((e) => (
          <Row
            key={`${e.at}-${e.status}`}
            title={t(DUTY[e.status])}
            subtitle={`${new Date(e.at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${e.note ? ` · ${e.note}` : ""}`}
            value={t(e.source === "AUTO" ? "Auto" : "You")}
          />
        ))}
      </Section>
    </Screen>
  );
}
