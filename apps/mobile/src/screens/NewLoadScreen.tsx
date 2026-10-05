import { useState } from "react";
import { api, errorMessage } from "../api/client";
import type { Load } from "../api/types";
import { notify } from "../ui/dialog";
import { useNav } from "../navigation/types";
import { useMe } from "../state/MeProvider";
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
  const set = (k: keyof StopForm) => (t: string) => onChange({ ...value, [k]: t });
  return (
    <Section title={title}>
      <Padded>
        <Field label="Location name" value={value.name} onChangeText={set("name")} />
        <Field label="Street address" value={value.line1} onChangeText={set("line1")} textContentType="streetAddressLine1" />
        <Field label="City" value={value.city} onChangeText={set("city")} textContentType="addressCity" />
        <Field label="State" value={value.state} onChangeText={(t) => set("state")(t.toUpperCase())} maxLength={2} autoCapitalize="characters" />
        <Field label="ZIP" value={value.postalCode} onChangeText={set("postalCode")} keyboardType="number-pad" textContentType="postalCode" />
        <Field label="Window opens" value={value.start} onChangeText={set("start")} placeholder="2026-10-06 08:00" hint="Local time, YYYY-MM-DD HH:MM" />
        <Field label="Window closes" value={value.end} onChangeText={set("end")} placeholder="2026-10-06 12:00" />
        <Field label="Coordinates (optional)" value={value.coords} onChangeText={set("coords")} placeholder="40.8091, -73.8752" hint="Leave blank: the address is placed on the map automatically" />
      </Padded>
    </Section>
  );
}

export function NewLoadScreen() {
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

  if (!orgId) return <Banner tone="warning" title="Register a shipper or 3PL company first" message="Loads are created on behalf of a company." />;
  const org = shipOrgs.find((o) => o.id === orgId)!;

  const stop = (type: "PICKUP" | "DELIVERY", s: StopForm) => {
    const start = parseLocal(s.start);
    const end = parseLocal(s.end);
    if (!start || !end) throw new Error(`Enter ${type.toLowerCase()} window times as YYYY-MM-DD HH:MM`);
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
      if (load.warnings?.length) notify("Load created", `Check these addresses before dispatch:\n${load.warnings.join("\n")}`);
      nav.goBack();
      nav.navigate("LoadDetail", { id: load.id });
    } catch (e) {
      notify("Couldn't create the load", errorMessage(e));
    }
  };

  return (
    <Screen>
      <Section title="Shipment">
        <Padded>
          <Segmented options={[{ value: "FTL", label: "Full truckload" }, { value: "LTL", label: "LTL" }, { value: "PARTIAL", label: "Partial" }]} value={mode} onChange={setMode} />
          <Segmented options={[{ value: "STANDARD", label: "Standard" }, { value: "EXPEDITED", label: "Expedited" }, { value: "TEAM_EXPEDITED", label: "Team" }]} value={service} onChange={setService} />
          <Segmented options={[{ value: "DRY_VAN", label: "Van" }, { value: "REEFER", label: "Reefer" }, { value: "FLATBED", label: "Flatbed" }, { value: "STEP_DECK", label: "Step deck" }]} value={equipment} onChange={setEquipment} />
        </Padded>
      </Section>
      <StopFields title="Pickup" value={pickup} onChange={setPickup} />
      <StopFields title="Delivery" value={delivery} onChange={setDelivery} />
      <Section title="Freight">
        <Padded>
          <Field label="Description" value={description} onChangeText={setDescription} />
          <Field label="Pallets" value={pieces} onChangeText={setPieces} keyboardType="number-pad" />
          <Field label="Total weight (lb)" value={weight} onChangeText={setWeight} keyboardType="number-pad" />
          <Field label="Target rate (USD, optional)" value={rate} onChangeText={setRate} keyboardType="decimal-pad" />
          <Field label="BOL number" value={bol} onChangeText={setBol} autoCapitalize="characters" />
          <Field label="PO numbers" value={po} onChangeText={setPo} hint="Separate with commas" autoCapitalize="characters" />
          <Field label="Notes for the carrier" value={notes} onChangeText={setNotes} multiline />
          <Button title="Create load" disabled={!Number(weight) || !pickup.city || !delivery.city} onPress={submit} />
        </Padded>
      </Section>
    </Screen>
  );
}
