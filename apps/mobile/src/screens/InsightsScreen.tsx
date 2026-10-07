import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { type Translate } from "@logisticspro/workspace";
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
function delta(t: Translate, now: number | undefined, before: number | undefined, kind: "pct" | "usd" | "count") {
  if (now === undefined || before === undefined || (kind === "count" && before === 0)) return undefined;
  const d = now - before;
  const direction = Math.abs(d) < (kind === "pct" ? 0.005 : 0.005) ? ("flat" as const) : d > 0 ? ("up" as const) : ("down" as const);
  const text = kind === "pct" ? t("{n} pts vs previous period", { n: Math.abs(Math.round(d * 100)) }) : t("{n} vs previous period", { n: kind === "usd" ? usd(Math.abs(d), 2) : Math.abs(d) });
  return { direction, text };
}

/**
 * Insights for shippers and brokers: how carriers perform on time, by
 * carrier and by lane, what freight costs per mile, and how that moves
 * week to week. The filters above scope everything on the screen.
 */
export function InsightsScreen() {
  const { me, t } = useMe();
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

  if (!orgId) return <Screen><Empty title={t("Insights are for shippers and brokers")} message={t("Register a shipping or brokerage company to see carrier performance and freight costs.")} /></Screen>;
  const tot = data?.totals;
  const p = data?.previous;
  const tile = wide ? "23%" : "47%";

  return (
    <Screen onRefresh={load}>
      <View style={{ padding: 16, gap: 16 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {orgs.length > 1 ? orgs.map((o) => <Chip key={o.id} label={o.name} selected={o.id === orgId} onPress={() => setOrgId(o.id)} />) : null}
          <View style={{ minWidth: 260, flexGrow: wide ? 0 : 1 }}>
            <Segmented options={[{ value: "30", label: t("30 days") }, { value: "90", label: t("90 days") }, { value: "365", label: t("12 months") }]} value={days} onChange={setDays} />
          </View>
        </View>
        {error ? <Empty title={t("Couldn't load insights")} message={error} /> : null}
        {data && tot && p ? (
          <View style={{ gap: 16, opacity: 1 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
              <StatTile width={tile} label={t("Loads delivered")} value={tot.loads.toLocaleString()} delta={delta(t, tot.loads, p.loads, "count")} />
              <StatTile width={tile} label={t("On-time delivery")} value={pct(tot.onTimeDelivery)} delta={delta(t, tot.onTimeDelivery, p.onTimeDelivery, "pct")} />
              <StatTile width={tile} label={t("Cost per mile")} value={usd(tot.costPerMile, 2)} delta={delta(t, tot.costPerMile, p.costPerMile, "usd")} upIsGood={false} />
              <StatTile width={tile} label={t("Freight spend")} value={compactUsd(tot.spend)} />
            </View>

            {tot.loads === 0 ? (
              <Empty title={t("No deliveries in this period")} message={t("Insights fill in as your loads are delivered.")} />
            ) : (
              <>
                <View style={{ flexDirection: wide ? "row" : "column", gap: 16 }}>
                  <View style={wide ? { flex: 1 } : undefined}>
                    <ChartCard
                      title={t("On-time delivery by carrier")}
                      subtitle={t("Share of deliveries within the appointment window · {pct} overall", { pct: pct(tot.onTimeDelivery) })}
                      footer={<Button title={t(carrierTable ? "Hide table" : "Show as table")} variant="plain" onPress={() => setCarrierTable(!carrierTable)} />}
                    >
                      <BarList
                        accessibilityLabel={t("On-time delivery by carrier")}
                        max={1}
                        rows={data.byCarrier.map((c) => ({ key: c.carrierKey, label: c.name, value: c.onTimeDelivery ?? 0, valueLabel: c.onTimeDelivery === undefined ? t("not judged") : pct(c.onTimeDelivery), detail: `${t(c.loads === 1 ? "{n} load" : "{n} loads", { n: c.loads })} · ${t("on-time pickup {pct}", { pct: pct(c.onTimePickup) })} · ${usd(c.costPerMile, 2)}/mi` }))}
                      />
                      {carrierTable ? (
                        <DataTable
                          columns={[{ title: t("Carrier"), flex: 2 }, { title: t("Loads"), align: "right" }, { title: t("On-time delivery"), align: "right" }, { title: t("On-time pickup"), align: "right" }, { title: "$/mi", align: "right" }]}
                          rows={data.byCarrier.map((c) => [c.name, String(c.loads), pct(c.onTimeDelivery), pct(c.onTimePickup), usd(c.costPerMile, 2)])}
                        />
                      ) : null}
                    </ChartCard>
                  </View>
                  <View style={wide ? { flex: 1 } : undefined}>
                    <ChartCard
                      title={t("Cost per mile by week")}
                      subtitle={t("Agreed rate over loaded miles, for loads delivered each week")}
                      footer={<Button title={t(trendTable ? "Hide table" : "Show as table")} variant="plain" onPress={() => setTrendTable(!trendTable)} />}
                    >
                      <LineChart
                        accessibilityLabel={t("Cost per mile by week")}
                        format={(v) => `$${v.toFixed(2)}`}
                        points={data.weekly.map((w) => ({ key: w.weekStart, label: t("Week of {date}", { date: week(w.weekStart, days === "365") }), value: w.costPerMile, detail: `${t(w.loads === 1 ? "{n} load" : "{n} loads", { n: w.loads })}${w.onTimeDelivery !== undefined ? ` · ${t("{pct} on time", { pct: pct(w.onTimeDelivery) })}` : ""}` }))}
                      />
                      {trendTable ? (
                        <DataTable
                          columns={[{ title: t("Week of"), flex: 2 }, { title: t("Loads"), align: "right" }, { title: "$/mi", align: "right" }, { title: t("On time"), align: "right" }]}
                          rows={data.weekly.map((w) => [week(w.weekStart, days === "365"), String(w.loads), usd(w.costPerMile, 2), pct(w.onTimeDelivery)])}
                        />
                      ) : null}
                    </ChartCard>
                  </View>
                </View>
                <ChartCard title={t("Lanes")} subtitle={t("Your busiest lanes in this period")}>
                  <DataTable
                    columns={[{ title: t("Lane"), flex: wide ? 3 : 2 }, { title: t("Loads"), align: "right" }, { title: t("On time"), align: "right" }, { title: t("Avg rate"), align: "right" }, { title: "$/mi", align: "right" }]}
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
