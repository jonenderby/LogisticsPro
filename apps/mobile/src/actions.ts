import * as Location from "expo-location";
import { api } from "./api/client";

/** Report a status with the phone's last known position, when the driver allowed location access. */
export async function reportStatus(loadId: string, code: string, extra: Record<string, unknown> = {}) {
  let geo: { lat: number; lng: number } | undefined;
  let city: string | undefined;
  let state: string | undefined;
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (perm.granted) {
      const pos = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 });
      if (pos) {
        geo = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        const [place] = await Location.reverseGeocodeAsync({ latitude: geo.lat, longitude: geo.lng }).catch(() => []);
        city = place?.city ?? undefined;
        state = place?.region ?? undefined;
      }
    }
  } catch {
    // Location is optional; the status still goes out.
  }
  return api.post(`/v1/loads/${loadId}/status`, { code, geo, city, state: state && state.length <= 3 ? state : undefined, ...extra });
}
