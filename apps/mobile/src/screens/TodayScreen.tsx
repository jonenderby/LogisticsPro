import { Text, View } from "react-native";
import { api, errorMessage } from "../api/client";
import type { ActionItem } from "../api/types";
import { reportStatus } from "../actions";
import { useNav } from "../navigation/types";
import { useMe } from "../state/MeProvider";
import { confirm, notify } from "../ui/dialog";
import { Banner, Button, Chip, Empty, Row, Screen, Section, type Tone } from "../ui/components";
import { HosSummary } from "../ui/Hos";
import { useDutyStatus } from "./HoursScreen";
import { useLayout } from "../ui/responsive";
import { useTheme } from "../ui/theme";

const HAT: Record<ActionItem["hat"], { label: string; tone: Tone }> = {
  DRIVING: { label: "Driving", tone: "info" },
  DISPATCH: { label: "Dispatch", tone: "warning" },
  SHIPPING: { label: "Shipping", tone: "success" },
  BROKERAGE: { label: "Brokerage", tone: "success" },
  BILLING: { label: "Billing", tone: "neutral" },
  MESSAGES: { label: "Messages", tone: "neutral" },
};

/**
 * One feed for every role the person holds. An owner-operator sees the load
 * they are driving next to tenders and invoices for their company.
 */
export function TodayScreen() {
  const { me, refresh, error, t } = useMe();
  const nav = useNav();
  const { colors, metrics } = useTheme();
  const { wide } = useLayout();
  const setDuty = useDutyStatus(() => undefined);
  if (!me) return null;

  const act = async (item: ActionItem) => {
    try {
      switch (item.cta.action) {
        case "status":
          await reportStatus(item.loadId!, item.cta.statusCode!);
          await refresh();
          return;
        case "ship-confirm":
          if (await confirm(t("Confirm shipment?"), t("The load details lock for everyone once confirmed."), t("Confirm"))) {
            await api.post(`/v1/loads/${item.loadId}/ship-confirm`);
            await refresh();
          }
          return;
        case "dispatch":
          return nav.navigate("Dispatch", { loadId: item.loadId! });
        case "invoice":
          return nav.navigate("SendInvoice", { loadId: item.loadId! });
        case "messages":
          return nav.navigate("Thread", { loadId: item.loadId!, title: item.title });
        case "invoice-review":
          return nav.navigate("Money");
        case "open-invoice":
          return item.invoiceId ? nav.navigate("InvoiceDetail", { id: item.invoiceId }) : nav.navigate("Money");
        case "rate-con":
          return nav.navigate("RateConfirmation", { loadId: item.loadId! });
        case "track":
          return nav.navigate("Track");
        case "join-carrier":
          return nav.navigate("JoinCarrier");
        case "join-requests":
          return nav.navigate("Business");
        default:
          return nav.navigate("LoadDetail", { id: item.loadId! });
      }
    } catch (e) {
      notify(t("Couldn't update"), errorMessage(e));
    }
  };

  const quick = (id: string) => {
    if (id === "new-load") nav.navigate("NewLoad");
    else if (id === "find-loads") nav.navigate("Board");
    else if (id === "new-invoice") nav.navigate("Money");
    else nav.navigate("Loads", { filter: "driving" });
  };

  return (
    <Screen onRefresh={refresh}>
      {error ? <Banner tone="danger" title={t("Offline")} message={error} /> : null}
      <Text style={{ color: colors.textSecondary, fontSize: metrics.body, marginHorizontal: 16, marginTop: 8 }}>
        {me.account.name}
        {me.orgs.length ? ` · ${me.orgs.map((o) => o.name).join(", ")}` : ""}
      </Text>
      {me.workspace.quickActions.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginHorizontal: 16, marginTop: 12 }}>
          {me.workspace.quickActions.map((q) => (
            <Button key={q.id} title={t(q.title)} variant="tonal" onPress={() => quick(q.id)} style={{ minHeight: 40, paddingHorizontal: 14 }} />
          ))}
        </View>
      ) : null}
      {me.capabilities.includes("REGISTER_COMPANY") ? (
        <Section title={t("Get started")}>
          <View style={{ padding: 16, gap: 8 }}>
            <Text style={{ color: colors.text, fontSize: metrics.body }}>{t("Register your company to dispatch, bid on loads, ship freight or connect your ERP.")}</Text>
            <Button title={t("Register company")} onPress={() => nav.navigate("RegisterCompany")} />
          </View>
        </Section>
      ) : null}
      {me.hos ? (
        <Section title={t("Hours of service")}>
          <HosSummary hos={me.hos} onStatus={setDuty} />
          <Row title={t("Hours, limits and duty log")} onPress={() => nav.navigate("Hours")} />
        </Section>
      ) : null}
      <Section title={t("Needs your attention")} bare={wide}>
        {me.feed.length === 0 ? <Empty title={t("You're all caught up")} message={t("New tenders, loads and invoices show up here.")} /> : null}
        <View style={wide ? { flexDirection: "row", flexWrap: "wrap", gap: 12 } : undefined}>
          {me.feed.map((item) => (
            <View
              key={item.id}
              style={[
                { padding: 16, gap: 8, borderBottomWidth: 0.5, borderBottomColor: colors.separator },
                // Desktop: a grid of cards instead of one long list.
                wide ? { flexBasis: "48%", flexGrow: 1, backgroundColor: colors.surface, borderRadius: metrics.radius, borderWidth: 0.5, borderColor: colors.separator } : null,
              ]}
            >
              <Chip label={t(HAT[item.hat].label)} tone={HAT[item.hat].tone} />
              <Text accessibilityRole="header" style={{ color: colors.text, fontSize: metrics.body, fontWeight: "600" }} onPress={() => item.loadId && nav.navigate("LoadDetail", { id: item.loadId })}>
                {item.title}
              </Text>
              {item.subtitle ? <Text style={{ color: colors.textSecondary, fontSize: metrics.callout }}>{item.subtitle}</Text> : null}
              <Button title={item.cta.label} variant={item.priority >= 90 ? "filled" : "tonal"} onPress={() => act(item)} style={wide ? { alignSelf: "flex-start" } : undefined} />
            </View>
          ))}
        </View>
      </Section>
    </Screen>
  );
}
