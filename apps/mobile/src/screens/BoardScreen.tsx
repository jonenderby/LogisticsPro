import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { api } from "../api/client";
import type { Load } from "../api/types";
import { useNav } from "../navigation/types";
import { useMe } from "../state/MeProvider";
import { Banner, Button, Chip, Empty, Row, Screen, Section } from "../ui/components";
import { money, titleCase, when } from "../ui/format";
import { lane } from "./LoadsScreen";

export function BoardScreen() {
  const { has } = useMe();
  const nav = useNav();
  const [loads, setLoads] = useState<Load[]>([]);
  const [teamOnly, setTeamOnly] = useState(false);
  const refresh = useCallback(async () => {
    if (has("BID")) setLoads(await api.get<Load[]>(`/v1/board${teamOnly ? "?team=true" : ""}`));
  }, [has, teamOnly]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  if (!has("BID")) {
    return (
      <Screen>
        <Banner tone="info" title="Brokered loads you post appear in Loads" message="Carriers bid on them from their board; review bids on each load." />
        <View style={{ margin: 16 }}>
          <Button title="New load" onPress={() => nav.navigate("NewLoad")} />
        </View>
      </Screen>
    );
  }
  return (
    <Screen onRefresh={refresh}>
      <View style={{ flexDirection: "row", gap: 8, marginHorizontal: 16, marginTop: 8 }}>
        <Chip label="All loads" selected={!teamOnly} onPress={() => setTeamOnly(false)} />
        <Chip label="Team expedited" selected={teamOnly} onPress={() => setTeamOnly(true)} />
      </View>
      <Section>
        {loads.length === 0 ? <Empty title="No open loads" message="Pull to refresh. New brokered loads appear here." /> : null}
        {loads.map((l) => (
          <Row key={l.id} title={lane(l)} subtitle={`${l.loadNumber} · ${when(l.stops[0]?.window.start)} · ${titleCase(l.equipment.type)}${l.service === "TEAM_EXPEDITED" ? " · team" : ""}`} value={money(l.rate?.amount)} onPress={() => nav.navigate("LoadDetail", { id: l.id })} />
        ))}
      </Section>
    </Screen>
  );
}
