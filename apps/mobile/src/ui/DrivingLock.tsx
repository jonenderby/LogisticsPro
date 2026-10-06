import { formatMinutes } from "@logisticspro/domain";
import * as Location from "expo-location";
import * as Speech from "expo-speech";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { api, errorMessage } from "../api/client";
import { IS_WEB } from "../config";
import { useMe } from "../state/MeProvider";
import { confirm, notify } from "./dialog";
import { useTheme } from "./theme";

interface Tracking {
  loadNumber: string;
  destination: string;
  eta: { eta?: string; window: { start: string; end: string }; nextStop?: { city: string; state: string; type: string } };
}

const LIMIT: Record<string, string> = { BREAK: "until your 30-minute break", DRIVING: "of your 11-hour limit", WINDOW: "before your 14-hour window closes", CYCLE: "of your weekly cycle" };
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "–");

function Big({ title, onPress, hint, primary }: { title: string; onPress: () => void; hint: string; primary?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed }) => ({ minHeight: 72, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: primary ? colors.primary : colors.surfaceVariant, opacity: pressed ? 0.8 : 1 })}
    >
      <Text style={{ color: primary ? colors.onPrimary : colors.text, fontSize: 22, fontWeight: "700" }}>{title}</Text>
    </Pressable>
  );
}

/**
 * While the driver is driving, the app shows only what is safe to glance at:
 * hours left and the next stop, with large single-tap buttons for
 * navigation and a spoken read-out. Federal rules ban holding or typing on a
 * phone while driving; this keeps everything else out of reach until the
 * truck has stopped. Navigation stays usable.
 */
export function DrivingLock({ onNavigate, routeName }: { onNavigate: (loadId?: string) => void; routeName?: string }) {
  const { me, refresh, t, lang } = useMe();
  const { colors } = useTheme();
  const [trip, setTrip] = useState<Tracking>();
  // An ELD driver's status changes on the ELD; "I've stopped" just hides the lock until the next report.
  const [dismissedAt, setDismissedAt] = useState<string>();
  const hos = me?.hos;
  const driving = !IS_WEB && hos?.status === "DRIVING";
  const loadId = me?.feed.find((i) => i.id.startsWith("drive:") && i.priority >= 100)?.loadId;

  useEffect(() => {
    if (!driving || !loadId) return setTrip(undefined);
    let live = true;
    const load = () => api.get<Tracking>(`/v1/loads/${loadId}/tracking`).then((t) => live && setTrip(t)).catch(() => undefined);
    void load();
    const timer = setInterval(load, 120_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [driving, loadId]);

  if (!driving || !hos || routeName === "Navigate") return null;
  if (hos.source === "ELD" && dismissedAt && dismissedAt === hos.eld?.asOf) return null;

  const next = trip?.eta.nextStop;
  const spoken = (min: number) => t("{h} hours {m} minutes", { h: Math.floor(min / 60), m: min % 60 });
  const say = () =>
    Speech.speak(
      [
        hos.availableMin > 0 ? t("You have {time} left to drive, {limit}.", { time: spoken(hos.availableMin), limit: t(LIMIT[hos.limitedBy]!) }) : t("You are out of driving time. Find a safe place to stop."),
        next ? t("Next stop {city}, {state}. Estimated arrival {time}.", { city: next.city, state: next.state, time: time(trip?.eta.eta) }) : "",
      ].join(" "),
      { language: lang === "es" ? "es-US" : "en-US" },
    );
  const stopped = async () => {
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if ((pos.coords.speed ?? 0) > 1) return notify(t("Still moving"), t("The app unlocks once the truck has stopped."));
      if (hos.source === "ELD") return setDismissedAt(hos.eld?.asOf);
      await api.post("/v1/me/duty-status", { status: "ON_DUTY", note: "Stopped" });
      await refresh();
    } catch (e) {
      notify(t("Couldn't unlock"), errorMessage(e));
    }
  };
  const passenger = async () => {
    if (!(await confirm(t("Are you the passenger?"), t("Only if your co-driver is at the wheel. You will be logged as on duty, not driving."), t("I'm the passenger")))) return;
    if (hos.source === "ELD") return setDismissedAt(hos.eld?.asOf);
    await api.post("/v1/me/duty-status", { status: "ON_DUTY", note: "Team passenger" });
    await refresh();
  };

  return (
    <View accessibilityViewIsModal style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.background, padding: 24, paddingTop: 72, gap: 20 }}>
      <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 34, fontWeight: "800" }}>
        {t("Driving")}
      </Text>
      <View accessible>
        <Text style={{ color: hos.availableMin > 30 ? colors.text : colors.danger, fontSize: 44, fontWeight: "700" }}>{hos.availableMin > 0 ? formatMinutes(hos.availableMin) : t("Stop soon")}</Text>
        <Text style={{ color: colors.textSecondary, fontSize: 20 }}>{hos.availableMin > 0 ? `${t("left")} ${t(LIMIT[hos.limitedBy]!)}` : t("You are out of driving time")}</Text>
      </View>
      {next ? (
        <View accessible>
          <Text style={{ color: colors.text, fontSize: 24, fontWeight: "600" }}>{t("Next: {city}, {state}", { city: next.city, state: next.state })}</Text>
          <Text style={{ color: colors.textSecondary, fontSize: 20 }}>{t("ETA {eta} · window {start}–{end}", { eta: time(trip?.eta.eta), start: time(trip?.eta.window.start), end: time(trip?.eta.window.end) })}</Text>
        </View>
      ) : null}
      <View style={{ flex: 1 }} />
      <Big title={t("Navigation")} primary hint={t("Opens turn-by-turn navigation")} onPress={() => onNavigate(loadId)} />
      <Big title={t("Read it to me")} hint={t("Speaks your hours and next stop")} onPress={say} />
      {hos.teamTruck ? <Big title={t("I'm the passenger")} hint={t("For team drivers when your co-driver is driving")} onPress={passenger} /> : <Big title={t("I've stopped")} hint={t("Unlocks the app once the truck is not moving")} onPress={stopped} />}
      <Text style={{ color: colors.textSecondary, fontSize: 15, textAlign: "center" }}>{t("The rest of the app unlocks after 5 minutes stopped.")}</Text>
    </View>
  );
}
