import { useState } from "react";
import { api, errorMessage } from "../api/client";
import type { Load } from "../api/types";
import { notify } from "../ui/dialog";
import { useNav } from "../navigation/types";
import { useMe, useT } from "../state/MeProvider";
import { Banner, Button, Field, Padded, Screen, Section, Segmented } from "../ui/components";
import { parseCoords, parseLocal } from "../ui/format";

interface StopForm {
  name: string;
  line1: string;
  city: string;
  state: string;
  postalCode: string;
  coords: string;
  start: string;
  end: string;
}
const emptyStop: StopForm = { name: "", line1: "", city: "", state: "", postalCode: "", coords: "", start: "", end: "" };

function StopFields({ title, value, onChange }: { title: string; value: StopForm; onChange: (v: StopForm) => void }) {
  const t = useT();
  const set = (k: keyof StopForm) => (t: string) => onChange({ ...value, [k]: t });
  return (
    <Section title={title}>
      <Padded>
        <Field label={t("Location name")} value={value.name} onChangeText={set("name")} />
        <Field label={t("Street address")} value={value.line1} onChangeText={set("line1")} textContentType="streetAddressLine1" />
        <Field label={t("City")} value={value.city} onChangeText={set("city")} textContentType="addressCity" />
        <Field label={t("State")} value={value.state} onChangeText={(t) => set("state")(t.toUpperCase())} maxLength={2} autoCapitalize="characters" />
        <Field label="ZIP" value={value.postalCode} onChangeText={set("postalCode")} keyboardType="number-pad" textContentType="postalCode" />
        <Field label={t("Window opens")} value={value.start} onChangeText={set("start")} placeholder="2026-10-06 08:00" hint={t("Local time, YYYY-MM-DD HH:MM")} />
        <Field label={t("Window closes")} value={value.end} onChangeText={set("end")} placeholder="2026-10-06 12:00" />
        <Field label={t("Coordinates (optional)")} value={value.coords} onChangeText={set("coords")} placeholder="40.8091, -73.8752" hint={t("Leave blank: the address is placed on the map automatically")} />
      </Padded>
    </Section>
  );
}

export function NewLoadScreen() {
  const t = useT();
  const { me } = useMe();
  const nav = useNav();
  const shipOrgs = (me?.orgs ?? []).filter((o) => o.kinds.includes("SHIPPER") || o.kinds.includes("BROKER_3PL"));
  const [orgId] = useState(shipOrgs[0]?.id);
  const [pickup, setPickup] = useState<StopForm>(emptyStop);
  const [delivery, setDelivery] = useState<StopForm>(emptyStop);
  const [mode, setMode] = useState<"FTL" | "LTL" | "PARTIAL">("FTL");
  const [service, setService] = useState<"STANDARD" | "EXPEDITED" | "TEAM_EXPEDITED">("STANDARD");
  const [equipment, setEquipment] = useState<"DRY_VAN" | "REEFER" | "FLATBED" | "STEP_DECK">("DRY_VAN");
  const [description, setDescription] = useState("");
  const [pieces, setPieces] = useState("");
  const [weight, setWeight] = useState("");
  const [rate, setRate] = useState("");
  const [bol, setBol] = useState("");
  const [po, setPo] = useState("");
  const [notes, setNotes] = useState("");

  if (!orgId) return <Banner tone="warning" title={t("Register a shipper or 3PL company first")} message={t("Loads are created on behalf of a company.")} />;
  const org = shipOrgs.find((o) => o.id === orgId)!;

  const stop = (type: "PICKUP" | "DELIVERY", s: StopForm) => {
    const start = parseLocal(s.start);
    const end = parseLocal(s.end);
    if (!start || !end) throw new Error(t(type === "PICKUP" ? "Enter pickup window times as YYYY-MM-DD HH:MM" : "Enter delivery window times as YYYY-MM-DD HH:MM"));
    return { type, address: { name: s.name, line1: s.line1, city: s.city, state: s.state, postalCode: s.postalCode, country: "US", geo: parseCoords(s.coords) }, window: { start, end } };
  };

  const submit = async () => {
    try {
      const body = {
        shipperOrgId: org.id,
        brokerOrgId: org.kinds.includes("BROKER_3PL") && !org.kinds.includes("SHIPPER") ? org.id : undefined,
        mode,
        service,
        equipment: { type: equipment, lengthFt: 53 },
        references: { bol: bol || undefined, po: po ? po.split(",").map((x) => x.trim()) : [] },
        stops: [stop("PICKUP", pickup), stop("DELIVERY", delivery)],
        items: [{ description: description || "Freight", pieces: Number(pieces) || 1, packaging: "PLT", weightLb: Number(weight) }],
        rate: Number(rate) ? { amount: Number(rate), currency: "USD" } : undefined,
        notes: notes || undefined,
      };
      const load = await api.post<Load & { warnings?: string[] }>("/v1/loads", body);
      if (load.warnings?.length) notify(t("Load created"), `${t("Check these addresses before dispatch:")}\n${load.warnings.join("\n")}`);
      nav.goBack();
      nav.navigate("LoadDetail", { id: load.id });
    } catch (e) {
      notify(t("Couldn't create the load"), errorMessage(e));
    }
  };

  return (
    <Screen>
      <Section title={t("Shipment")}>
        <Padded>
          <Segmented options={[{ value: "FTL", label: t("Full truckload") }, { value: "LTL", label: "LTL" }, { value: "PARTIAL", label: t("Partial") }]} value={mode} onChange={setMode} />
          <Segmented options={[{ value: "STANDARD", label: t("Standard") }, { value: "EXPEDITED", label: t("Expedited") }, { value: "TEAM_EXPEDITED", label: t("Team") }]} value={service} onChange={setService} />
          <Segmented options={[{ value: "DRY_VAN", label: t("Van") }, { value: "REEFER", label: t("Reefer") }, { value: "FLATBED", label: t("Flatbed") }, { value: "STEP_DECK", label: t("Step deck") }]} value={equipment} onChange={setEquipment} />
        </Padded>
      </Section>
      <StopFields title={t("Pickup")} value={pickup} onChange={setPickup} />
      <StopFields title={t("Delivery")} value={delivery} onChange={setDelivery} />
      <Section title={t("Freight")}>
        <Padded>
          <Field label={t("Description")} value={description} onChangeText={setDescription} />
          <Field label={t("Pallets")} value={pieces} onChangeText={setPieces} keyboardType="number-pad" />
          <Field label={t("Total weight (lb)")} value={weight} onChangeText={setWeight} keyboardType="number-pad" />
          <Field label={t("Target rate (USD, optional)")} value={rate} onChangeText={setRate} keyboardType="decimal-pad" />
          <Field label={t("BOL number")} value={bol} onChangeText={setBol} autoCapitalize="characters" />
          <Field label={t("PO numbers")} value={po} onChangeText={setPo} hint={t("Separate with commas")} autoCapitalize="characters" />
          <Field label={t("Notes for the carrier")} value={notes} onChangeText={setNotes} multiline />
          <Button title={t("Create load")} disabled={!Number(weight) || !pickup.city || !delivery.city} onPress={submit} />
        </Padded>
      </Section>
    </Screen>
  );
}
