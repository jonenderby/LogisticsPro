import * as Location from "expo-location";
import { useEffect, useRef } from "react";
import { api } from "../api/client";
import { useMe } from "./MeProvider";

const MIN_INTERVAL_MS = 60_000;

/**
 * Shares the driver's position with their carrier and the shipper while they
 * have a load assigned, so tracking maps and arrival estimates stay current.
 *
 * Runs only while the app is open (foreground permission). Nothing is sent
 * when the driver has no open load, and the permission prompt is shown only
 * once a load is underway.
 */
export function useLocationSharing() {
  const { me, has } = useMe();
  const driving = (me?.feed ?? []).filter((i) => i.id.startsWith("drive:") && i.loadId);
  const enabled = has("DRIVE") && driving.length > 0;
  const underway = driving.some((i) => i.priority >= 100);
  const lastSent = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let sub: Location.LocationSubscription | undefined;

    (async () => {
      let perm = await Location.getForegroundPermissionsAsync();
      if (!perm.granted && perm.canAskAgain && underway) perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted || cancelled) return;
      const s = await Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, timeInterval: MIN_INTERVAL_MS, distanceInterval: 200 }, (loc) => {
        const now = Date.now();
        if (now - lastSent.current < MIN_INTERVAL_MS) return;
        lastSent.current = now;
        const { latitude, longitude, speed, heading, accuracy } = loc.coords;
        void api
          .post("/v1/me/location", {
            lat: latitude,
            lng: longitude,
            at: new Date(loc.timestamp).toISOString(),
            speedMps: speed != null && speed >= 0 ? Math.min(speed, 80) : undefined,
            headingDeg: heading != null && heading >= 0 ? heading % 360 : undefined,
            accuracyM: accuracy != null && accuracy >= 0 ? accuracy : undefined,
          })
          .catch(() => {
            lastSent.current = 0;
          });
      });
      if (cancelled) s.remove();
      else sub = s;
    })().catch(() => undefined);

    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [enabled, underway]);
}
