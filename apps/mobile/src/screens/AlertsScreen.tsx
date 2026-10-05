import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import { IS_WEB } from "../config";
import { useNav } from "../navigation/types";
import { browserNotifications, registerForPush } from "../state/notifications";
import { ARRIVAL, type Arrival } from "../ui/arrival";
import { Banner, Body, Button, Chip, Empty, Field, Padded, Row, Screen, Section, ToggleRow } from "../ui/components";
import { confirm, notify } from "../ui/dialog";
import { when } from "../ui/format";

type Status = Exclude<Arrival, "UNKNOWN">;
interface Prefs {
  enabled: boolean;
  eligible: boolean;
  devices: number;
  statuses: Status[];
  instant: boolean;
  timeZone: string;
  schedule?: { times: string[]; days: number[]; skipWhenEmpty: boolean };
}
interface InboxItem {
  id: string;
  kind: "ARRIVAL" | "SUMMARY" | "TEST" | "TENDER" | "MESSAGE";
  title: string;
  body: string;
  loadId?: string;
  status?: Status;
  at: string;
  read: boolean;
}

const STATUSES: Status[] = ["LATE", "AT_RISK", "EARLY", "ON_TIME"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS = [1, 2, 3, 4, 5];
const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago";
const validTime = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const normalizeTime = (t: string) => {
  const m = t.trim().match(/^(\d{1,2}):?(\d{2})$/);
  return m ? `${m[1]!.padStart(2, "0")}:${m[2]}` : t.trim();
};
const display = (t: string) => new Date(`2000-01-01T${t}:00`).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * Arrival alerts: pick the statuses to hear about (late, at risk, early, on
 * time, in any combination), get a push the moment a shipment becomes one,
 * and/or a summary at set local times.
 */
export function AlertsScreen() {
  const nav = useNav();
  const [prefs, setPrefs] = useState<Prefs>();
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [scheduleOn, setScheduleOn] = useState(false);
  const [newTime, setNewTime] = useState("");
  const [dirty, setDirty] = useState(false);
  const [browserPerm, setBrowserPerm] = useState(browserNotifications.permission());

  const load = useCallback(async () => {
    const p = await api.get<Prefs>("/v1/me/alert-preferences");
    setPrefs({ ...p, timeZone: p.enabled ? p.timeZone : deviceZone(), schedule: p.schedule ?? { times: ["07:00"], days: WEEKDAYS, skipWhenEmpty: true } });
    setScheduleOn(!!p.schedule);
    setDirty(false);
    const box = await api.get<{ items: InboxItem[] }>("/v1/me/notifications");
    setInbox(box.items);
    if (box.items.some((i) => !i.read)) await api.post("/v1/me/notifications/read", {});
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!prefs) return null;
  if (!prefs.eligible) {
    return (
      <Screen>
        <Banner tone="info" title="Arrival alerts are for shippers, 3PLs and dispatchers" message="Drivers see their own loads on Today." />
      </Screen>
    );
  }

  const change = (p: Partial<Prefs>) => {
    setPrefs({ ...prefs, ...p });
    setDirty(true);
  };
  const schedule = prefs.schedule!;
  const setSchedule = (s: Partial<NonNullable<Prefs["schedule"]>>) => change({ schedule: { ...schedule, ...s } });
  const toggleStatus = (s: Status) => change({ statuses: prefs.statuses.includes(s) ? prefs.statuses.filter((x) => x !== s) : [...prefs.statuses, s] });
  const addTime = () => {
    const t = normalizeTime(newTime);
    if (!validTime(t)) return notify("Use a 24-hour time", "For example 07:00 or 15:30.");
    if (!schedule.times.includes(t)) setSchedule({ times: [...schedule.times, t].sort() });
    setNewTime("");
  };
  const canSave = prefs.statuses.length > 0 && (prefs.instant || (scheduleOn && schedule.times.length > 0 && schedule.days.length > 0));

  const save = async () => {
    try {
      const saved = await api.put<Prefs>("/v1/me/alert-preferences", { statuses: prefs.statuses, instant: prefs.instant, timeZone: prefs.timeZone, schedule: scheduleOn ? schedule : undefined });
      setPrefs({ ...saved, schedule: saved.schedule ?? schedule });
      setDirty(false);
      // Ask for permission at the moment it is needed, not at launch.
      if (IS_WEB) {
        if (browserNotifications.permission() === "default") setBrowserPerm(await browserNotifications.request());
        notify("Alerts saved", "New alerts pop up while this site is open and always wait in the list below.");
        return;
      }
      const push = await registerForPush(true);
      if (push.ok) {
        setPrefs((p) => (p ? { ...p, devices: Math.max(p.devices, 1) } : p));
        notify("Alerts saved", "This phone will get push notifications.");
      } else notify("Alerts saved", push.reason);
    } catch (e) {
      notify("Couldn't save alerts", errorMessage(e));
    }
  };

  return (
    <Screen onRefresh={load}>
      {!prefs.enabled ? <Banner tone="info" title="Alerts are off" message="Choose what you want to hear about, then save." /> : null}

      <Section title="Alert me when a shipment is" footer="Pick any combination, for example late and at risk.">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 16 }}>
          {STATUSES.map((s) => (
            <Chip key={s} label={prefs.statuses.includes(s) ? `✓ ${ARRIVAL[s].label}` : ARRIVAL[s].label} tone={prefs.statuses.includes(s) ? ARRIVAL[s].tone : "neutral"} selected={prefs.statuses.includes(s)} onPress={() => toggleStatus(s)} />
          ))}
        </View>
      </Section>

      <Section title="When" footer={`Times are in ${prefs.timeZone}.`}>
        <ToggleRow title="Right away" subtitle="A push the moment the app decides a shipment has become one of these" value={prefs.instant} onChange={(v) => change({ instant: v })} />
        <ToggleRow title="On a schedule" subtitle="A summary of every shipment in these statuses at set times" value={scheduleOn} onChange={(v) => { setScheduleOn(v); setDirty(true); }} />
        {scheduleOn ? (
          <Padded>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {schedule.times.map((t) => (
                <Chip key={t} label={`${display(t)}  ✕`} selected onPress={() => setSchedule({ times: schedule.times.filter((x) => x !== t) })} />
              ))}
            </View>
            <Field label="Add a time (24-hour, e.g. 15:30)" value={newTime} onChangeText={setNewTime} onSubmitEditing={addTime} autoCapitalize="none" />
            <Button title="Add time" variant="tonal" disabled={!newTime.trim() || schedule.times.length >= 6} onPress={addTime} />
            <Body secondary>Days</Body>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {DAYS.map((d, i) => (
                <Chip key={d} label={d} selected={schedule.days.includes(i)} onPress={() => setSchedule({ days: schedule.days.includes(i) ? schedule.days.filter((x) => x !== i) : [...schedule.days, i].sort() })} />
              ))}
            </View>
          </Padded>
        ) : null}
        {scheduleOn ? <ToggleRow title="Skip empty summaries" subtitle="Don't send a summary when nothing matches" value={schedule.skipWhenEmpty} onChange={(v) => setSchedule({ skipWhenEmpty: v })} /> : null}
        <Padded>
          <Field label="Time zone" value={prefs.timeZone} onChangeText={(v) => change({ timeZone: v.trim() })} autoCapitalize="none" hint="IANA name, e.g. America/Chicago" />
        </Padded>
      </Section>

      <Padded>
        <Button title={prefs.enabled ? "Save changes" : "Turn on alerts"} disabled={!canSave || (prefs.enabled && !dirty)} onPress={save} />
        {prefs.enabled ? (
          <Button
            title="Turn off alerts"
            variant="destructive"
            onPress={async () => {
              if (!(await confirm("Turn off arrival alerts?", "You will stop getting pushes and summaries. Today still shows late and at-risk shipments.", "Turn off", true))) return;
              await api.delete("/v1/me/alert-preferences");
              await load();
            }}
          />
        ) : null}
      </Padded>

      <Section title={IS_WEB ? "This browser" : "Devices"} footer={IS_WEB ? "Browsers show alerts only while this site is open. Install the phone app for push when it is closed." : undefined}>
        {IS_WEB ? (
          <Row
            title="Browser notifications"
            value={browserPerm === "granted" ? "On" : browserPerm === "denied" ? "Blocked" : browserPerm === "unsupported" ? "Not supported" : "Off"}
            right={browserPerm === "default" ? <Button title="Allow" variant="tonal" onPress={async () => setBrowserPerm(await browserNotifications.request())} style={{ minHeight: 36 }} /> : undefined}
          />
        ) : (
          <Row title="Phones getting push" value={String(prefs.devices)} right={<Button title="Use this phone" variant="tonal" onPress={async () => { const r = await registerForPush(true); if (r.ok) await load(); else notify("Push is not available", r.reason); }} style={{ minHeight: 36 }} />} />
        )}
        {prefs.enabled ? (
          <Padded>
            <Button
              title="Send a test alert"
              variant="tonal"
              onPress={async () => {
                const r = await api.post<{ devices: number }>("/v1/me/alert-preferences/test");
                notify("Test sent", r.devices ? `Sent to ${r.devices} phone${r.devices === 1 ? "" : "s"}.` : "No phones are registered, so it went to the list below only.");
                await load();
              }}
            />
          </Padded>
        ) : null}
      </Section>

      <Section title="Recent alerts">
        {inbox.length === 0 ? <Empty title="No alerts yet" message="Alerts appear here as well as on your phone." /> : null}
        {inbox.filter((i) => ["ARRIVAL", "SUMMARY", "TEST"].includes(i.kind)).map((i) => (
          <Row
            key={i.id}
            title={i.title}
            subtitle={`${i.body}\n${when(i.at)}`}
            right={i.status ? <Chip label={ARRIVAL[i.status].label} tone={ARRIVAL[i.status].tone} /> : i.kind === "SUMMARY" ? <Chip label="Summary" /> : undefined}
            onPress={i.loadId ? () => nav.navigate("LoadDetail", { id: i.loadId! }) : undefined}
          />
        ))}
      </Section>
    </Screen>
  );
}
