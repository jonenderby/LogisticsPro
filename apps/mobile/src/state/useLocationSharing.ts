import * as Location from "expo-location";
import { useEffect, useRef } from "react";
import { api } from "../api/client";
import { useMe } from "./MeProvider";

const MIN_INTERVAL_MS = 60_000;
/** While stopped the phone reports no movement, so check in this often to notice the stop. */
const HEARTBEAT_MS = 120_000;

/**
 * Shares the driver's position while they have a load or are on duty. It
 * keeps tracking maps and arrival estimates current, and, like an ELD, lets
 * the server switch the driver to Driving when the truck moves and back to
 * On duty after five minutes stopped.
 *
 * Runs only while the app is open (foreground permission). The permission
 * prompt is shown only once a load is underway or the driver goes on duty.
 */
export function useLocationSharing() {
  const { me, has, refresh } = useMe();
  const driving = (me?.feed ?? []).filter((i) => i.id.startsWith("drive:") && i.loadId);
  const onDuty = me?.hos?.status === "ON_DUTY" || me?.hos?.status === "DRIVING";
  const enabled = has("DRIVE") && (driving.length > 0 || onDuty);
  const underway = driving.some((i) => i.priority >= 100) || onDuty;
  const lastSent = useRef(0);
  const lastStatus = useRef(me?.hos?.status);
  lastStatus.current = me?.hos?.status;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let sub: Location.LocationSubscription | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;

    const send = (loc: Location.LocationObject, force = false) => {
      const now = Date.now();
      if (!force && now - lastSent.current < MIN_INTERVAL_MS) return;
      lastSent.current = now;
      const { latitude, longitude, speed, heading, accuracy } = loc.coords;
      void api
        .post<{ duty?: { status: string } }>("/v1/me/location", {
          lat: latitude,
          lng: longitude,
          at: new Date(loc.timestamp).toISOString(),
          speedMps: speed != null && speed >= 0 ? Math.min(speed, 80) : undefined,
          headingDeg: heading != null && heading >= 0 ? heading % 360 : undefined,
          accuracyM: accuracy != null && accuracy >= 0 ? accuracy : undefined,
        })
        .then((r) => {
          // The server switched Driving or On duty from the truck's movement: refresh the hours on screen.
          if (r.duty && r.duty.status !== lastStatus.current) void refresh();
        })
        .catch(() => {
          lastSent.current = 0;
        });
    };

    (async () => {
      let perm = await Location.getForegroundPermissionsAsync();
      if (!perm.granted && perm.canAskAgain && underway) perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted || cancelled) return;
      const s = await Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, timeInterval: MIN_INTERVAL_MS, distanceInterval: 200 }, (loc) => send(loc));
      if (cancelled) {
        s.remove();
        return;
      }
      sub = s;
      timer = setInterval(() => {
        if (Date.now() - lastSent.current < HEARTBEAT_MS - 5_000) return;
        void Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
          .then((loc) => send(loc, true))
          .catch(() => undefined);
      }, HEARTBEAT_MS);
    })().catch(() => undefined);

    return () => {
      cancelled = true;
      sub?.remove();
      if (timer) clearInterval(timer);
    };
  }, [enabled, underway, refresh]);
}
