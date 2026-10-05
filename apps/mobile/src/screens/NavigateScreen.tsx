import { type GpsFix, type NavEvent, type NavState, OversizeNavigationSession, type Route, StandardNavigationSession, type TruckProfile } from "@logisticspro/navigation";
import { useFocusEffect } from "@react-navigation/native";
import { useKeepAwake } from "expo-keep-awake";
import * as Location from "expo-location";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, Vibration, View } from "react-native";
import { api, errorMessage } from "../api/client";
import type { Load } from "../api/types";
import { useNav, useParams } from "../navigation/types";
import { Banner, Button, Empty, Field, Screen } from "../ui/components";
import { miles } from "../ui/format";
import { useTheme } from "../ui/theme";
import { MapPanel } from "./nav/MapPanel";

type Plan =
  | { mode: "STANDARD"; route: Route }
  | { mode: "OVERSIZE"; truck: TruckProfile; corridor: Array<{ lat: number; lng: number }>; conflicts: Array<{ kind: string; message: string }>; escortsRequired: number };

type Session = StandardNavigationSession | OversizeNavigationSession;

function KeepAwake() {
  useKeepAwake();
  return null;
}

/**
 * Standard loads: truck-legal turn-by-turn with automatic rerouting.
 * Oversize loads: the permitted route is the only route. No rerouting;
 * leaving the corridor raises an alarm, guides the driver back and
 * notifies dispatch.
 */
