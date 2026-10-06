import { tx } from "@logisticspro/workspace";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { api } from "../api/client";
import { useNav } from "../navigation/types";
import { useMe, useT } from "../state/MeProvider";
import { Banner, Body, Chip, Empty, Row, Screen, Section, Segmented, type Tone } from "../ui/components";
import { FleetMap } from "../ui/FleetMap";
import type { MapMarker } from "../ui/FleetMap.types";
import { useLayout } from "../ui/responsive";
import { useTheme } from "../ui/theme";
import { type Arrival, ARRIVAL, ArrivalChip, type Eta, ago, etaLine } from "../ui/arrival";

interface Shipment {
  id: string;
  loadNumber: string;
  status: string;
  origin: string;
  destination: string;
  carrierName?: string;
  customerName?: string;
  eta: Eta;
  truck?: { geo: { lat: number; lng: number }; at: string; stale: boolean };
}
interface FleetDriver {
  accountId: string;
  name: string;
  state: "ON_LOAD" | "AVAILABLE" | "OFFLINE" | "OTHER_CARRIER";
  position?: { geo: { lat: number; lng: number }; at: string; speedMps?: number; stale: boolean };
  load?: { id: string; loadNumber: string; status: string; origin: string; destination: string; customerName?: string; eta: Eta };
}
type Summary = Record<Arrival, number>;

function Tiles({ items }: { items: Array<{ label: string; value: number; tone: Tone }> }) {
  const { colors, metrics } = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginHorizontal: 16, marginTop: 12 }}>
      {items.map((t) => (
        <View key={t.label} accessible accessibilityLabel={`${t.value} ${t.label}`} style={{ flexGrow: 1, flexBasis: 120, backgroundColor: colors.surface, borderRadius: metrics.radius, padding: 12, borderWidth: 0.5, borderColor: colors.separator }}>
          <Text style={{ color: colors.text, fontSize: 28, fontWeight: "700" }}>{t.value}</Text>
          <Chip label={t.label} tone={t.tone} />
        </View>
      ))}
    </View>
  );
}

const STATE: Record<FleetDriver["state"], { label: string; tone: Tone }> = {
  ON_LOAD: { label: tx("On a load"), tone: "info" },
  AVAILABLE: { label: tx("Available"), tone: "success" },
  OFFLINE: { label: tx("Offline"), tone: "neutral" },
  OTHER_CARRIER: { label: tx("Other carrier"), tone: "neutral" },
};

/** Shippers and 3PLs: every undelivered shipment with its ETA and arrival status. */
function Shipments() {
  const t = useT();
  const nav = useNav();
  const { wide } = useLayout();
  const { colors, metrics, dark } = useTheme();
  const [data, setData] = useState<{ summary: Summary; shipments: Shipment[] }>();
  const [filter, setFilter] = useState<"ALL" | Arrival>("ALL");
  const load = useCallback(async () => setData(await api.get("/v1/tracking/shipments")), []);
  usePolling(load);
  if (!data) return null;
  const list = data.shipments.filter((s) => filter === "ALL" || s.eta.status === filter);
  const markers: MapMarker[] = data.shipments.filter((s) => s.truck).map((s) => ({ id: s.id, geo: s.truck!.geo, color: ARRIVAL[s.eta.status].color, title: s.loadNumber, subtitle: `${t(ARRIVAL[s.eta.status].label)} · ${s.destination}` }));
  return (
    <>
      <Tiles items={(["LATE", "AT_RISK", "ON_TIME", "EARLY"] as Arrival[]).map((k) => ({ label: ARRIVAL[k].label, value: data.summary[k], tone: ARRIVAL[k].tone }))} />
      {markers.length ? (
        <Section title={t("Trucks moving your freight")}>
          <FleetMap markers={markers} height={wide ? 380 : 260} dark={dark} onSelect={(id) => nav.navigate("LoadDetail", { id })} />
        </Section>
      ) : null}
      <View style={{ marginHorizontal: 16, marginTop: 16 }}>
        <Segmented options={[{ value: "ALL", label: t("All {n}", { n: data.shipments.length }) }, ...(["LATE", "AT_RISK", "ON_TIME", "EARLY"] as Arrival[]).map((k) => ({ value: k, label: ARRIVAL[k].label }))]} value={filter} onChange={(v) => setFilter(v as typeof filter)} />
      </View>
      <Section title={t("Undelivered shipments")} footer={t("ETAs use the truck's latest location, the stops still ahead and driving-hour rules; a recent ETA from the carrier takes precedence.")}>
        {list.length === 0 ? <Empty title={t("Nothing here")} message={t("Shipments appear once they are posted or tendered.")} /> : null}
        {list.map((s) =>
          wide ? (
            <Pressable key={s.id} accessibilityRole="link" onPress={() => nav.navigate("LoadDetail", { id: s.id })} style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => ({ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 0.5, borderBottomColor: colors.separator, backgroundColor: hovered || pressed ? colors.surfaceVariant : "transparent" })}>
              <Text style={{ width: 110, color: colors.primary, fontWeight: "600", fontSize: metrics.callout }}>{s.loadNumber}</Text>
              <Text style={{ flex: 2, color: colors.text, fontSize: metrics.callout }}>{`${s.origin} → ${s.destination}`}</Text>
              <Text style={{ flex: 1.2, color: colors.text, fontSize: metrics.callout }}>{s.carrierName ?? "—"}</Text>
              <Text style={{ flex: 2.6, color: colors.text, fontSize: metrics.callout }}>{etaLine(s.eta, t)}</Text>
              <View style={{ width: 90 }}>
                <ArrivalChip eta={s.eta} />
              </View>
              <Text style={{ flex: 2, color: colors.textSecondary, fontSize: metrics.caption }}>{s.eta.reasons[0]}</Text>
            </Pressable>
          ) : (
            <Row key={s.id} title={`${s.loadNumber} · ${s.origin} → ${s.destination}`} subtitle={`${etaLine(s.eta, t)}\n${s.carrierName ? `${s.carrierName} · ` : ""}${s.eta.reasons[0] ?? ""}`} right={<ArrivalChip eta={s.eta} />} onPress={() => nav.navigate("LoadDetail", { id: s.id })} />
          ),
        )}
      </Section>
    </>
  );
}

