import type { Capability, ResolvedCapabilities } from "./capabilities.js";

export type TabId = "today" | "loads" | "track" | "navigate" | "board" | "messages" | "money" | "business" | "more";

export interface TabSpec {
  id: TabId;
  title: string;
  /** SF Symbol name on iOS and Material Symbol name on Android. */
  icon: { ios: string; android: string };
}

export interface MoreEntry {
  id: TabId | "account" | "security" | "register-company" | "join-carrier" | "reliability" | "alerts" | "integrations" | "fleet" | "distribution-centers";
  title: string;
}

export interface Workspace {
  tabs: TabSpec[];
  more: MoreEntry[];
  /** Filters shown on the Loads tab; one per hat the person wears, all visible together. */
  loadFilters: Array<{ id: "driving" | "dispatch" | "shipments" | "brokered"; title: string }>;
  quickActions: Array<{ id: string; title: string }>;
}

const TABS: Record<Exclude<TabId, "more">, TabSpec> = {
  today: { id: "today", title: "Today", icon: { ios: "house", android: "home" } },
  loads: { id: "loads", title: "Loads", icon: { ios: "shippingbox", android: "local_shipping" } },
  track: { id: "track", title: "Tracking", icon: { ios: "mappin.and.ellipse", android: "location_on" } },
  navigate: { id: "navigate", title: "Navigate", icon: { ios: "map", android: "navigation" } },
  board: { id: "board", title: "Board", icon: { ios: "list.bullet.rectangle", android: "view_list" } },
  messages: { id: "messages", title: "Messages", icon: { ios: "bubble.left.and.bubble.right", android: "chat" } },
  money: { id: "money", title: "Money", icon: { ios: "dollarsign.circle", android: "payments" } },
  business: { id: "business", title: "Business", icon: { ios: "building.2", android: "business" } },
};

const MORE_TAB: TabSpec = { id: "more", title: "More", icon: { ios: "ellipsis.circle", android: "menu" } };

/**
 * Apple's HIG and Material 3 both recommend 3-5 bottom navigation
 * destinations. The four most important destinations for this person become
 * tabs; everything else lives under More, which also holds account settings.
 */
export const MAX_PRIMARY_TABS = 4;

export function buildWorkspace(caps: ResolvedCapabilities): Workspace {
  const has = (c: Capability) => caps.all.has(c);
  const candidates: Array<{ id: Exclude<TabId, "more">; score: number }> = [
    { id: "today", score: 100 },
    { id: "loads", score: 90 },
  ];
  if (has("DRIVE")) candidates.push({ id: "navigate", score: 80 });
  // Office users live on the map: carriers see their fleet, shippers and 3PLs their shipments.
  if (has("DISPATCH") || has("SHIP") || has("BROKER")) candidates.push({ id: "track", score: has("DRIVE") ? 55 : 88 });
  candidates.push({ id: "messages", score: has("DRIVE") ? 75 : 60 });
  if (has("BID") || has("BROKER")) candidates.push({ id: "board", score: has("DRIVE") ? 70 : 85 });
  if (has("INVOICE") || has("PAY")) candidates.push({ id: "money", score: has("DRIVE") ? 50 : 65 });
  if (has("MANAGE_ORG") || has("MANAGE_FLEET") || has("MANAGE_INTEGRATIONS")) candidates.push({ id: "business", score: 40 });

  candidates.sort((a, b) => b.score - a.score);
  const primary = candidates.slice(0, MAX_PRIMARY_TABS);
  const overflow = candidates.slice(MAX_PRIMARY_TABS);

  const more: MoreEntry[] = overflow.map((c) => ({ id: c.id, title: TABS[c.id].title }));
  if (has("MANAGE_FLEET")) more.push({ id: "fleet", title: "Drivers & equipment" }, { id: "distribution-centers", title: "Distribution centers" });
  if (has("MANAGE_INTEGRATIONS")) more.push({ id: "integrations", title: "Integrations (API & EDI)" });
  if (has("DISPATCH") || has("SHIP") || has("BROKER")) more.push({ id: "alerts", title: "Arrival alerts" });
  if (has("DRIVE")) more.push({ id: "reliability", title: "My reliability" }, { id: "join-carrier", title: "Join a carrier" });
  if (has("REGISTER_COMPANY") || (has("DRIVE") && !has("DISPATCH"))) more.push({ id: "register-company", title: "Register your company" });
  more.push({ id: "account", title: "Profile" }, { id: "security", title: "Sign-in & two-factor" });

  const loadFilters: Workspace["loadFilters"] = [];
  if (has("DRIVE")) loadFilters.push({ id: "driving", title: "Driving" });
  if (has("DISPATCH")) loadFilters.push({ id: "dispatch", title: "Fleet" });
  if (has("SHIP")) loadFilters.push({ id: "shipments", title: "Shipments" });
  if (has("BROKER")) loadFilters.push({ id: "brokered", title: "Brokered" });

  const quickActions: Workspace["quickActions"] = [];
  if (has("DRIVE")) quickActions.push({ id: "update-status", title: "Update status" }, { id: "add-document", title: "Add BOL / POD" });
  if (has("SHIP") || has("BROKER")) quickActions.push({ id: "new-load", title: "New load" });
  if (has("BID")) quickActions.push({ id: "find-loads", title: "Find loads" });
  if (has("INVOICE")) quickActions.push({ id: "new-invoice", title: "Send invoice" });

  const trackTitle = has("SHIP") || has("BROKER") ? "Tracking" : "Fleet";
  const label = (t: TabSpec) => (t.id === "track" ? { ...t, title: trackTitle } : t);
  return { tabs: [...primary.map((c) => label(TABS[c.id])), MORE_TAB], more: more.map((m) => (m.id === "track" ? { ...m, title: trackTitle } : m)), loadFilters, quickActions };
}
