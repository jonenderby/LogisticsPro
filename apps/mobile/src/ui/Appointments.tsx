import { useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import { Button, Chip, Field, Padded, Row } from "./components";
import { notify } from "./dialog";
import { when } from "./format";

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

export const missTitle = (m: MissView) => `${m.stopType === "PICKUP" ? "Pickup" : "Delivery"} ${m.kind === "NO_SHOW" ? "no-show" : `late${m.minutesLate ? ` by ${m.minutesLate} min` : ""}`}`;

/**
 * One missed appointment. The business that reported it can withdraw it;
 * the carrier charged with it can respond.
 */
export function MissRow({ miss, canWithdraw, canDispute, showLoad, onChanged }: { miss: MissView; canWithdraw?: boolean; canDispute?: boolean; showLoad?: boolean; onChanged: () => unknown }) {
  const [disputing, setDisputing] = useState(false);
  const [note, setNote] = useState("");
  const act = (path: string, body?: unknown) => async () => {
    try {
      await api.post(path, body);
      setDisputing(false);
      await onChanged();
    } catch (e) {
      notify("Couldn't complete that", errorMessage(e));
    }
  };
  const open = !miss.withdrawnAt;
  return (
    <View>
      <Row
        title={`${missTitle(miss)}${showLoad ? ` · ${miss.loadNumber}` : ""}`}
        subtitle={[
          `${miss.stopCity ? `${miss.stopCity} · ` : ""}appointment ${when(miss.appointmentAt)}`,
          `Reported by ${miss.businessName} against ${miss.carrierName}${miss.note ? `: ${miss.note}` : ""}`,
          miss.dispute ? `Carrier response: ${miss.dispute.note}` : "",
        ]
          .filter(Boolean)
          .join("\n")}
        right={<Chip label={open ? (miss.dispute ? "Disputed" : "Counts") : "Withdrawn"} tone={open ? (miss.dispute ? "warning" : "danger") : "neutral"} />}
      />
      {open && (canWithdraw || (canDispute && !miss.dispute)) ? (
        <Padded>
          {canWithdraw ? <Button title="Withdraw report" variant="tonal" onPress={act(`/v1/appointment-misses/${miss.id}/withdraw`)} /> : null}
          {canDispute && !miss.dispute && !disputing ? <Button title="Dispute" variant="tonal" onPress={() => setDisputing(true)} /> : null}
          {disputing ? (
            <>
              <Field label="What happened?" value={note} onChangeText={setNote} multiline hint="The customer sees this. The ding counts until they withdraw it." />
              <Button title="Send response" disabled={!note.trim()} onPress={act(`/v1/appointment-misses/${miss.id}/dispute`, { note })} />
            </>
          ) : null}
        </Padded>
      ) : null}
    </View>
  );
}