/** Carriers: every truck under the carrier's umbrella. */
function Fleet() {
  const t = useT();
  const nav = useNav();
  const { wide } = useLayout();
  const { dark } = useTheme();
  const [data, setData] = useState<{ name: string; summary: Summary; trucks: { total: number; onLoad: number; available: number; offline: number; otherCarrier?: number }; drivers: FleetDriver[] }>();
  const load = useCallback(async () => setData(await api.get("/v1/tracking/fleet")), []);
  usePolling(load);
  if (!data) return null;
  const color = (d: FleetDriver) => (d.load ? ARRIVAL[d.load.eta.status].color : d.state === "AVAILABLE" ? "#5B7BB5" : "#9E9EA3");
  const markers: MapMarker[] = data.drivers.filter((d) => d.position).map((d) => ({ id: d.accountId, geo: d.position!.geo, color: color(d), title: d.name, subtitle: d.load ? `${d.load.loadNumber} · ${t(ARRIVAL[d.load.eta.status].label)}` : d.state === "AVAILABLE" ? t("Available") : t("Last seen {ago}", { ago: ago(d.position!.at, t) }) }));
  const openDriver = (id: string) => {
    const d = data.drivers.find((x) => x.accountId === id);
    if (d?.load) nav.navigate("LoadDetail", { id: d.load.id });
  };
  return (
    <>
      <Tiles
        items={[
          { label: t("On a load"), value: data.trucks.onLoad, tone: "info" },
          { label: t("Available"), value: data.trucks.available, tone: "success" },
          { label: t("Offline"), value: data.trucks.offline, tone: "neutral" },
          ...(data.trucks.otherCarrier ? [{ label: t("With another carrier"), value: data.trucks.otherCarrier, tone: "neutral" as Tone }] : []),
          { label: t("Late"), value: data.summary.LATE, tone: "danger" },
          { label: t("At risk"), value: data.summary.AT_RISK, tone: "warning" },
        ]}
      />
      <Section title={`${data.name} · ${t("{n} trucks", { n: data.trucks.total })}`}>
        {markers.length ? <FleetMap markers={markers} height={wide ? 420 : 280} dark={dark} onSelect={openDriver} /> : <Empty title={t("No locations yet")} message={t("Drivers' positions appear while they have a load and the app open.")} />}
      </Section>
      <Section title={t("Drivers")}>
        {data.drivers.map((d) => (
          <Row
            key={d.accountId}
            title={d.name}
            subtitle={d.load ? `${d.load.loadNumber} · ${d.load.origin} → ${d.load.destination}\n${etaLine(d.load.eta, t)}${d.load.eta.reasons[0] ? `\n${d.load.eta.reasons[0]}` : ""}` : d.state === "OTHER_CARRIER" ? t("Driving a load for another carrier they work with") : `${t(d.state === "AVAILABLE" ? "Available" : "Offline")} · ${t("last seen {ago}", { ago: ago(d.position?.at, t) })}`}
            right={d.load ? <ArrivalChip eta={d.load.eta} /> : <Chip label={STATE[d.state].label} tone={STATE[d.state].tone} />}
            onPress={d.load ? () => nav.navigate("LoadDetail", { id: d.load!.id }) : undefined}
          />
        ))}
      </Section>
    </>
  );
}

/** Refresh every 30 seconds while the screen is visible. */
function usePolling(fn: () => Promise<void>) {
  useFocusEffect(
    useCallback(() => {
      void fn();
      const t = setInterval(() => void fn().catch(() => undefined), 30_000);
      return () => clearInterval(t);
    }, [fn]),
  );
}

export function TrackScreen() {
  const t = useT();
  const { has } = useMe();
  const shipper = has("SHIP") || has("BROKER");
  const carrier = has("DISPATCH");
  const [view, setView] = useState<"shipments" | "fleet">(shipper ? "shipments" : "fleet");
  useEffect(() => setView(shipper ? "shipments" : "fleet"), [shipper]);
  const nav = useNav();
  useEffect(() => nav.setOptions({ title: shipper ? "Tracking" : "Fleet" }), [nav, shipper]);
  if (!shipper && !carrier) return <Screen><Banner tone="info" title={t("Tracking is for carriers, shippers and 3PLs")} /></Screen>;
  return (
    <Screen>
      {shipper && carrier ? (
        <View style={{ marginHorizontal: 16, marginTop: 8 }}>
          <Segmented options={[{ value: "shipments", label: t("Shipments") }, { value: "fleet", label: t("Fleet") }]} value={view} onChange={setView} />
        </View>
      ) : null}
      {view === "shipments" ? <Shipments /> : <Fleet />}
      <Body secondary style={{ margin: 16, fontSize: 12 }}>{t("Updates every 30 seconds.")}</Body>
    </Screen>
  );
}
