import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import type { Load } from "../api/types";
import { useNav } from "../navigation/types";
import { useMe } from "../state/MeProvider";
import { Banner, Button, Chip, Empty, Row, Screen, Section } from "../ui/components";
import { money, titleCase, when } from "../ui/format";
import { lane } from "./LoadsScreen";

interface Suggestion {
  loadId: string;
  loadNumber: string;
  origin: string;
  destination: string;
  rate?: { amount: number };
  deadheadMiles: number;
  loadedMiles: number;
  ratePerMile?: number;
  pickupAt: string;
  deliveryAt: string;
  feasible: boolean;
  reasons: string[];
}
interface Suggestions {
  driver: { accountId: string; name: string };
  from: { at: string; source: "PHONE" | "CHOSEN" };
  hours?: { availableMin: number };
  suggestions: Suggestion[];
}

/**
 * Loads a driver can legally take from where they are on the hours they
 * have left. Drivers see their own; dispatchers pick a driver.
 */
function SuggestedLoads() {
  const { me, has, orgsWithRole } = useMe();
  const nav = useNav();
  const [drivers, setDrivers] = useState<Array<{ id: string; name: string }>>([]);
  const [driverId, setDriverId] = useState<string>();
  const [data, setData] = useState<Suggestions>();
  const [error, setError] = useState<string>();
  const [all, setAll] = useState(false);
  const dispatchOrg = orgsWithRole("OWNER", "ADMIN", "DISPATCHER").find((id) => me?.orgs.find((o) => o.id === id)?.kinds.includes("CARRIER"));
  const load = useCallback(async () => {
    if (dispatchOrg && !drivers.length) {
      const list = await api.get<Array<{ id: string; name: string }>>(`/v1/orgs/${dispatchOrg}/drivers`).catch(() => []);
      setDrivers(list);
      if (!driverId && !has("DRIVE") && list[0]) setDriverId(list[0].id);
    }
    const who = driverId ?? (has("DRIVE") ? me?.account.id : undefined);
    if (!who) return;
    try {
      setData(await api.get<Suggestions>(`/v1/board/suggestions${who === me?.account.id ? "" : `?driverAccountId=${who}`}`));
      setError(undefined);
    } catch (e) {
      setData(undefined);
      setError(errorMessage(e));
    }
  }, [dispatchOrg, drivers.length, driverId, has, me]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  if (!has("DRIVE") && !dispatchOrg) return null;
  const list = data?.suggestions.filter((s) => all || s.feasible) ?? [];
  return (
    <Section title={data ? `Suggested for ${data.driver.accountId === me?.account.id ? "you" : data.driver.name}` : "Suggested loads"} footer="Loads the driver can reach in the pickup window and deliver in the delivery window from where they are, under hours-of-service rules. Best pay per mile, empty miles included, first.">
      {drivers.length > (has("DRIVE") ? 0 : 1) ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 16, paddingBottom: 0 }}>
          {has("DRIVE") ? <Chip label="Me" selected={!driverId || driverId === me?.account.id} onPress={() => setDriverId(me?.account.id)} /> : null}
          {drivers.filter((d) => d.id !== me?.account.id).map((d) => (
            <Chip key={d.id} label={d.name} selected={driverId === d.id} onPress={() => setDriverId(d.id)} />
          ))}
        </View>
      ) : null}
      {error ? <Empty title="No suggestions yet" message={error} /> : null}
      {data && !list.length ? <Empty title="Nothing reachable right now" message="No open load fits this driver's location and hours." /> : null}
      {list.slice(0, all ? 30 : 5).map((s) => (
        <Row
          key={s.loadId}
          title={`${s.origin} → ${s.destination}`}
          subtitle={`${s.loadNumber} · ${s.deadheadMiles} mi empty · ${s.loadedMiles} mi loaded${s.ratePerMile ? ` · $${s.ratePerMile.toFixed(2)}/mi` : ""}\nPickup ${when(s.pickupAt)} · deliver ${when(s.deliveryAt)}${s.reasons.length ? `\n${s.reasons.join(". ")}` : ""}`}
          value={money(s.rate?.amount)}
          right={s.feasible ? undefined : <Chip label="Can't make it" tone="danger" />}
          onPress={() => nav.navigate("LoadDetail", { id: s.loadId })}
        />
      ))}
      {data?.suggestions.length ? <Row title={all ? "Show only loads the driver can take" : "Show all, with why not"} onPress={() => setAll(!all)} /> : null}
    </Section>
  );
}

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
      <SuggestedLoads />
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
