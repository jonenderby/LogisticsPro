import type { Bid, Invoice, Load, Leg, StatusCode } from "@logisticspro/domain";
import type { ResolvedCapabilities } from "./capabilities.js";

export type Hat = "DRIVING" | "DISPATCH" | "SHIPPING" | "BROKERAGE" | "BILLING" | "MESSAGES";

export interface ActionItem {
  id: string;
  hat: Hat;
  priority: number;
  title: string;
  subtitle?: string;
  loadId?: string;
  invoiceId?: string;
  cta: { label: string; action: string; statusCode?: StatusCode };
}

export interface FeedData {
  accountId: string;
  loads: Load[];
  boardLoads?: Load[];
  bids?: Bid[];
  invoices?: Invoice[];
  unreadByLoad?: Record<string, number>;
  /** Pending requests to join carriers this person manages. */
  joinRequests?: Array<{ id: string; carrierOrgId: string; carrierName?: string; accountName: string }>;
  /** Shipments whose arrival is late or at risk. */
  arrivalAlerts?: Array<{ loadId: string; loadNumber: string; status: "LATE" | "AT_RISK"; eta?: string; reason?: string }>;
  /** Revised rate confirmations waiting on this person's carrier to sign. */
  rateConsToSign?: Array<{ loadId: string; loadNumber: string; version: number; changes: string[] }>;
  now?: string;
}

/** The next status button a driver sees for their leg of a load. */
export function nextDriverAction(load: Load, leg: Leg | undefined): { label: string; code: StatusCode } | undefined {
  const toStop = leg ? load.stops.find((s) => s.id === leg.toStopId) : undefined;
  const fromStop = leg ? load.stops.find((s) => s.id === leg.fromStopId) : undefined;
  const startsAtPickup = !fromStop || fromStop.type === "PICKUP";
  switch (load.status) {
    case "BOOKED":
    case "DISPATCHED":
      return startsAtPickup ? { label: "Arrived at pickup", code: "ARRIVED_PICKUP" } : undefined;
    case "AT_PICKUP":
      return startsAtPickup ? { label: "Loaded", code: "LOADED" } : undefined;
    case "IN_TRANSIT": {
      if (leg && leg.status === "PLANNED") return undefined;
      if (leg && leg.status === "ASSIGNED") return undefined;
      if (toStop?.type === "RELAY") {
        const arrived = load.events.some((e) => e.code === "ARRIVED_RELAY" && e.legId === leg?.id);
        return arrived ? { label: "Handoff complete", code: "RELAY_HANDOFF" } : { label: "Arrived at relay", code: "ARRIVED_RELAY" };
      }
      if (toStop?.type === "CROSS_DOCK") return { label: "Arrived at terminal", code: "ARRIVED_TERMINAL" };
      return { label: "Arrived at delivery", code: "ARRIVED_DELIVERY" };
    }
    case "AT_DELIVERY":
      return { label: "Delivered", code: "DELIVERED" };
    default:
      return undefined;
  }
}

function myLeg(load: Load, accountId: string): Leg | undefined {
  const mine = load.legs.filter((l) => l.driverAccountIds.includes(accountId));
  return mine.find((l) => l.status === "IN_PROGRESS") ?? mine.find((l) => l.status === "ASSIGNED") ?? mine[0];
}

/**
 * One prioritized list across every hat the person wears. An owner-operator
 * sees "Loaded" for the truck they are driving next to "Assign a driver" for
 * the load their company just booked.
 */
