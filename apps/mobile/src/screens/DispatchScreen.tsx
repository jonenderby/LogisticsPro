import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import type { LoadDetail } from "../api/types";
import { useParams } from "../navigation/types";
import { notify } from "../ui/dialog";
import { Banner, Body, Button, Chip, Field, Padded, Row, Screen, Section } from "../ui/components";
import { parseCoords, titleCase } from "../ui/format";
import { useT } from "../state/MeProvider";

interface Driver {
  id: string;
  name: string;
  reliability?: { overall: { score: number | null }; forBusiness?: { score: number | null; shipments: number } };
}
interface Transit {
  miles: number;
  solo: { totalHours: number };
  team: { totalHours: number };
}

/** Assign drivers or two-driver teams per leg, and break long hauls into relays. */
export function DispatchScreen() {
  const t = useT();
  const { loadId } = useParams<"Dispatch">();
  const [load, setLoad] = useState<LoadDetail>();
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [transit, setTransit] = useState<Transit>();
  const [relay, setRelay] = useState({ name: "", line1: "", city: "", state: "", postalCode: "", coords: "" });

  const refresh = useCallback(async () => {
    const l = await api.get<LoadDetail>(`/v1/loads/${loadId}`);
    setLoad(l);
    setPicked(Object.fromEntries(l.legs.map((leg) => [leg.id, leg.driverAccountIds])));
    if (l.carrierOrgId) setDrivers(await api.get<Driver[]>(`/v1/orgs/${l.carrierOrgId}/drivers?businessOrgId=${l.brokerOrgId ?? l.shipperOrgId}`));
    setTransit(await api.get<Transit>(`/v1/loads/${loadId}/transit`).catch(() => undefined));
  }, [loadId]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  if (!load) return null;

  const team = load.teamRequired || load.service === "TEAM_EXPEDITED";
  const legs = load.legs.length ? load.legs : [{ id: "first", sequence: 1, fromStopId: load.stops[0]!.id, toStopId: load.stops[load.stops.length - 1]!.id, driverAccountIds: [], status: "PLANNED" as const }];
  const toggle = (legId: string, driverId: string) =>
    setPicked((p) => {
      const cur = p[legId] ?? [];
      const next = cur.includes(driverId) ? cur.filter((d) => d !== driverId) : [...cur, driverId].slice(-2);
      return { ...p, [legId]: next };
    });
  const act = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      notify(t("Couldn't update dispatch"), errorMessage(e));
    }
  };

  return (
    <Screen onRefresh={refresh}>
      {team ? <Banner tone="warning" title={t("Team required")} message={t("Assign two drivers to every leg of this expedited load.")} /> : null}
      {transit ? (
        <Section title={t("Transit estimate")} footer={t("Hours-of-service estimate: 11 h driving per shift with a 10 h reset for a solo driver.")}>
          <Row title={t("Distance")} value={`${transit.miles.toLocaleString()} mi`} />
          <Row title={t("Solo driver")} value={`${Math.round(transit.solo.totalHours)} h`} />
          <Row title={t("Team")} value={`${Math.round(transit.team.totalHours)} h`} />
        </Section>
      ) : null}
      {legs.map((leg) => {
        const from = load.stops.find((s) => s.id === leg.fromStopId)?.address.city;
        const to = load.stops.find((s) => s.id === leg.toStopId)?.address.city;
        const sel = picked[leg.id] ?? [];
        return (
          <Section key={leg.id} title={`Leg ${leg.sequence}: ${from} → ${to}`} footer={titleCase(leg.status)}>
            <Padded>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {drivers.map((d) => {
                  const s = d.reliability?.forBusiness?.shipments ? d.reliability.forBusiness.score : d.reliability?.overall.score;
                  return <Chip key={d.id} label={`${d.name}${s !== null && s !== undefined ? ` · ${s}%` : ""}`} selected={sel.includes(d.id)} onPress={() => toggle(leg.id, d.id)} />;
                })}
              </View>
              {drivers.length === 0 ? <Body secondary>{t("No drivers yet. Share your join code under Business.")}</Body> : <Body secondary>{t("Scores show each driver's record with this customer (or overall if they have not run for them yet).")}</Body>}
              <Button title={t(sel.length === 2 ? "Assign team" : "Assign driver")} disabled={sel.length === 0 || leg.status === "COMPLETED"} onPress={act(() => api.post(`/v1/loads/${load.id}/legs/${leg.id}/assign`, { driverAccountIds: sel }))} />
            </Padded>
          </Section>
        );
      })}
      {["BOOKED", "DISPATCHED"].includes(load.status) ? (
        <Section title={t("Add a relay")} footer={t("The truck stops here and a fresh driver or team takes the trailer the rest of the way.")}>
          <Padded>
            <Field label={t("Relay location name")} value={relay.name} onChangeText={(t) => setRelay({ ...relay, name: t })} />
            <Field label={t("Street address")} value={relay.line1} onChangeText={(t) => setRelay({ ...relay, line1: t })} />
            <Field label={t("City")} value={relay.city} onChangeText={(t) => setRelay({ ...relay, city: t })} />
            <Field label={t("State")} value={relay.state} maxLength={2} autoCapitalize="characters" onChangeText={(t) => setRelay({ ...relay, state: t.toUpperCase() })} />
            <Field label="ZIP" value={relay.postalCode} keyboardType="number-pad" onChangeText={(t) => setRelay({ ...relay, postalCode: t })} />
            <Field label={t("Coordinates")} value={relay.coords} placeholder="36.1447, -86.7341" onChangeText={(t) => setRelay({ ...relay, coords: t })} />
            <Button
              title={t("Add relay point")}
              variant="tonal"
              disabled={!relay.city || !relay.state || !relay.postalCode}
              onPress={act(() => api.post(`/v1/loads/${load.id}/relay`, { points: [{ address: { name: relay.name || `${relay.city} relay`, line1: relay.line1 || "Relay point", city: relay.city, state: relay.state, postalCode: relay.postalCode, country: "US", geo: parseCoords(relay.coords) } }] }))}
            />
          </Padded>
        </Section>
      ) : null}
    </Screen>
  );
}
