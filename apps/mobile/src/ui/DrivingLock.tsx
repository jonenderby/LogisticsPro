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
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "unknown");

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
  const { me, refresh } = useMe();
  const { colors } = useTheme();
  const [trip, setTrip] = useState<Tracking>();
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

  const next = trip?.eta.nextStop;
  const say = () =>
    Speech.speak(
      [
        hos.availableMin > 0 ? `You have ${formatMinutes(hos.availableMin).replace(" h", " hours").replace(" min", " minutes")} left to drive, ${LIMIT[hos.limitedBy]}.` : "You are out of driving time. Find a safe place to stop.",
        next ? `Next stop ${next.city}, ${next.state}. Estimated arrival ${time(trip?.eta.eta)}.` : "",
      ].join(" "),
    );
  const stopped = async () => {
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if ((pos.coords.speed ?? 0) > 1) return notify("Still moving", "The app unlocks once the truck has stopped.");
      await api.post("/v1/me/duty-status", { status: "ON_DUTY", note: "Stopped" });
      await refresh();
    } catch (e) {
      notify("Couldn't unlock", errorMessage(e));
    }
  };
  const passenger = async () => {
    if (!(await confirm("Are you the passenger?", "Only if your co-driver is at the wheel. You will be logged as on duty, not driving.", "I'm the passenger"))) return;
    await api.post("/v1/me/duty-status", { status: "ON_DUTY", note: "Team passenger" });
    await refresh();
  };

  return (
    <View accessibilityViewIsModal style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.background, padding: 24, paddingTop: 72, gap: 20 }}>
      <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 34, fontWeight: "800" }}>
        Driving
      </Text>
      <View accessible>
        <Text style={{ color: hos.availableMin > 30 ? colors.text : colors.danger, fontSize: 44, fontWeight: "700" }}>{hos.availableMin > 0 ? formatMinutes(hos.availableMin) : "Stop soon"}</Text>
        <Text style={{ color: colors.textSecondary, fontSize: 20 }}>{hos.availableMin > 0 ? `left ${LIMIT[hos.limitedBy]}` : "You are out of driving time"}</Text>
      </View>
      {next ? (
        <View accessible>
          <Text style={{ color: colors.text, fontSize: 24, fontWeight: "600" }}>{`Next: ${next.city}, ${next.state}`}</Text>
          <Text style={{ color: colors.textSecondary, fontSize: 20 }}>{`ETA ${time(trip?.eta.eta)} · window ${time(trip?.eta.window.start)}–${time(trip?.eta.window.end)}`}</Text>
        </View>
      ) : null}
      <View style={{ flex: 1 }} />
      <Big title="Navigation" primary hint="Opens turn-by-turn navigation" onPress={() => onNavigate(loadId)} />
      <Big title="Read it to me" hint="Speaks your hours and next stop" onPress={say} />
      {hos.teamTruck ? <Big title="I'm the passenger" hint="For team drivers when your co-driver is driving" onPress={passenger} /> : <Big title="I've stopped" hint="Unlocks the app once the truck is not moving" onPress={stopped} />}
      <Text style={{ color: colors.textSecondary, fontSize: 15, textAlign: "center" }}>The rest of the app unlocks after 5 minutes stopped.</Text>
    </View>
  );
}
