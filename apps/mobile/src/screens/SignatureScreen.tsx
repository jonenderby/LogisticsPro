import * as Location from "expo-location";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { reportStatus } from "../actions";
import { api, errorMessage } from "../api/client";
import type { Load } from "../api/types";
import { useNav, useParams } from "../navigation/types";
import { Banner, Body, Button, Field, Padded, Screen, Section } from "../ui/components";
import { confirm, notify } from "../ui/dialog";
import { type Signature, SignaturePad } from "../ui/SignaturePad";

/**
 * The receiver signs for the freight on the driver's phone. The signed
 * receipt, with pieces and any damage noted, becomes the load's POD.
 */
export function SignatureScreen() {
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
      nav.setOptions({ title: `Sign for ${l.loadNumber}` });
    });
  }, [loadId, nav]);
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
      if (load.status === "AT_DELIVERY" && (await confirm("Receipt saved", "Mark the load delivered now?", "Mark delivered"))) await reportStatus(loadId, "DELIVERED");
      else notify("Receipt saved", "It's on the load as the POD.");
      nav.goBack();
    } catch (e) {
      notify("Couldn't save the receipt", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <Banner tone="info" title={`Hand the phone to the receiver${consignee ? ` at ${consignee.address.name}` : ""}`} message={`${total} pieces · ${load.items.map((i) => i.description).join(", ")}${load.references.po.length ? ` · PO ${load.references.po.join(", ")}` : ""}`} />
      <Section title="Received">
        <Padded>
          <Field label="Receiver's name" value={name} onChangeText={setName} autoCapitalize="words" />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field label={`Pieces received (of ${total})`} value={pieces} onChangeText={setPieces} keyboardType="number-pad" />
            </View>
          </View>
          <Field label="Shortage, damage or other exceptions" value={exceptions} onChangeText={setExceptions} placeholder="Leave blank if received in good order" multiline />
        </Padded>
      </Section>
      <Section title="Signature">
        <Padded>
          <SignaturePad value={sig} onChange={setSig} />
          <Body secondary style={{ marginTop: 6 }}>Sign above the line.</Body>
          <Button title="Clear" variant="plain" disabled={!sig.strokes.length} onPress={() => setSig({ width: sig.width, height: sig.height, strokes: [] })} />
        </Padded>
      </Section>
      <Padded>
        <Button title="Save signed receipt" loading={saving} disabled={name.trim().length < 2 || !sig.strokes.length || Number.isNaN(Number(pieces))} onPress={save} />
      </Padded>
    </Screen>
  );
}
