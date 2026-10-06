import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import { useMe } from "../state/MeProvider";
import { BarList, ChartCard, DataTable, LineChart, StatTile } from "../ui/charts";
import { Button, Chip, Empty, Screen, Segmented } from "../ui/components";
import { useLayout } from "../ui/responsive";

interface Totals {
  loads: number;
  spend: number;
  miles: number;
  costPerMile?: number;
  onTimeDelivery?: number;
  onTimePickup?: number;
  damageFree?: number;
}
interface Analytics {
  from: string;
  to: string;
  totals: Totals;
  previous: Totals;
  byCarrier: Array<Totals & { carrierKey: string; name: string }>;
  byLane: Array<Totals & { lane: string; averageRate: number }>;
  weekly: Array<{ weekStart: string; loads: number; costPerMile?: number; onTimeDelivery?: number }>;
}

const pct = (v?: number) => (v === undefined ? "–" : `${Math.round(v * 100)}%`);
const usd = (v?: number, digits = 0) => (v === undefined ? "–" : `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);
const compactUsd = (v: number) => (v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : v >= 10_000 ? `$${(v / 1000).toFixed(1)}K` : usd(v));
const week = (iso: string, withYear = false) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });

/** Change against the previous period, as a signed amount. */
function delta(now: number | undefined, before: number | undefined, kind: "pct" | "usd" | "count") {
  if (now === undefined || before === undefined || (kind === "count" && before === 0)) return undefined;
  const d = now - before;
  const direction = Math.abs(d) < (kind === "pct" ? 0.005 : 0.005) ? ("flat" as const) : d > 0 ? ("up" as const) : ("down" as const);
  const text = kind === "pct" ? `${Math.abs(Math.round(d * 100))} pts vs previous period` : kind === "usd" ? `${usd(Math.abs(d), 2)} vs previous period` : `${Math.abs(d)} vs previous period`;
  return { direction, text };
}

/**
 * Insights for shippers and brokers: how carriers perform on time, by
 * carrier and by lane, what freight costs per mile, and how that moves
 * week to week. The filters above scope everything on the screen.
 */
export function InsightsScreen() {
  const { me } = useMe();
  const { wide } = useLayout();
  const orgs = (me?.orgs ?? []).filter((o) => (o.kinds.includes("SHIPPER") || o.kinds.includes("BROKER_3PL")) && o.roles.some((r) => r !== "DRIVER"));
  const [orgId, setOrgId] = useState(orgs[0]?.id);
  const [days, setDays] = useState<"30" | "90" | "365">("90");
  const [data, setData] = useState<Analytics>();
  const [error, setError] = useState<string>();
  const [trendTable, setTrendTable] = useState(false);
  const [carrierTable, setCarrierTable] = useState(false);
  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      setData(await api.get<Analytics>(`/v1/orgs/${orgId}/analytics?days=${days}`));
      setError(undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [orgId, days]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!orgId) return <Screen><Empty title="Insights are for shippers and brokers" message="Register a shipping or brokerage company to see carrier performance and freight costs." /></Screen>;
  const t = data?.totals;
  const p = data?.previous;
  const tile = wide ? "23%" : "47%";

  return (
    <Screen onRefresh={load}>
      <View style={{ padding: 16, gap: 16 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {orgs.length > 1 ? orgs.map((o) => <Chip key={o.id} label={o.name} selected={o.id === orgId} onPress={() => setOrgId(o.id)} />) : null}
          <View style={{ minWidth: 260, flexGrow: wide ? 0 : 1 }}>
            <Segmented options={[{ value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "365", label: "12 months" }]} value={days} onChange={setDays} />
          </View>
        </View>
        {error ? <Empty title="Couldn't load insights" message={error} /> : null}
        {data && t && p ? (
          <View style={{ gap: 16, opacity: 1 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
              <StatTile width={tile} label="Loads delivered" value={t.loads.toLocaleString()} delta={delta(t.loads, p.loads, "count")} />
              <StatTile width={tile} label="On-time delivery" value={pct(t.onTimeDelivery)} delta={delta(t.onTimeDelivery, p.onTimeDelivery, "pct")} />
              <StatTile width={tile} label="Cost per mile" value={usd(t.costPerMile, 2)} delta={delta(t.costPerMile, p.costPerMile, "usd")} upIsGood={false} />
              <StatTile width={tile} label="Freight spend" value={compactUsd(t.spend)} />
            </View>

            {t.loads === 0 ? (
              <Empty title="No deliveries in this period" message="Insights fill in as your loads are delivered." />
            ) : (
              <>
                <View style={{ flexDirection: wide ? "row" : "column", gap: 16 }}>
                  <View style={wide ? { flex: 1 } : undefined}>
                    <ChartCard
                      title="On-time delivery by carrier"
                      subtitle={`Share of deliveries within the appointment window · ${pct(t.onTimeDelivery)} overall`}
                      footer={<Button title={carrierTable ? "Hide table" : "Show as table"} variant="plain" onPress={() => setCarrierTable(!carrierTable)} />}
                    >
                      <BarList
                        accessibilityLabel="On-time delivery by carrier"
                        max={1}
                        rows={data.byCarrier.map((c) => ({ key: c.carrierKey, label: c.name, value: c.onTimeDelivery ?? 0, valueLabel: c.onTimeDelivery === undefined ? "not judged" : pct(c.onTimeDelivery), detail: `${c.loads} load${c.loads === 1 ? "" : "s"} · on-time pickup ${pct(c.onTimePickup)} · ${usd(c.costPerMile, 2)}/mi` }))}
                      />
                      {carrierTable ? (
                        <DataTable
                          columns={[{ title: "Carrier", flex: 2 }, { title: "Loads", align: "right" }, { title: "On-time delivery", align: "right" }, { title: "On-time pickup", align: "right" }, { title: "$/mi", align: "right" }]}
                          rows={data.byCarrier.map((c) => [c.name, String(c.loads), pct(c.onTimeDelivery), pct(c.onTimePickup), usd(c.costPerMile, 2)])}
                        />
                      ) : null}
                    </ChartCard>
                  </View>
                  <View style={wide ? { flex: 1 } : undefined}>
                    <ChartCard
                      title="Cost per mile by week"
                      subtitle="Agreed rate over loaded miles, for loads delivered each week"
                      footer={<Button title={trendTable ? "Hide table" : "Show as table"} variant="plain" onPress={() => setTrendTable(!trendTable)} />}
                    >
                      <LineChart
                        accessibilityLabel="Cost per mile by week"
                        format={(v) => `$${v.toFixed(2)}`}
                        points={data.weekly.map((w) => ({ key: w.weekStart, label: `Week of ${week(w.weekStart, days === "365")}`, value: w.costPerMile, detail: `${w.loads} load${w.loads === 1 ? "" : "s"}${w.onTimeDelivery !== undefined ? ` · ${pct(w.onTimeDelivery)} on time` : ""}` }))}
                      />
                      {trendTable ? (
                        <DataTable
                          columns={[{ title: "Week of", flex: 2 }, { title: "Loads", align: "right" }, { title: "$/mi", align: "right" }, { title: "On time", align: "right" }]}
                          rows={data.weekly.map((w) => [week(w.weekStart, days === "365"), String(w.loads), usd(w.costPerMile, 2), pct(w.onTimeDelivery)])}
                        />
                      ) : null}
                    </ChartCard>
                  </View>
                </View>
                <ChartCard title="Lanes" subtitle="Your busiest lanes in this period">
                  <DataTable
                    columns={[{ title: "Lane", flex: wide ? 3 : 2 }, { title: "Loads", align: "right" }, { title: "On time", align: "right" }, { title: "Avg rate", align: "right" }, { title: "$/mi", align: "right" }]}
                    rows={data.byLane.map((l) => [l.lane, String(l.loads), pct(l.onTimeDelivery), usd(l.averageRate), usd(l.costPerMile, 2)])}
                  />
                </ChartCard>
              </>
            )}
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
