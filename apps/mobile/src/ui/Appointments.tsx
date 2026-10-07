import { useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import { Button, Chip, Field, Padded, Row } from "./components";
import { notify } from "./dialog";
import { when } from "./format";
import { useT } from "../state/MeProvider";
import { type Translate, translator } from "@logisticspro/workspace";

const en = translator("en");

export interface MissView {
  id: string;
  loadId: string;
  loadNumber: string;
  stopId: string;
  stopType: "PICKUP" | "DELIVERY";
  appointmentAt: string;
  kind: "LATE" | "NO_SHOW";
  minutesLate?: number;
  note: string;
  carrierKey: string;
  carrierName: string;
  businessName: string;
  stopCity?: string;
  at: string;
  withdrawnAt?: string;
  dispute?: { note: string; at: string };
}

export const missTitle = (m: MissView, t: Translate = en) =>
  t(m.kind === "NO_SHOW" ? "{stop} no-show" : m.minutesLate ? "{stop} late by {n} min" : "{stop} late", { stop: t(m.stopType === "PICKUP" ? "Pickup" : "Delivery"), n: m.minutesLate ?? 0 });

/**
 * One missed appointment. The business that reported it can withdraw it;
 * the carrier charged with it can respond.
 */
export function MissRow({ miss, canWithdraw, canDispute, showLoad, onChanged }: { miss: MissView; canWithdraw?: boolean; canDispute?: boolean; showLoad?: boolean; onChanged: () => unknown }) {
  const t = useT();
  const [disputing, setDisputing] = useState(false);
  const [note, setNote] = useState("");
  const act = (path: string, body?: unknown) => async () => {
    try {
      await api.post(path, body);
      setDisputing(false);
      await onChanged();
    } catch (e) {
      notify(t("Couldn't complete that"), errorMessage(e));
    }
  };
  const open = !miss.withdrawnAt;
  return (
    <View>
      <Row
        title={`${missTitle(miss, t)}${showLoad ? ` · ${miss.loadNumber}` : ""}`}
        subtitle={[
          `${miss.stopCity ? `${miss.stopCity} · ` : ""}${t("appointment {time}", { time: when(miss.appointmentAt) })}`,
          `${t("Reported by {business} against {carrier}", { business: miss.businessName, carrier: miss.carrierName })}${miss.note ? `: ${miss.note}` : ""}`,
          miss.dispute ? t("Carrier response: {note}", { note: miss.dispute.note }) : "",
        ]
          .filter(Boolean)
          .join("\n")}
        right={<Chip label={t(open ? (miss.dispute ? "Disputed" : "Counts") : "Withdrawn")} tone={open ? (miss.dispute ? "warning" : "danger") : "neutral"} />}
      />
      {open && (canWithdraw || (canDispute && !miss.dispute)) ? (
        <Padded>
          {canWithdraw ? <Button title={t("Withdraw report")} variant="tonal" onPress={act(`/v1/appointment-misses/${miss.id}/withdraw`)} /> : null}
          {canDispute && !miss.dispute && !disputing ? <Button title={t("Dispute")} variant="tonal" onPress={() => setDisputing(true)} /> : null}
          {disputing ? (
            <>
              <Field label={t("What happened?")} value={note} onChangeText={setNote} multiline hint={t("The customer sees this. The ding counts until they withdraw it.")} />
              <Button title={t("Send response")} disabled={!note.trim()} onPress={act(`/v1/appointment-misses/${miss.id}/dispute`, { note })} />
            </>
          ) : null}
        </Padded>
      ) : null}
    </View>
  );
}
