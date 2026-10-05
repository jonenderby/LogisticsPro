import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Platform, Share, View } from "react-native";
import { api, errorMessage } from "../api/client";
import { useMe } from "../state/MeProvider";
import { Body, Button, Chip, Empty, Field, Padded, Row, Screen, Section, Segmented } from "../ui/components";
import { notify } from "../ui/dialog";

interface Report {
  quarter: string;
  from: string;
  to: string;
  totalMiles: number;
  totalGallons: number;
  mpg?: number;
  rows: Array<{ jurisdiction: string; name?: string; member: boolean; miles: number; taxableGallons?: number; paidGallons: number; netGallons?: number }>;
  vehicles: Array<{ vehicle: string; label: string; miles: number; gallons: number }>;
}
interface Purchase {
  id: string;
  date: string;
  jurisdiction: string;
  gallons: number;
  amount?: number;
  vendor?: string;
  vehicle: string;
}

const quarters = (today = new Date()) => {
  const out: string[] = [];
  let y = today.getUTCFullYear();
  let q = Math.floor(today.getUTCMonth() / 3) + 1;
  for (let i = 0; i < 4; i++) {
    out.push(`${y}-Q${q}`);
    if (--q === 0) {
      q = 4;
      y--;
    }
  }
  return out;
};
const n = (v?: number) => (v === undefined ? "–" : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));

/**
 * Fuel tax (IFTA). Miles by state and province come from the trucks'
 * location trails. Drivers log fuel; the owner and billing see the quarter,
 * ready to file, and can export it.
 */
export function FuelTaxScreen() {
  const { me, orgsWithRole } = useMe();
  const carriers = (me?.orgs ?? []).filter((o) => o.kinds.includes("CARRIER"));
  const [orgId, setOrgId] = useState(carriers[0]?.id);
  const office = !!orgId && orgsWithRole("OWNER", "ADMIN", "BILLING").includes(orgId);
  const [quarter, setQuarter] = useState(quarters()[0]!);
  const [report, setReport] = useState<Report>();
  const [fuel, setFuel] = useState<Purchase[]>([]);
  const [form, setForm] = useState({ date: new Date().toISOString().slice(0, 10), jurisdiction: "", gallons: "", amount: "", vendor: "" });

  const load = useCallback(async () => {
    if (!orgId) return;
    setFuel(await api.get<Purchase[]>(`/v1/orgs/${orgId}/fuel-purchases?quarter=${quarter}`).catch(() => []));
    setReport(office ? await api.get<Report>(`/v1/orgs/${orgId}/ifta?quarter=${quarter}`).catch(() => undefined) : undefined);
  }, [orgId, quarter, office]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  if (!orgId) return <Screen><Empty title="Fuel tax is for carriers" message="Join or register a trucking company first." /></Screen>;

  const add = async () => {
    try {
      await api.post(`/v1/orgs/${orgId}/fuel-purchases`, { date: form.date, jurisdiction: form.jurisdiction.trim().toUpperCase(), gallons: Number(form.gallons), amount: Number(form.amount) || undefined, vendor: form.vendor.trim() || undefined });
      setForm({ ...form, gallons: "", amount: "", vendor: "" });
      await load();
    } catch (e) {
      notify("Couldn't save the fuel purchase", errorMessage(e));
    }
  };
  const exportCsv = async () => {
    const csv = await api.get<string>(`/v1/orgs/${orgId}/ifta?quarter=${quarter}&format=csv`).catch(() => undefined);
    if (!csv) return;
    if (Platform.OS === "web") {
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: `ifta-${quarter}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } else await Share.share({ title: `IFTA ${quarter}`, message: csv });
  };

  return (
    <Screen onRefresh={load}>
      {carriers.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, margin: 16 }}>
          {carriers.map((c) => (
            <Chip key={c.id} label={c.name} selected={c.id === orgId} onPress={() => setOrgId(c.id)} />
          ))}
        </View>
      ) : null}
      <Padded>
        <Segmented options={quarters().map((q) => ({ value: q, label: q.replace("-", " ") }))} value={quarter} onChange={setQuarter} />
      </Padded>

      {office && report ? (
        <>
          <Section title={`IFTA ${report.quarter.replace("-", " ")}`} footer={`${report.from} to ${report.to}. Miles come from the trucks' location trails; taxable gallons are each place's miles divided by the fleet's miles per gallon, less fuel bought there. Check against your ELD records before filing.`}>
            <Row title="Total miles" value={n(report.totalMiles)} />
            <Row title="Fuel bought" value={`${n(report.totalGallons)} gal`} />
            <Row title="Fleet miles per gallon" value={report.mpg ? n(report.mpg) : "Enter fuel to work it out"} />
          </Section>
          <Section title="By state and province">
            {report.rows.length === 0 ? <Empty title="No miles this quarter yet" /> : null}
            {report.rows.map((r) => (
              <Row
                key={r.jurisdiction}
                title={`${r.name ?? r.jurisdiction}${r.member ? "" : " (not IFTA)"}`}
                subtitle={`${n(r.miles)} mi · taxable ${n(r.taxableGallons)} gal · paid ${n(r.paidGallons)} gal`}
                right={r.netGallons === undefined ? undefined : <Chip label={`${r.netGallons >= 0 ? "Owe" : "Credit"} ${n(Math.abs(r.netGallons))} gal`} tone={r.netGallons > 0 ? "warning" : "success"} />}
              />
            ))}
            {report.rows.length ? (
              <Padded>
                <Button title="Export CSV" variant="tonal" onPress={exportCsv} />
              </Padded>
            ) : null}
          </Section>
          <Section title="By truck">
            {report.vehicles.map((v) => (
              <Row key={v.vehicle} title={v.label} value={`${n(v.miles)} mi · ${n(v.gallons)} gal`} />
            ))}
          </Section>
        </>
      ) : null}

      <Section title="Log fuel" footer="Enter each fill-up from the receipt. The state or province is where you bought it.">
        <Padded>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field label="Date" value={form.date} onChangeText={(v) => setForm({ ...form, date: v })} autoCapitalize="none" hint="YYYY-MM-DD" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="State or province" value={form.jurisdiction} onChangeText={(v) => setForm({ ...form, jurisdiction: v })} autoCapitalize="characters" maxLength={2} hint="e.g. TX, ON" />
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field label="Gallons" value={form.gallons} onChangeText={(v) => setForm({ ...form, gallons: v })} keyboardType="decimal-pad" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Total paid (USD, optional)" value={form.amount} onChangeText={(v) => setForm({ ...form, amount: v })} keyboardType="decimal-pad" />
            </View>
          </View>
          <Field label="Truck stop (optional)" value={form.vendor} onChangeText={(v) => setForm({ ...form, vendor: v })} />
          <Button title="Add fuel purchase" disabled={!Number(form.gallons) || form.jurisdiction.trim().length !== 2} onPress={add} />
        </Padded>
      </Section>
      <Section title={office ? "Fuel purchases" : "Your fuel purchases"}>
        {fuel.length === 0 ? <Empty title="None this quarter" /> : null}
        {fuel.map((p) => (
          <Row key={p.id} title={`${n(p.gallons)} gal · ${p.jurisdiction}`} subtitle={`${p.date}${p.vendor ? ` · ${p.vendor}` : ""}${p.amount ? ` · $${p.amount.toFixed(2)}` : ""}`} />
        ))}
      </Section>
      {!office ? <Body secondary style={{ margin: 16 }}>Your company's owner or billing team files the quarterly report.</Body> : null}
    </Screen>
  );
}
