import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { api, session } from "../api/client";
import { confirm } from "../ui/dialog";

export const BACKGROUND_TASK = "lp-background-location";
const DISCLOSED_KEY = "lp.backgroundLocationDisclosed";
/** Keep at most one fix per this many ms; iOS can deliver one a second. */
const THIN_MS = 30_000;
let lastKept = 0;

type Fix = { lat: number; lng: number; at: string; speedMps?: number; headingDeg?: number; accuracyM?: number };
const toFix = (l: Location.LocationObject): Fix => ({
  lat: l.coords.latitude,
  lng: l.coords.longitude,
  at: new Date(l.timestamp).toISOString(),
  speedMps: l.coords.speed != null && l.coords.speed >= 0 ? Math.min(l.coords.speed, 80) : undefined,
  headingDeg: l.coords.heading != null && l.coords.heading >= 0 ? l.coords.heading % 360 : undefined,
  accuracyM: l.coords.accuracy != null && l.coords.accuracy >= 0 ? l.coords.accuracy : undefined,
});

/**
 * Runs with the app in the background, or started by the system with the
 * app closed. It must be defined when the bundle loads, before any screen.
 */
if (Platform.OS !== "web") {
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(BACKGROUND_TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) return;
    const fixes = data.locations
      .filter((l) => {
        if (l.timestamp - lastKept < THIN_MS) return false;
        lastKept = l.timestamp;
        return true;
      })
      .map(toFix);
    if (!fixes.length) return;
    // Started with the app closed: restore the session from secure storage first.
    if (!session.active() && !(await session.restore())) return;
    await api.post("/v1/me/locations", { fixes }).catch(() => undefined);
  });
}

export async function backgroundTrackingRunning(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  return Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK).catch(() => false);
}

/**
 * Keep sharing location with the app closed while the driver is on duty or
 * on a load. Asks for "Allow all the time" only after explaining why, once.
 * Returns false when the driver keeps foreground-only location.
 */
export async function startBackgroundTracking(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  const fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted) return false;
  let bg = await Location.getBackgroundPermissionsAsync();
  if (!bg.granted && bg.canAskAgain && !(await SecureStore.getItemAsync(DISCLOSED_KEY))) {
    await SecureStore.setItemAsync(DISCLOSED_KEY, "1");
    // Store policies require a clear explanation before asking for background location.
    const ok = await confirm(
      "Keep tracking with the app closed?",
      "While you're on duty or on a load, Logistics Pro uses your location in the background to update your carrier and customer and to count your driving hours. It stops when you go off duty. On the next screen, choose \"Allow all the time\".",
      "Continue",
    );
    if (ok) bg = await Location.requestBackgroundPermissionsAsync();
  }
  if (!bg.granted) return false;
  if (await backgroundTrackingRunning()) return true;
  await Location.startLocationUpdatesAsync(BACKGROUND_TASK, {
    accuracy: Location.Accuracy.Balanced,
    // Time-based on Android so a stopped truck still reports (stop detection); iOS batches below.
    timeInterval: 60_000,
    distanceInterval: 0,
    deferredUpdatesInterval: 60_000,
    activityType: Location.ActivityType.AutomotiveNavigation,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "Sharing your trip",
      notificationBody: "Your carrier and customer see your location while you're on duty. It stops when you go off duty.",
      notificationColor: "#1D5FD1",
    },
  });
  return true;
}

export async function stopBackgroundTracking(): Promise<void> {
  if (await backgroundTrackingRunning()) await Location.stopLocationUpdatesAsync(BACKGROUND_TASK).catch(() => undefined);
}
