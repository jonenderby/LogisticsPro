import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { api, errorMessage } from "../api/client";
import { IS_WEB } from "../config";
import { useNav } from "../navigation/types";
import { useMe } from "../state/MeProvider";
import { browserNotifications, registerForPush } from "../state/notifications";
import { Button, Chip, Empty, Row, Screen, Section, ToggleRow, type Tone } from "../ui/components";
import { notify } from "../ui/dialog";
import { when } from "../ui/format";

interface Settings {
  tenders: boolean;
  messages: boolean;
  detention?: boolean;
  payments?: boolean;
  tendersApply: boolean;
  paymentsApply?: boolean;
  devices: number;
}
interface Item {
  id: string;
  kind: "ARRIVAL" | "SUMMARY" | "TEST" | "TENDER" | "MESSAGE" | "STOP" | "DETENTION" | "PAYMENT" | "VETTING";
  target?: "LOAD" | "THREAD" | "INVOICE";
  invoiceId?: string;
  title: string;
  body: string;
  loadId?: string;
  at: string;
  read: boolean;
}

const KIND: Record<Item["kind"], { label: string; tone: Tone }> = {
  TENDER: { label: "Tender", tone: "warning" },
  MESSAGE: { label: "Message", tone: "info" },
  ARRIVAL: { label: "Arrival", tone: "danger" },
  SUMMARY: { label: "Summary", tone: "neutral" },
  TEST: { label: "Test", tone: "neutral" },
  STOP: { label: "At stop", tone: "info" },
  DETENTION: { label: "Detention", tone: "warning" },
  PAYMENT: { label: "Payment", tone: "success" },
  VETTING: { label: "Carrier check", tone: "danger" },
};

/**
 * Notifications for everyone: push on this phone (or browser notifications
 * on the website), switches for tenders and messages, a link to arrival
 * alerts, and the recent list.
 */
export function NotificationsScreen() {
  const nav = useNav();
  const { has } = useMe();
  const [settings, setSettings] = useState<Settings>();
  const [items, setItems] = useState<Item[]>([]);
  const [browserPerm, setBrowserPerm] = useState(browserNotifications.permission());

  const load = useCallback(async () => {
    setSettings(await api.get<Settings>("/v1/me/notification-settings"));
    const box = await api.get<{ items: Item[] }>("/v1/me/notifications");
    setItems(box.items);
    if (box.items.some((i) => !i.read)) await api.post("/v1/me/notifications/read", {});
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  if (!settings) return null;

  // Turning something on is the moment to ask for permission.
  const ensurePermission = async () => {
    if (IS_WEB) {
      if (browserNotifications.permission() === "default") setBrowserPerm(await browserNotifications.request());
      return;
    }
    const r = await registerForPush(true);
    if (!r.ok) notify("Push is not available", r.reason);
  };
  const change = async (patch: Partial<Pick<Settings, "tenders" | "messages" | "detention" | "payments">>) => {
    try {
      setSettings({ ...settings, ...(await api.put<Settings>("/v1/me/notification-settings", patch)) });
      if (Object.values(patch).some(Boolean)) await ensurePermission();
      await load();
    } catch (e) {
      notify("Couldn't save", errorMessage(e));
    }
  };
  const tracks = has("SHIP") || has("BROKER") || has("DISPATCH");

  return (
    <Screen onRefresh={load}>
      <Section title="Notify me about">
        {settings.tendersApply ? <ToggleRow title="Tenders" subtitle="New tenders for your company, and carriers accepting or declining yours" value={settings.tenders} onChange={(v) => change({ tenders: v })} /> : null}
        <ToggleRow title="Messages" subtitle="New messages on your loads" value={settings.messages} onChange={(v) => change({ messages: v })} />
        {settings.tendersApply ? <ToggleRow title="Detention" subtitle="When free time runs out at a pickup or delivery" value={settings.detention !== false} onChange={(v) => change({ detention: v })} /> : null}
        {settings.paymentsApply ? <ToggleRow title="Invoices and payments" subtitle="New invoices, quick-pay requests, approvals, disputes and payments" value={settings.payments !== false} onChange={(v) => change({ payments: v })} /> : null}
        {tracks ? <Row title="Arrival alerts" subtitle="Late, at risk, early or on time, right away or on a schedule" onPress={() => nav.navigate("Alerts")} /> : null}
      </Section>

      <Section title={IS_WEB ? "This browser" : "This phone"} footer={IS_WEB ? "Browsers show notifications only while this site is open. Install the phone app for push when it is closed." : "Notifications are also kept in the list below."}>
        {IS_WEB ? (
          <Row
            title="Browser notifications"
            value={browserPerm === "granted" ? "On" : browserPerm === "denied" ? "Blocked" : browserPerm === "unsupported" ? "Not supported" : "Off"}
            right={browserPerm === "default" ? <Button title="Allow" variant="tonal" onPress={async () => setBrowserPerm(await browserNotifications.request())} style={{ minHeight: 36 }} /> : undefined}
          />
        ) : (
          <Row title="Phones getting push" value={String(settings.devices)} right={<Button title="Use this phone" variant="tonal" onPress={async () => { await ensurePermission(); await load(); }} style={{ minHeight: 36 }} />} />
        )}
      </Section>

      <Section title="Recent">
        {items.length === 0 ? <Empty title="Nothing yet" message="Tenders, messages and arrival alerts show up here." /> : null}
        {items.map((i) => (
          <Row
            key={i.id}
            title={i.title}
            subtitle={`${i.body}\n${when(i.at)}`}
            right={<Chip label={KIND[i.kind].label} tone={KIND[i.kind].tone} />}
            onPress={i.target === "INVOICE" && i.invoiceId ? () => nav.navigate("InvoiceDetail", { id: i.invoiceId! }) : i.loadId ? () => (i.target === "THREAD" ? nav.navigate("Thread", { loadId: i.loadId!, title: i.title.split(" · ")[1] ?? "Messages" }) : nav.navigate("LoadDetail", { id: i.loadId! })) : undefined}
          />
        ))}
      </Section>
    </Screen>
  );
}
