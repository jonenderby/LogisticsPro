import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { api } from "../api/client";
import type { Load } from "../api/types";
import { useNav, useParams } from "../navigation/types";
import { useMe } from "../state/MeProvider";
import { Button, Empty, Row, Screen, Section, Segmented, StatusPill } from "../ui/components";
import { money, titleCase, when } from "../ui/format";
import { useLayout } from "../ui/responsive";
import { useTheme } from "../ui/theme";

export function lane(l: Load) {
  const pu = l.stops.find((s) => s.type === "PICKUP");
  const del = [...l.stops].reverse().find((s) => s.type === "DELIVERY");
  return `${pu?.address.city}, ${pu?.address.state} → ${del?.address.city}, ${del?.address.state}`;
}

/** One list, filtered by the hats you wear (Driving, Fleet, Shipments, Brokered) — no role switching. */
export function LoadsScreen() {
  const { me, t } = useMe();
  const nav = useNav();
  const params = useParams<"Loads">();
  const filters = me?.workspace.loadFilters ?? [];
  const [filter, setFilter] = useState<string>(params?.filter ?? "all");
  const [loads, setLoads] = useState<Load[]>([]);

  const load = useCallback(async () => {
    setLoads(await api.get<Load[]>(`/v1/loads${filter === "all" ? "" : `?filter=${filter}`}`));
  }, [filter]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const { wide } = useLayout();
  const canCreate = me?.capabilities.includes("SHIP") || me?.capabilities.includes("BROKER");
  return (
    <Screen onRefresh={load}>
      {filters.length > 1 ? (
        <View style={{ marginHorizontal: 16, marginTop: 8 }}>
          <Segmented options={[{ value: "all", label: t("All") }, ...filters.map((f) => ({ value: f.id as string, label: t(f.title) }))]} value={filter} onChange={setFilter} />
        </View>
      ) : null}
      {canCreate ? (
        <View style={{ marginHorizontal: 16, marginTop: 12 }}>
          <Button title={t("New load")} variant="tonal" onPress={() => nav.navigate("NewLoad")} />
        </View>
      ) : null}
      <Section>
        {loads.length === 0 ? <Empty title={t("No loads yet")} message={t("Loads you drive, dispatch or ship appear here.")} /> : null}
        {wide && loads.length ? (
          <LoadsTable loads={loads} onOpen={(id) => nav.navigate("LoadDetail", { id })} />
        ) : (
          loads.map((l) => (
            <Row key={l.id} title={`${l.loadNumber} · ${lane(l)}`} subtitle={`${when(l.stops[0]?.window.start)} · ${l.equipment.type.replace(/_/g, " ").toLowerCase()}${l.service === "TEAM_EXPEDITED" ? " · team" : ""}${l.oversize ? " · oversize" : ""}`} right={<StatusPill status={l.status} />} onPress={() => nav.navigate("LoadDetail", { id: l.id })} />
          ))
        )}
      </Section>
    </Screen>
  );
}

const COLUMNS = [
  { key: "load", title: "Load", flex: 1 },
  { key: "lane", title: "Lane", flex: 2.4 },
  { key: "pickup", title: "Pickup", flex: 1.3 },
  { key: "equipment", title: "Equipment", flex: 1.2 },
  { key: "rate", title: "Rate", flex: 1 },
  { key: "status", title: "Status", flex: 1.2 },
] as const;

/** Desktop: the same loads as a scannable table. */
function LoadsTable({ loads, onOpen }: { loads: Load[]; onOpen: (id: string) => void }) {
  const { colors, metrics } = useTheme();
  const cell = (flex: number) => ({ flex, paddingHorizontal: 12, paddingVertical: 12, justifyContent: "center" as const });
  return (
    <View accessibilityRole="list">
      <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.separator }}>
        {COLUMNS.map((c) => (
          <Text key={c.key} style={[cell(c.flex), { color: colors.textSecondary, fontSize: metrics.caption, fontWeight: "600" }]}>
            {c.title}
          </Text>
        ))}
      </View>
      {loads.map((l) => (
        <Pressable key={l.id} accessibilityRole="link" onPress={() => onOpen(l.id)} style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => ({ flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: colors.separator, backgroundColor: hovered || pressed ? colors.surfaceVariant : "transparent" })}>
          <Text style={[cell(1), { color: colors.primary, fontWeight: "600", fontSize: metrics.callout }]}>{l.loadNumber}</Text>
          <Text style={[cell(2.4), { color: colors.text, fontSize: metrics.callout }]}>{lane(l)}</Text>
          <Text style={[cell(1.3), { color: colors.text, fontSize: metrics.callout }]}>{when(l.stops[0]?.window.start)}</Text>
          <Text style={[cell(1.2), { color: colors.text, fontSize: metrics.callout }]}>
            {titleCase(l.equipment.type)}
            {l.service === "TEAM_EXPEDITED" ? " · team" : ""}
            {l.oversize ? " · oversize" : ""}
          </Text>
          <Text style={[cell(1), { color: colors.text, fontSize: metrics.callout }]}>{money(l.rate?.amount)}</Text>
          <View style={cell(1.2)}>
            <StatusPill status={l.status} />
          </View>
        </Pressable>
      ))}
    </View>
  );
}