export function NavigateScreen() {
  const params = useParams<"Navigate">();
  const nav = useNav();
  const { colors, metrics, dark } = useTheme();
  const [load, setLoad] = useState<Load>();
  const [plan, setPlan] = useState<Plan>();
  const [state, setState] = useState<NavState>();
  const [alerts, setAlerts] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [tracking, setTracking] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ label: string; geo: { lat: number; lng: number } }>>([]);
  const [destination, setDestination] = useState<string>();
  /** Set while navigating to a searched address instead of the load's stops. */
  const adHoc = useRef<{ label: string; geo: { lat: number; lng: number } } | undefined>(undefined);
  const session = useRef<Session | undefined>(undefined);
  const watch = useRef<Location.LocationSubscription | undefined>(undefined);
  const replanning = useRef(false);

  const pickLoad = useCallback(async () => {
    if (params?.loadId) return setLoad(await api.get<Load>(`/v1/loads/${params.loadId}`));
    const mine = await api.get<Load[]>("/v1/loads?filter=driving&status=DISPATCHED,AT_PICKUP,IN_TRANSIT,AT_DELIVERY,BOOKED");
    setLoad(mine[0]);
  }, [params?.loadId]);
  useFocusEffect(
    useCallback(() => {
      void pickLoad();
    }, [pickLoad]),
  );
  useEffect(() => () => watch.current?.remove(), []);

  const position = async () => {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) throw new Error("Location permission is needed for navigation. Turn it on in Settings.");
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.BestForNavigation });
    return { lat: p.coords.latitude, lng: p.coords.longitude };
  };

  const prepare = async () => {
    if (!load) return;
    setError(undefined);
    try {
      const from = await position();
      adHoc.current = undefined;
      setDestination(undefined);
      const p = await api.post<Plan>(`/v1/loads/${load.id}/navigation/plan`, load.oversize ? { departAt: new Date().toISOString() } : { from });
      setPlan(p);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  /** Search for any address (fuel, parking, a shop) near the truck. */
  const search = async () => {
    setError(undefined);
    try {
      const here = await position().catch(() => undefined);
      setResults(await api.get(`/v1/geocode?q=${encodeURIComponent(query)}${here ? `&lat=${here.lat}&lng=${here.lng}` : ""}`));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const goTo = async (dest: { label: string; geo: { lat: number; lng: number } }) => {
    setError(undefined);
    try {
      const from = await position();
      const r = await api.post<{ route: Route; destination: { label: string } }>("/v1/navigation/route", { from, to: { geo: dest.geo, query: dest.label }, loadId: load?.id });
      adHoc.current = dest;
      setDestination(r.destination.label);
      setPlan({ mode: "STANDARD", route: r.route });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const addressSearch = (
    <>
      <View style={{ marginHorizontal: 16, marginTop: 16 }}>
        <Field label="Go to an address" value={query} onChangeText={setQuery} placeholder="Truck stop, shop or street address" returnKeyType="search" onSubmitEditing={search} />
        <Button title="Search" variant="tonal" disabled={query.trim().length < 3} onPress={search} />
      </View>
      {results.length ? (
        <View style={{ marginTop: 8 }}>
          {results.map((r, i) => (
            <View key={i} style={{ marginHorizontal: 16, marginTop: 8 }}>
              <Button title={r.label} variant="plain" onPress={() => goTo(r)} />
            </View>
          ))}
        </View>
      ) : null}
    </>
  );

  const report = (body: object) => (load ? api.post(`/v1/loads/${load.id}/navigation/violations`, body).catch(() => undefined) : undefined);

  const handle = async (events: NavEvent[], fix: GpsFix) => {
    const s = session.current!;
    for (const e of events) {
      switch (e.type) {
        case "REROUTE_REQUIRED":
          if (s instanceof StandardNavigationSession && !replanning.current) {
            replanning.current = true;
            const p = adHoc.current
              ? await api.post<Plan>("/v1/navigation/route", { from: e.from, to: { geo: adHoc.current.geo, query: adHoc.current.label }, loadId: load?.id }).catch(() => undefined)
              : await api.post<Plan>(`/v1/loads/${load!.id}/navigation/plan`, { from: e.from }).catch(() => undefined);
            if (p?.mode === "STANDARD") {
              s.replaceRoute(p.route);
              setPlan(p);
            }
            replanning.current = false;
          }
          break;
        case "CORRIDOR_VIOLATION":
          Vibration.vibrate([0, 600, 250, 600, 250, 600]);
          setAlerts((a) => [`Off the permitted route by ${e.deviationM} m. Dispatch${e.notify.includes("ESCORT") ? " and escorts were" : " was"} notified. Follow the arrow back.`, ...a].slice(0, 4));
          void report({ startedAt: fix.at, maxDeviationM: e.deviationM, firstPoint: { lat: fix.lat, lng: fix.lng } });
          break;
        case "RETURNED_TO_CORRIDOR": {
          const v = (s as OversizeNavigationSession).violations.at(-1);
          if (v) void report(v);
          setAlerts((a) => [`Back on the permitted route after ${Math.round(e.outsideForS / 60)} min.`, ...a].slice(0, 4));
          break;
        }
        case "CORRIDOR_WARNING":
          Vibration.vibrate(200);
          break;
        case "WRONG_DIRECTION":
          Vibration.vibrate([0, 400, 200, 400]);
          setAlerts((a) => ["You are driving the wrong way on the permitted route.", ...a].slice(0, 4));
          break;
        case "RESTRICTION_AHEAD":
          setAlerts((a) => [`${e.restriction.description} in ${miles(e.distanceM)}${e.clears ? "" : ". YOUR LOAD DOES NOT CLEAR — stop and call dispatch."}`, ...a].slice(0, 4));
          if (!e.clears) Vibration.vibrate([0, 800, 300, 800]);
          break;
        case "TRAVEL_WINDOW_CLOSED":
          setAlerts((a) => [e.reason, ...a].slice(0, 4));
          break;
        case "ARRIVED":
          watch.current?.remove();
          setTracking(false);
          break;
        default:
          break;
      }
    }
  };

  const start = async () => {
    if (!plan) return;
    session.current =
      plan.mode === "STANDARD"
        ? new StandardNavigationSession(plan.route)
        : new OversizeNavigationSession(load!.oversize!.permits, plan.truck, { corridorHalfWidthM: 30, escorts: plan.escortsRequired });
    setAlerts([]);
    setTracking(true);
    watch.current = await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 10, timeInterval: 2000 }, (loc) => {
      const fix: GpsFix = { lat: loc.coords.latitude, lng: loc.coords.longitude, at: new Date(loc.timestamp).toISOString(), speedMps: loc.coords.speed ?? undefined, accuracyM: loc.coords.accuracy ?? undefined };
      const s = session.current!.update(fix);
      setState({ ...s, snapped: s.snapped });
      void handle(s.events, fix);
    });
  };

  const stop = () => {
    watch.current?.remove();
    setTracking(false);
  };

  if (!load && !plan) {
    return (
      <Screen>
        <Empty title="No load to navigate" message="Loads assigned to you appear here when they are dispatched." action={<Button title="View loads" variant="tonal" onPress={() => nav.navigate("Loads", { filter: "driving" })} />} />
        {error ? <Banner tone="danger" title="Couldn't plan the trip" message={error} /> : null}
        {addressSearch}
      </Screen>
    );
  }

  if (!plan && load) {
    return (
      <Screen>
        <Banner tone={load.oversize ? "warning" : "info"} title={load.oversize ? "Oversize load: strict permitted-route navigation" : `Navigate ${load.loadNumber}`} message={load.oversize ? "You will be held to the state permit route. Rerouting is disabled and leaving the route alerts dispatch." : "Truck-legal routing that respects height, weight and hazmat restrictions."} />
        {error ? <Banner tone="danger" title="Couldn't plan the trip" message={error} /> : null}
        <View style={{ margin: 16 }}>
          <Button title={load.oversize ? "Check permits and route" : "Plan route"} onPress={prepare} />
        </View>
        {load.oversize ? null : addressSearch}
      </Screen>
    );
  }
  if (!plan) return null;

  const line = plan.mode === "STANDARD" ? plan.route.geometry : plan.corridor;
  const blocked = plan.mode === "OVERSIZE" && plan.conflicts.length > 0;
  const off = state?.status === "OFF_CORRIDOR" || state?.status === "OFF_ROUTE";
  const eta = state ? new Date(Date.now() + state.etaS * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {tracking ? <KeepAwake /> : null}
      <View accessibilityLiveRegion="polite" style={{ padding: 14, backgroundColor: off ? colors.danger : plan.mode === "OVERSIZE" ? colors.warningContainer : colors.primary }}>
        {off && state?.guidance ? (
          <Text style={{ color: "#fff", fontSize: 22, fontWeight: "700" }}>
            Return to route: head {compass(state.guidance.bearingDeg)} for {miles(state.guidance.distanceM)}
          </Text>
        ) : state?.nextManeuver ? (
          <Text style={{ color: plan.mode === "OVERSIZE" ? colors.warning : colors.onPrimary, fontSize: 22, fontWeight: "700" }}>
            {miles(state.distanceToManeuverM ?? 0)} · {state.nextManeuver.instruction}
          </Text>
        ) : (
          <Text style={{ color: plan.mode === "OVERSIZE" ? colors.warning : colors.onPrimary, fontSize: 20, fontWeight: "700" }}>{plan.mode === "OVERSIZE" ? "Permitted route only · rerouting disabled" : destination ?? load?.loadNumber}</Text>
        )}
        {state?.status === "DRIFTING" ? <Text style={{ color: colors.warning, fontWeight: "600" }}>Drifting toward the edge of the permitted corridor</Text> : null}
      </View>
      {blocked ? (
        <View>
          {plan.conflicts.map((c, i) => (
            <Banner key={i} tone="danger" title={c.kind.replace(/_/g, " ")} message={c.message} />
          ))}
          <Banner tone="warning" title="Resolve with dispatch before departing" message="Navigation unlocks when the permits and route check out." />
        </View>
      ) : null}
      {alerts.map((a, i) => (
        <Banner key={i} tone={i === 0 && off ? "danger" : "warning"} title={a} />
      ))}
      <View style={{ flex: 1, marginTop: 8 }}>
        <MapPanel line={line} mode={plan.mode} position={state ? state.snapped : undefined} target={off ? state?.guidance?.target : undefined} dark={dark} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", padding: 12, gap: 12, backgroundColor: colors.surface }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.text, fontSize: metrics.title, fontWeight: "700" }}>{state ? miles(state.remainingM) : miles(plan.mode === "STANDARD" ? plan.route.distanceM : 0)}</Text>
          <Text style={{ color: colors.textSecondary }}>{eta ? `Arrive ${eta}` : plan.mode === "OVERSIZE" ? `${plan.escortsRequired} escort(s) required` : "Ready"}</Text>
        </View>
        {tracking ? <Button title="End" variant="destructive" onPress={stop} /> : <Button title="Start" disabled={blocked} onPress={start} />}
      </View>
    </View>
  );
}

function compass(bearing: number): string {
  return ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(bearing / 45) % 8]!;
}
