import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Alert, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { api, errorMessage } from "../api/client";
import { useNav } from "../navigation/types";
import { useMe } from "../state/MeProvider";
import { Banner, Body, Button, Chip, Field, Padded, Row, Screen, Section } from "../ui/components";
import { parseCoords, titleCase } from "../ui/format";

type Kind = "CARRIER" | "BROKER_3PL" | "SHIPPER";
const KINDS: Array<{ value: Kind; label: string }> = [
  { value: "CARRIER", label: "Carrier" },
  { value: "BROKER_3PL", label: "3PL / broker" },
  { value: "SHIPPER", label: "Shipper" },
];

/** A trucker who registers a carrier becomes an owner-operator: driving and carrier tools appear together. */
export function RegisterCompanyScreen() {
  const { me, refresh } = useMe();
  const nav = useNav();
  const [name, setName] = useState("");
  const [kinds, setKinds] = useState<Kind[]>(me?.account.profileType === "BUSINESS" ? ["SHIPPER"] : me?.account.profileType === "BROKER_3PL" ? ["BROKER_3PL"] : ["CARRIER"]);
  const [scac, setScac] = useState("");
  const [mc, setMc] = useState("");
  const [dot, setDot] = useState("");
  return (
    <Screen>
      <Section title="Company" footer="Your SCAC identifies you in EDI and carrier APIs. Carriers need one to exchange data with shippers' systems.">
        <Padded>
          <Field label="Legal name" value={name} onChangeText={setName} textContentType="organizationName" />
          <Body secondary>What does the company do? Pick all that apply.</Body>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {KINDS.map((k) => (
              <Chip key={k.value} label={k.label} selected={kinds.includes(k.value)} onPress={() => setKinds(kinds.includes(k.value) ? kinds.filter((x) => x !== k.value) : [...kinds, k.value])} />
            ))}
          </View>
          <Field label="SCAC" value={scac} onChangeText={(t) => setScac(t.toUpperCase())} maxLength={4} autoCapitalize="characters" />
          <Field label="MC number" value={mc} onChangeText={setMc} />
          <Field label="USDOT number" value={dot} onChangeText={setDot} keyboardType="number-pad" />
          <Button
            title="Register company"
            disabled={!name || kinds.length === 0}
            onPress={async () => {
              try {
                await api.post("/v1/orgs", { name, kinds, scac: scac || undefined, mcNumber: mc || undefined, dotNumber: dot || undefined });
                await refresh();
                nav.goBack();
              } catch (e) {
                Alert.alert("Couldn't register", errorMessage(e));
              }
            }}
          />
        </Padded>
      </Section>
    </Screen>
  );
}

interface OrgDetail {
  org: { id: string; name: string; kinds: Kind[]; scac?: string; mcNumber?: string; dotNumber?: string; distributionCenters: Array<{ id: string; name: string; address: { city: string; state: string } }> };
  members: Array<{ roles: string[]; account: { id: string; name: string; email: string } }>;
}

export function BusinessScreen() {
  const { me, orgsWithRole } = useMe();
  const nav = useNav();
  const adminOrgs = orgsWithRole("OWNER", "ADMIN");
  const [orgId, setOrgId] = useState(adminOrgs[0]);
  const [detail, setDetail] = useState<OrgDetail>();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"DRIVER" | "DISPATCHER" | "BILLING" | "ADMIN">("DRIVER");
  const [dc, setDc] = useState({ name: "", line1: "", city: "", state: "", postalCode: "", coords: "", zip3: "" });

  const refresh = useCallback(async () => {
    if (orgId) setDetail(await api.get<OrgDetail>(`/v1/orgs/${orgId}`));
  }, [orgId]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  if (!orgId) {
    return (
      <Screen>
        <Banner tone="info" title="No company yet" message="Register a company to manage drivers, distribution centers and integrations." />
        <View style={{ margin: 16 }}>
          <Button title="Register company" onPress={() => nav.navigate("RegisterCompany")} />
        </View>
      </Screen>
    );
  }
  const act = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      Alert.alert("Couldn't save", errorMessage(e));
    }
  };
  const isCarrier = detail?.org.kinds.includes("CARRIER");
  return (
    <Screen onRefresh={refresh}>
      {adminOrgs.length > 1 ? (
        <View style={{ flexDirection: "row", gap: 8, margin: 16, flexWrap: "wrap" }}>
          {adminOrgs.map((id) => (
            <Chip key={id} label={me?.orgs.find((o) => o.id === id)?.name ?? id} selected={id === orgId} onPress={() => setOrgId(id)} />
          ))}
        </View>
      ) : null}
      {detail ? (
        <>
          <Section title="Company">
            <Row title={detail.org.name} subtitle={detail.org.kinds.map(titleCase).join(" · ")} />
            {detail.org.scac ? <Row title="SCAC" value={detail.org.scac} /> : null}
            {detail.org.mcNumber ? <Row title="MC" value={detail.org.mcNumber} /> : null}
            <Row title="Organization ID" subtitle="Shippers use this to tender to you directly" value="Copy" onPress={() => Clipboard.setStringAsync(detail.org.id)} chevron={false} />
            <Row title="Integrations (API & EDI)" onPress={() => nav.navigate("Integrations")} />
          </Section>
          <Section title="People">
            {detail.members.map((m) => (
              <Row key={m.account.id} title={m.account.name} subtitle={`${m.account.email} · ${m.roles.map(titleCase).join(", ")}`} />
            ))}
            <Padded>
              <Field label="Add by email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" hint="They need a Logistics Pro account first." />
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                {(["DRIVER", "DISPATCHER", "BILLING", "ADMIN"] as const).map((r) => (
                  <Chip key={r} label={titleCase(r)} selected={role === r} onPress={() => setRole(r)} />
                ))}
              </View>
              <Button title="Add person" variant="tonal" disabled={!email} onPress={act(async () => { await api.post(`/v1/orgs/${orgId}/members`, { email, roles: [role] }); setEmail(""); })} />
            </Padded>
          </Section>
          {isCarrier ? (
            <Section title="Distribution centers" footer="Route LTL shipments through a DC to combine loads headed to the same area.">
              {detail.org.distributionCenters.map((d) => (
                <Row key={d.id} title={d.name} subtitle={`${d.address.city}, ${d.address.state}`} />
              ))}
              <Padded>
                <Field label="Name" value={dc.name} onChangeText={(t) => setDc({ ...dc, name: t })} />
                <Field label="Street address" value={dc.line1} onChangeText={(t) => setDc({ ...dc, line1: t })} />
                <Field label="City" value={dc.city} onChangeText={(t) => setDc({ ...dc, city: t })} />
                <Field label="State" value={dc.state} maxLength={2} autoCapitalize="characters" onChangeText={(t) => setDc({ ...dc, state: t.toUpperCase() })} />
                <Field label="ZIP" value={dc.postalCode} keyboardType="number-pad" onChangeText={(t) => setDc({ ...dc, postalCode: t })} />
                <Field label="Coordinates" value={dc.coords} placeholder="40.7066, -74.1567" onChangeText={(t) => setDc({ ...dc, coords: t })} />
                <Button
                  title="Add distribution center"
                  variant="tonal"
                  disabled={!dc.name || !parseCoords(dc.coords)}
                  onPress={act(() => api.post(`/v1/orgs/${orgId}/distribution-centers`, { name: dc.name, address: { name: dc.name, line1: dc.line1 || dc.name, city: dc.city, state: dc.state, postalCode: dc.postalCode, country: "US" }, geo: parseCoords(dc.coords) }))}
                />
              </Padded>
            </Section>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
