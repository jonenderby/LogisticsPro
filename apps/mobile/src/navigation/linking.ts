import { type LinkingOptions, getPathFromState, getStateFromPath } from "@react-navigation/native";
import * as Linking from "expo-linking";
import { BASE_PATH } from "../config";

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
  FuelTax: "fuel-tax",
  Notifications: "notifications",
  RateConfirmation: "load/:loadId/rate-confirmation",
  InvoiceDetail: "invoice/:id",
  CarrierCheck: "carrier/:orgId/check",
  Signature: "load/:loadId/sign",
  Insights: "insights",
  Setup: "setup",
  Admin: "admin",
  History: "older-loads",
  AchPayments: "pay-by-ach/:orgId",
  Settlements: "driver-pay/:orgId",
  SettlementDetail: "pay-statement/:id",
  MyPay: "my-pay",
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
  return {
    prefixes: [Linking.createURL("/")],
    config: { screens },
    // On a shared domain the website lives under BASE_PATH (/logistics/loads/...).
    ...(BASE_PATH
      ? {
          getStateFromPath: (path: string, options: Parameters<typeof getStateFromPath>[1]) => withBase(getStateFromPath(stripBase(path), options)),
          getPathFromState: (state: Parameters<typeof getPathFromState>[0], options: Parameters<typeof getPathFromState>[1]) => `${BASE_PATH}${getPathFromState(state, options)}`,
        }
      : {}),
  } as unknown as LinkingOptions<Record<string, object | undefined>>;
}

const stripBase = (path: string) => (path === BASE_PATH || path.startsWith(`${BASE_PATH}/`) || path.startsWith(`${BASE_PATH}?`) ? path.slice(BASE_PATH.length) || "/" : path);

type PathState = { routes: Array<{ path?: string; state?: PathState }> } | undefined;
/** Routes remember the path that opened them and reuse it for the address bar, so it must keep the base. */
function withBase<T>(state: T): T {
  const fix = (s: PathState): PathState =>
    s && { ...s, routes: s.routes.map((r) => ({ ...r, ...(r.path !== undefined ? { path: `${BASE_PATH}${r.path}` } : {}), ...(r.state ? { state: fix(r.state) } : {}) })) };
  return fix(state as PathState) as T;
}