export function buildFeed(caps: ResolvedCapabilities, data: FeedData): ActionItem[] {
  const items: ActionItem[] = [];
  const has = (c: Parameters<typeof caps.all.has>[0]) => caps.all.has(c);
  const orgsWith = (c: Parameters<typeof caps.all.has>[0]) => [...caps.byOrg].filter(([, s]) => s.has(c)).map(([id]) => id);
  const dispatchOrgs = orgsWith("DISPATCH");
  const shipOrgs = orgsWith("SHIP");
  const now = data.now ?? new Date().toISOString();
  const invoiced = new Set((data.invoices ?? []).map((i) => i.loadId));

  // Every trucker drives for a carrier: their own (self-employed) or one they join.
  const drivesForCarrier = [...caps.byOrg.values()].some((s) => s.has("DRIVE"));
  if (has("DRIVE") && !drivesForCarrier) {
    items.push({ id: "onboard:carrier", hat: "DRIVING", priority: 99, title: "Join your carrier", subtitle: "Enter the join code from your carrier. Self-employed? Register your own trucking company instead.", cta: { label: "Join a carrier", action: "join-carrier" } });
  }
  const manageOrgs = new Set([...orgsWith("MANAGE_ORG"), ...dispatchOrgs]);
  for (const r of data.joinRequests ?? []) {
    if (!manageOrgs.has(r.carrierOrgId)) continue;
    items.push({ id: `join:${r.id}`, hat: "DISPATCH", priority: 88, title: `${r.accountName} wants to drive for ${r.carrierName ?? "your company"}`, subtitle: "Requested with your join code", cta: { label: "Review request", action: "join-requests" } });
  }

  for (const load of data.loads) {
    const leg = myLeg(load, data.accountId);
    if (has("DRIVE") && leg && leg.status !== "COMPLETED") {
      const next = nextDriverAction(load, leg);
      if (next) {
        const active = ["AT_PICKUP", "IN_TRANSIT", "AT_DELIVERY"].includes(load.status);
        items.push({ id: `drive:${load.id}`, hat: "DRIVING", priority: active ? 100 : 80, title: `${active ? "Current load" : "Next load"} ${load.loadNumber}`, subtitle: stopSummary(load), loadId: load.id, cta: { label: next.label, action: "status", statusCode: next.code } });
      }
    }
    if (has("INVOICE") && load.status === "DELIVERED" && !invoiced.has(load.id)) {
      const drove = load.legs.some((l) => l.driverAccountIds.includes(data.accountId));
      if ((drove && caps.ownerOperator) || (load.carrierOrgId && orgsWith("INVOICE").includes(load.carrierOrgId))) {
        items.push({ id: `invoice:${load.id}`, hat: "BILLING", priority: 70, title: `Invoice ${load.loadNumber}`, subtitle: "Delivered. Send the invoice in the format your customer requires.", loadId: load.id, cta: { label: "Send invoice", action: "invoice" } });
      }
    }
    if (load.carrierOrgId && dispatchOrgs.includes(load.carrierOrgId)) {
      if (load.status === "TENDERED") {
        items.push({ id: `tender:${load.id}`, hat: "DISPATCH", priority: 95, title: `Tender ${load.loadNumber}`, subtitle: `${stopSummary(load)} · ${money(load)}`, loadId: load.id, cta: { label: "Accept or decline", action: "tender-response" } });
      }
      if (["BOOKED", "DISPATCHED"].includes(load.status)) {
        const needsTeam = load.teamRequired || load.service === "TEAM_EXPEDITED";
        const legs = load.legs.length ? load.legs : [undefined];
        const unassigned = legs.filter((l) => !l || l.driverAccountIds.length < (needsTeam ? 2 : 1)).length;
        if (unassigned > 0) {
          items.push({ id: `assign:${load.id}`, hat: "DISPATCH", priority: needsTeam ? 92 : 90, title: `${needsTeam ? "Assign a team" : "Assign a driver"} for ${load.loadNumber}`, subtitle: `${unassigned} leg${unassigned > 1 ? "s" : ""} unassigned · ${stopSummary(load)}`, loadId: load.id, cta: { label: "Plan dispatch", action: "dispatch" } });
        }
      }
    }
    if (shipOrgs.includes(load.shipperOrgId) || (load.brokerOrgId && shipOrgs.includes(load.brokerOrgId))) {
      const hat: Hat = load.brokerOrgId && shipOrgs.includes(load.brokerOrgId) ? "BROKERAGE" : "SHIPPING";
      if (load.status === "DRAFT") items.push({ id: `draft:${load.id}`, hat, priority: 60, title: `Finish ${load.loadNumber}`, subtitle: "Draft: post it to the board or tender it to a carrier", loadId: load.id, cta: { label: "Continue", action: "edit" } });
      if (load.status === "POSTED") {
        const open = (data.bids ?? []).filter((b) => b.loadId === load.id && b.status === "OPEN").length;
        if (open > 0) items.push({ id: `bids:${load.id}`, hat, priority: 85, title: `${open} bid${open > 1 ? "s" : ""} on ${load.loadNumber}`, subtitle: stopSummary(load), loadId: load.id, cta: { label: "Review bids", action: "bids" } });
      }
      const pickup = load.stops.find((s) => s.type === "PICKUP");
      if (["BOOKED", "DISPATCHED", "AT_PICKUP"].includes(load.status) && !load.shipConfirmedAt && pickup && Date.parse(pickup.window.start) - Date.parse(now) < 24 * 3_600_000) {
        items.push({ id: `confirm:${load.id}`, hat, priority: 65, title: `Confirm shipment ${load.loadNumber}`, subtitle: "Changes stay open until you confirm or the driver picks up", loadId: load.id, cta: { label: "Ship confirm", action: "ship-confirm" } });
      }
    }
    const unread = data.unreadByLoad?.[load.id] ?? 0;
    if (unread > 0) items.push({ id: `msg:${load.id}`, hat: "MESSAGES", priority: 55, title: `${unread} new message${unread > 1 ? "s" : ""} on ${load.loadNumber}`, loadId: load.id, cta: { label: "Open thread", action: "messages" } });
  }

  for (const a of data.arrivalAlerts ?? []) {
    const hat: Hat = has("SHIP") || has("BROKER") ? "SHIPPING" : "DISPATCH";
    items.push({ id: `arrival:${a.loadId}`, hat, priority: a.status === "LATE" ? 94 : 86, title: `${a.loadNumber} ${a.status === "LATE" ? "will be late" : "is at risk of arriving late"}`, subtitle: a.reason, loadId: a.loadId, cta: { label: "Track", action: "track" } });
  }

  for (const r of data.rateConsToSign ?? []) {
    items.push({ id: `ratecon:${r.loadId}`, hat: "DISPATCH", priority: 84, title: `Sign rate confirmation ${r.loadNumber} v${r.version}`, subtitle: r.changes.length ? `Shipper changed: ${r.changes.join(", ")}` : undefined, loadId: r.loadId, cta: { label: "Review and sign", action: "rate-con" } });
  }

  if (has("PAY")) {
    const payOrgs = orgsWith("PAY");
    const today = (data.now ?? new Date().toISOString()).slice(0, 10);
    for (const inv of data.invoices ?? []) {
      const payer = !!inv.billTo.orgId && payOrgs.includes(inv.billTo.orgId);
      const biller = payOrgs.includes(inv.carrierOrgId);
      const due = invoiceDue(inv);
      const open = ["SENT", "ACKNOWLEDGED", "APPROVED", "PARTIALLY_PAID"].includes(inv.status);
      const money = `$${inv.total.toFixed(2)} · load ${inv.loadNumber}`;
      if (payer && inv.quickPay?.status === "REQUESTED") {
        items.push({ id: `qp:${inv.id}`, hat: "BILLING", priority: 72, title: `Quick pay requested on ${inv.invoiceNumber}`, subtitle: `$${inv.quickPay.netAmount.toFixed(2)} in ${inv.quickPay.days} days (${inv.quickPay.feePct}% fee)`, loadId: inv.loadId, invoiceId: inv.id, cta: { label: "Decide", action: "open-invoice" } });
      } else if (payer && inv.status === "SENT") {
        items.push({ id: `pay:${inv.id}`, hat: "BILLING", priority: 50, title: `Invoice ${inv.invoiceNumber} received`, subtitle: `${money} · due ${due}`, loadId: inv.loadId, invoiceId: inv.id, cta: { label: "Review", action: "open-invoice" } });
      } else if (payer && open && due < today) {
        items.push({ id: `late:${inv.id}`, hat: "BILLING", priority: 60, title: `Invoice ${inv.invoiceNumber} is past due`, subtitle: `${money} · was due ${due}`, loadId: inv.loadId, invoiceId: inv.id, cta: { label: "Pay", action: "open-invoice" } });
      }
      if (biller && inv.status === "DISPUTED") {
        items.push({ id: `dispute:${inv.id}`, hat: "BILLING", priority: 75, title: `Invoice ${inv.invoiceNumber} disputed`, subtitle: inv.disputeReason, loadId: inv.loadId, invoiceId: inv.id, cta: { label: "Open", action: "open-invoice" } });
      } else if (biller && open && due < today) {
        items.push({ id: `overdue:${inv.id}`, hat: "BILLING", priority: 45, title: `Invoice ${inv.invoiceNumber} is overdue`, subtitle: `${money} · was due ${due}`, loadId: inv.loadId, invoiceId: inv.id, cta: { label: "Open", action: "open-invoice" } });
      }
    }
  }
  if (has("BID")) {
    const myBidLoads = new Set((data.bids ?? []).map((b) => b.loadId));
    for (const l of (data.boardLoads ?? []).filter((x) => !myBidLoads.has(x.id)).slice(0, 5)) {
      items.push({ id: `board:${l.id}`, hat: "DISPATCH", priority: 40, title: `Open load ${l.loadNumber}`, subtitle: `${stopSummary(l)} · ${l.service === "TEAM_EXPEDITED" ? "Team expedited" : l.mode}`, loadId: l.id, cta: { label: "Bid", action: "bid" } });
    }
  }
  return items.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

function invoiceDue(inv: Invoice): string {
  const from = inv.quickPay?.status === "APPROVED" && inv.quickPay.decidedAt ? inv.quickPay.decidedAt : inv.issuedAt;
  const days = inv.quickPay?.status === "APPROVED" ? inv.quickPay.days : (inv.termsDays ?? 30);
  return new Date(Date.parse(from) + days * 86_400_000).toISOString().slice(0, 10);
}

function stopSummary(load: Load): string {
  const pu = load.stops.find((s) => s.type === "PICKUP");
  const del = [...load.stops].reverse().find((s) => s.type === "DELIVERY");
  return pu && del ? `${pu.address.city}, ${pu.address.state} → ${del.address.city}, ${del.address.state}` : load.loadNumber;
}

function money(load: Load): string {
  return load.rate ? `$${load.rate.amount.toLocaleString("en-US")}` : "rate TBD";
}
