import * as Location from "expo-location";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { reportStatus } from "../actions";
import { api, errorMessage } from "../api/client";
import type { Load } from "../api/types";
import { useNav, useParams } from "../navigation/types";
import { useT } from "../state/MeProvider";
import { Banner, Body, Button, Field, Padded, Screen, Section } from "../ui/components";
import { confirm, notify } from "../ui/dialog";
import { type Signature, SignaturePad } from "../ui/SignaturePad";

/**
 * The receiver signs for the freight on the driver's phone. The signed
 * receipt, with pieces and any damage noted, becomes the load's POD.
 */
export function SignatureScreen() {
  const t = useT();
  const { loadId } = useParams<"Signature">();
  const nav = useNav();
  const [load, setLoad] = useState<Load>();
  const [name, setName] = useState("");
  const [pieces, setPieces] = useState("");
  const [exceptions, setExceptions] = useState("");
  const [sig, setSig] = useState<Signature>({ width: 0, height: 0, strokes: [] });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void api.get<Load>(`/v1/loads/${loadId}`).then((l) => {
      setLoad(l);
      setPieces(String(l.items.reduce((s, i) => s + i.pieces, 0)));
      nav.setOptions({ title: t("Sign for {n}", { n: l.loadNumber }) });
    });
  }, [loadId, nav, t]);
  if (!load) return null;
  const total = load.items.reduce((s, i) => s + i.pieces, 0);
  const consignee = [...load.stops].sort((a, b) => a.sequence - b.sequence).filter((s) => s.type === "DELIVERY").at(-1);

  const save = async () => {
    try {
      setSaving(true);
      let geo: { lat: number; lng: number } | undefined;
      try {
        if ((await Location.getForegroundPermissionsAsync()).granted) {
          const pos = await Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000 });
          if (pos) geo = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        }
      } catch {
        // Location is optional on the receipt.
      }
      await api.post(`/v1/loads/${loadId}/pod`, { receiverName: name.trim(), width: sig.width, height: sig.height, strokes: sig.strokes, piecesReceived: Number(pieces), exceptions: exceptions.trim() || undefined, geo });
      if (load.status === "AT_DELIVERY" && (await confirm(t("Receipt saved"), t("Mark the load delivered now?"), t("Mark delivered")))) await reportStatus(loadId, "DELIVERED");
      else notify(t("Receipt saved"), t("It's on the load as the POD."));
      nav.goBack();
    } catch (e) {
      notify(t("Couldn't save the receipt"), errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <Banner tone="info" title={consignee ? t("Hand the phone to the receiver at {place}", { place: consignee.address.name }) : t("Hand the phone to the receiver")} message={`${t("{n} pieces", { n: total })} · ${load.items.map((i) => i.description).join(", ")}${load.references.po.length ? ` · PO ${load.references.po.join(", ")}` : ""}`} />
      <Section title={t("Received")}>
        <Padded>
          <Field label={t("Receiver's name")} value={name} onChangeText={setName} autoCapitalize="words" />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field label={t("Pieces received (of {n})", { n: total })} value={pieces} onChangeText={setPieces} keyboardType="number-pad" />
            </View>
          </View>
          <Field label={t("Shortage, damage or other exceptions")} value={exceptions} onChangeText={setExceptions} placeholder={t("Leave blank if received in good order")} multiline />
        </Padded>
      </Section>
      <Section title={t("Signature")}>
        <Padded>
          <SignaturePad value={sig} onChange={setSig} />
          <Body secondary style={{ marginTop: 6 }}>{t("Sign above the line.")}</Body>
          <Button title={t("Clear")} variant="plain" disabled={!sig.strokes.length} onPress={() => setSig({ width: sig.width, height: sig.height, strokes: [] })} />
        </Padded>
      </Section>
      <Padded>
        <Button title={t("Save signed receipt")} loading={saving} disabled={name.trim().length < 2 || !sig.strokes.length || Number.isNaN(Number(pieces))} onPress={save} />
      </Padded>
    </Screen>
  );
}
