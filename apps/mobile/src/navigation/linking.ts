import type { LinkingOptions } from "@react-navigation/native";
import * as Linking from "expo-linking";

/** Paths for screens every tab can push. */
const SHARED_PATHS: Record<string, string> = {
  LoadDetail: "load/:id",
  Thread: "load/:loadId/messages",
  Dispatch: "load/:loadId/dispatch",
  SendInvoice: "load/:loadId/invoice",
  NewLoad: "new-load",
  Integrations: "integrations",
  PartnerEdit: "integrations/:orgId/:key",
  RegisterCompany: "register-company",
  Security: "security",
  JoinCarrier: "join-carrier",
  Reliability: "reliability",
  Alerts: "alerts",
  Hours: "hours",
  Notifications: "notifications",
};

/**
 * Browser URLs (and logisticspro:// deep links) for every screen, e.g.
 * /loads/load/load_123 or /load/load_123/messages. Back and forward buttons
 * and bookmarks work on the website.
 */
export function buildLinking(tabs: Array<{ id: string; root: string }>, roots: string[]): LinkingOptions<Record<string, object | undefined>> {
  // Tab -> stack nesting is built at runtime from the workspace, so it is typed loosely here.
  const screens: Record<string, { path: string; screens: Record<string, string> }> = {};
  for (const t of tabs) {
    const nested: Record<string, string> = { [t.root]: "", ...SHARED_PATHS };
    for (const r of roots) if (r !== t.root) nested[r] = `go/${r.toLowerCase()}`;
    screens[`${t.root}Tab`] = { path: t.id === "today" ? "" : t.id, screens: nested };
  }
  return { prefixes: [Linking.createURL("/")], config: { screens } } as unknown as LinkingOptions<Record<string, object | undefined>>;
}
