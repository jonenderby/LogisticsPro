import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { api } from "../api/client";
import type { Load } from "../api/types";
import { useNav, useParams } from "../navigation/types";
import { useMe } from "../state/MeProvider";
import { Button, Empty, Row, Screen, Section, Segmented, StatusPill } from "../ui/components";
import { when } from "../ui/format";

export function lane(l: Load) {
  const pu = l.stops.find((s) => s.type === "PICKUP");
  const del = [...l.stops].reverse().find((s) => s.type === "DELIVERY");
  return `${pu?.address.city}, ${pu?.address.state} → ${del?.address.city}, ${del?.address.state}`;
}

/** One list, filtered by the hats you wear (Driving, Fleet, Shipments, Brokered) — no role switching. */
export function LoadsScreen() {
  const { me } = useMe();
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

  const canCreate = me?.capabilities.includes("SHIP") || me?.capabilities.includes("BROKER");
  return (
    <Screen onRefresh={load}>
      {filters.length > 1 ? (
        <View style={{ marginHorizontal: 16, marginTop: 8 }}>
          <Segmented options={[{ value: "all", label: "All" }, ...filters.map((f) => ({ value: f.id as string, label: f.title }))]} value={filter} onChange={setFilter} />
        </View>
      ) : null}
      {canCreate ? (
        <View style={{ marginHorizontal: 16, marginTop: 12 }}>
          <Button title="New load" variant="tonal" onPress={() => nav.navigate("NewLoad")} />
        </View>
      ) : null}
      <Section>
        {loads.length === 0 ? <Empty title="No loads yet" message="Loads you drive, dispatch or ship appear here." /> : null}
        {loads.map((l) => (
          <Row key={l.id} title={`${l.loadNumber} · ${lane(l)}`} subtitle={`${when(l.stops[0]?.window.start)} · ${l.equipment.type.replace(/_/g, " ").toLowerCase()}${l.service === "TEAM_EXPEDITED" ? " · team" : ""}${l.oversize ? " · oversize" : ""}`} right={<StatusPill status={l.status} />} onPress={() => nav.navigate("LoadDetail", { id: l.id })} />
        ))}
      </Section>
    </Screen>
  );
}
