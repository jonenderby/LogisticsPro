import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { api } from "../api/client";
import { IS_WEB } from "../config";

const TOKEN_KEY = "lp.pushToken";
/** Taps already acted on, so the tap that launched the app is not replayed after signing in again. */
const handledTaps = new Set<string>();
const CHANNEL = "arrival";

if (!IS_WEB) {
  // Show arrival alerts even while the app is open.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

export type PushStatus = { ok: true } | { ok: false; reason: string };

/**
 * Ask for permission (only when the person turns alerts on, never at launch),
 * get this phone's Expo push token, and give it to the API.
 * `prompt: false` refreshes a token silently when permission already exists.
 */
export async function registerForPush(prompt = true): Promise<PushStatus> {
  if (IS_WEB) return { ok: false, reason: "Phone push is for the iOS and Android apps. The website shows alerts in your inbox and as browser notifications." };
  if (!Device.isDevice) return { ok: false, reason: "Push notifications need a real phone, not a simulator." };
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL, { name: "Arrival alerts", importance: Notifications.AndroidImportance.HIGH, description: "Shipments that are late, at risk, early or on time" });
  }
  let perm = await Notifications.getPermissionsAsync();
  if (!perm.granted && perm.canAskAgain && prompt) perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return { ok: false, reason: "Notifications are off for Logistics Pro. Turn them on in Settings." };
  const projectId = (Constants.easConfig?.projectId ?? (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId) as string | undefined;
  if (!projectId) return { ok: false, reason: "This build has no EAS project ID, so it cannot receive push. Alerts still appear in your inbox." };
  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await api.post("/v1/me/push-tokens", { token, platform: Platform.OS, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `Could not register this phone: ${(e as Error).message}` };
  }
}

/** On sign-out, stop pushes to this phone for the account that is leaving. */
export async function unregisterPush(): Promise<void> {
  if (IS_WEB) return;
  const token = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
  if (!token) return;
  await api.post("/v1/me/push-tokens/remove", { token }).catch(() => undefined);
  await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => undefined);
}

/**
 * What a tapped notification opens: the load, its message thread, or an invoice.
 */
export type OpenTarget =
  | { open?: "LOAD" | "THREAD"; loadId: string; loadNumber?: string }
  | { open: "INVOICE"; invoiceId: string };

const targetOf = (d: Record<string, unknown> | undefined): OpenTarget | undefined =>
  d?.open === "INVOICE" && typeof d.invoiceId === "string"
    ? { open: "INVOICE", invoiceId: d.invoiceId }
    : typeof d?.loadId === "string"
      ? { loadId: d.loadId, open: d.open === "THREAD" ? "THREAD" : "LOAD", loadNumber: typeof d.loadNumber === "string" ? d.loadNumber : undefined }
      : undefined;

/**
 * While signed in: refresh this phone's token if permission was already given
 * (tokens can change), and open the load or thread when a notification is
 * tapped, including the tap that launched the app.
 */
export function usePushNotifications(signedIn: boolean, openLoad: (t: OpenTarget) => void) {
  const open = useRef(openLoad);
  open.current = openLoad;
  useEffect(() => {
    if (IS_WEB || !signedIn) return;
    void registerForPush(false);
    const handle = (r: Notifications.NotificationResponse | null) => {
      if (!r || handledTaps.has(r.notification.request.identifier)) return;
      handledTaps.add(r.notification.request.identifier);
      const target = targetOf(r.notification.request.content.data as Record<string, unknown> | undefined);
      if (target) open.current(target);
    };
    void Notifications.getLastNotificationResponseAsync().then(handle);
    const sub = Notifications.addNotificationResponseReceivedListener(handle);
    return () => sub.remove();
  }, [signedIn]);
}

interface InboxItem {
  id: string;
  title: string;
  body: string;
  loadId?: string;
  invoiceId?: string;
  target?: "LOAD" | "THREAD" | "INVOICE";
  read: boolean;
}

/**
 * The website has no push service, so while it is open it checks the inbox
 * every minute and shows new alerts as browser notifications.
 */
export function useBrowserAlerts(signedIn: boolean, openLoad: (t: OpenTarget) => void) {
  const open = useRef(openLoad);
  open.current = openLoad;
  useEffect(() => {
    if (!IS_WEB || !signedIn || typeof window === "undefined" || !("Notification" in window)) return;
    const seen = new Set<string>();
    let first = true;
    const check = async () => {
      const inbox = await api.get<{ items: InboxItem[] }>("/v1/me/notifications").catch(() => undefined);
      if (!inbox) return;
      for (const item of [...inbox.items].reverse()) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        // Alerts that arrived while the site was closed stay in the inbox; only new ones pop up.
        if (first || item.read || Notification.permission !== "granted") continue;
        const n = new Notification(item.title, { body: item.body, tag: item.id });
        n.onclick = () => {
          window.focus();
          if (item.target === "INVOICE" && item.invoiceId) open.current({ open: "INVOICE", invoiceId: item.invoiceId });
          else if (item.loadId) open.current({ loadId: item.loadId, open: item.target === "THREAD" ? "THREAD" : "LOAD", loadNumber: item.title.split(" · ")[1] });
          n.close();
        };
      }
      first = false;
    };
    void check();
    const timer = setInterval(() => void check(), 60_000);
    return () => clearInterval(timer);
  }, [signedIn]);
}

export const browserNotifications = {
  supported: () => IS_WEB && typeof window !== "undefined" && "Notification" in window,
  permission: (): string => (IS_WEB && typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported"),
  request: async (): Promise<string> => (IS_WEB && typeof window !== "undefined" && "Notification" in window ? Notification.requestPermission() : "unsupported"),
};

/**
 * Tell the server this device's time zone once per sign-in, so times in
 * notifications (pickups, ETAs) read in local time on phones and the website.
 */
export function useReportTimeZone(signedIn: boolean) {
  useEffect(() => {
    if (!signedIn) return;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timeZone) void api.put("/v1/me/notification-settings", { timeZone }).catch(() => undefined);
  }, [signedIn]);
}
