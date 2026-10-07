import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Platform, Share, View } from "react-native";
import { api, errorMessage } from "../api/client";
import { useMe, useT } from "../state/MeProvider";
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
  vehicleLabel?: string;
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
  const t = useT();
  const { me, orgsWithRole, has } = useMe();
  const carriers = (me?.orgs ?? []).filter((o) => o.kinds.includes("CARRIER"));
  const [orgId, setOrgId] = useState(carriers[0]?.id);
  const office = !!orgId && orgsWithRole("OWNER", "ADMIN", "BILLING").includes(orgId);
  const [quarter, setQuarter] = useState(quarters()[0]!);
  const [report, setReport] = useState<Report>();
  const [fuel, setFuel] = useState<Purchase[]>([]);
  const [form, setForm] = useState({ date: new Date().toISOString().slice(0, 10), jurisdiction: "", gallons: "", amount: "", vendor: "" });
  const [trucks, setTrucks] = useState<Array<{ vehicle: string; label: string }>>([]);
  /** The office picks the truck; a driver's fill-up goes to the truck they are driving unless they pick another. */
  const [truck, setTruck] = useState<string>();
  const drives = has("DRIVE");

  const load = useCallback(async () => {
    if (!orgId) return;
    setFuel(await api.get<Purchase[]>(`/v1/orgs/${orgId}/fuel-purchases?quarter=${quarter}`).catch(() => []));
    setReport(office ? await api.get<Report>(`/v1/orgs/${orgId}/ifta?quarter=${quarter}`).catch(() => undefined) : undefined);
    setTrucks(office ? await api.get<Array<{ vehicle: string; label: string }>>(`/v1/orgs/${orgId}/fuel-vehicles`).catch(() => []) : []);
  }, [orgId, quarter, office]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  if (!orgId) return <Screen><Empty title={t("Fuel tax is for carriers")} message={t("Join or register a trucking company first.")} /></Screen>;

  const add = async () => {
    try {
      await api.post(`/v1/orgs/${orgId}/fuel-purchases`, { date: form.date, jurisdiction: form.jurisdiction.trim().toUpperCase(), gallons: Number(form.gallons), amount: Number(form.amount) || undefined, vendor: form.vendor.trim() || undefined, vehicle: truck });
      setForm({ ...form, gallons: "", amount: "", vendor: "" });
      await load();
    } catch (e) {
      notify(t("Couldn't save the fuel purchase"), errorMessage(e));
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
          <Section title={`IFTA ${report.quarter.replace("-", " ")}`} footer={t("{from} to {to}. Miles come from the trucks' location trails; taxable gallons are each place's miles divided by the fleet's miles per gallon, less fuel bought there. Check against your ELD records before filing.", { from: report.from, to: report.to })}>
            <Row title={t("Total miles")} value={n(report.totalMiles)} />
            <Row title={t("Fuel bought")} value={`${n(report.totalGallons)} gal`} />
            <Row title={t("Fleet miles per gallon")} value={report.mpg ? n(report.mpg) : t("Enter fuel to work it out")} />
          </Section>
          <Section title={t("By state and province")}>
            {report.rows.length === 0 ? <Empty title={t("No miles this quarter yet")} /> : null}
            {report.rows.map((r) => (
              <Row
                key={r.jurisdiction}
                title={`${r.name ?? r.jurisdiction}${r.member ? "" : " (not IFTA)"}`}
                subtitle={`${n(r.miles)} mi · taxable ${n(r.taxableGallons)} gal · paid ${n(r.paidGallons)} gal`}
                right={r.netGallons === undefined ? undefined : <Chip label={r.netGallons === 0 ? "Even" : `${r.netGallons > 0 ? "Owe" : "Credit"} ${n(Math.abs(r.netGallons))} gal`} tone={r.netGallons > 0 ? "warning" : "success"} />}
              />
            ))}
            {report.rows.length ? (
              <Padded>
                <Button title={t("Export CSV")} variant="tonal" onPress={exportCsv} />
              </Padded>
            ) : null}
          </Section>
          <Section title={t("By truck")}>
            {report.vehicles.map((v) => (
              <Row key={v.vehicle} title={v.label} value={`${n(v.miles)} mi · ${n(v.gallons)} gal`} />
            ))}
          </Section>
        </>
      ) : null}

      <Section title={t("Log fuel")} footer={t("Enter each fill-up from the receipt. The state or province is where you bought it.")}>
        <Padded>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field label={t("Date")} value={form.date} onChangeText={(v) => setForm({ ...form, date: v })} autoCapitalize="none" hint="YYYY-MM-DD" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label={t("State or province")} value={form.jurisdiction} onChangeText={(v) => setForm({ ...form, jurisdiction: v })} autoCapitalize="characters" maxLength={2} hint={t("e.g. TX, ON")} />
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field label={t("Gallons")} value={form.gallons} onChangeText={(v) => setForm({ ...form, gallons: v })} keyboardType="decimal-pad" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label={t("Total paid (USD, optional)")} value={form.amount} onChangeText={(v) => setForm({ ...form, amount: v })} keyboardType="decimal-pad" />
            </View>
          </View>
          <Field label={t("Truck stop (optional)")} value={form.vendor} onChangeText={(v) => setForm({ ...form, vendor: v })} />
          {trucks.length ? <Body secondary style={{ marginBottom: 6 }}>{t("Truck")}</Body> : null}
          {trucks.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 }} accessibilityLabel={t("Truck")}>
              {drives ? <Chip label={t("The truck I'm driving")} selected={!truck} onPress={() => setTruck(undefined)} /> : null}
              {trucks.map((t) => (
                <Chip key={t.vehicle} label={t.label} selected={truck === t.vehicle} onPress={() => setTruck(t.vehicle)} />
              ))}
            </View>
          ) : null}
          <Button title={t("Add fuel purchase")} disabled={!Number(form.gallons) || form.jurisdiction.trim().length !== 2 || (!drives && !truck)} onPress={add} />
        </Padded>
      </Section>
      <Section title={office ? t("Fuel purchases") : t("Your fuel purchases")}>
        {fuel.length === 0 ? <Empty title={t("None this quarter")} /> : null}
        {fuel.map((p) => (
          <Row key={p.id} title={`${n(p.gallons)} gal · ${p.jurisdiction}`} subtitle={`${p.date}${office && p.vehicleLabel ? ` · ${p.vehicleLabel}` : ""}${p.vendor ? ` · ${p.vendor}` : ""}${p.amount ? ` · $${p.amount.toFixed(2)}` : ""}`} />
        ))}
      </Section>
      {!office ? <Body secondary style={{ margin: 16 }}>{t("Your company's owner or billing team files the quarterly report.")}</Body> : null}
    </Screen>
  );
}
