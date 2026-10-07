import { type AlertStatus, type Load, type ShipmentEta, alertMessage, digestMessage, dueSlots, isAlertableChange, isRepeat } from "@logisticspro/domain";
import { type AppContext, capsOf } from "../http.js";
import type { PushMessage } from "./push.js";
import { etaFor, lane } from "./tracking.js";

/** Loads whose arrival is worth watching: a carrier is on them and they are not delivered. */
const WATCHED = ["TENDERED", "BOOKED", "DISPATCHED", "AT_PICKUP", "IN_TRANSIT", "AT_DELIVERY"];

/**
 * Who hears about a load: the shipper's and broker's shipping staff and the
 * carrier's dispatchers. Drivers are not alerted about their own ETA.
 */
export function alertAudience(ctx: AppContext, load: Load): string[] {
  const roles: Array<[string | undefined, "SHIP" | "BROKER" | "DISPATCH"]> = [
    [load.shipperOrgId, "SHIP"],
    [load.brokerOrgId, "BROKER"],
    [load.carrierOrgId, "DISPATCH"],
  ];
  const out = new Set<string>();
  for (const [orgId, cap] of roles) {
    if (!orgId) continue;
    for (const m of ctx.store.memberships) if (m.orgId === orgId && capsOf(ctx, m.accountId).byOrg.get(orgId)?.has(cap)) out.add(m.accountId);
  }
  return [...out];
}

/**
 * Checks every watched shipment's arrival status on a timer.
 *
 * - Instant alerts: when a shipment's status changes into one a person chose
 *   (for example it is now at risk, or now late), they get a push at once.
 * - Scheduled summaries: at each local time a person chose, a push listing
 *   every shipment currently in one of their chosen statuses.
 *
 * Every alert also lands in the in-app inbox, which is what the website shows.
 */
export class AlertEngine {
  private running = false;

  constructor(private readonly ctx: AppContext) {}

  async tick(): Promise<{ alerts: number; summaries: number }> {
    if (this.running) return { alerts: 0, summaries: 0 };
    this.running = true;
    try {
      return await this.run();
    } finally {
      this.running = false;
    }
  }

  private async run() {
    const { store } = this.ctx;
    const now = this.ctx.now();
    const at = now.toISOString();
    const pushes: PushMessage[] = [];
    const watched: Array<{ load: Load; eta: ShipmentEta; audience: string[] }> = [];
    let alerts = 0;
    let summaries = 0;

    // Forget loads that are no longer watched (delivered, cancelled or archived).
    for (const id of [...store.arrivalSeen.keys()]) if (!WATCHED.includes(store.loads.get(id)?.status ?? "")) store.arrivalSeen.delete(id);
    for (const load of store.loadsIn(...(WATCHED as Load["status"][]))) {
      const eta = etaFor(store, load, now);
      const audience = alertAudience(this.ctx, load);
      watched.push({ load, eta, audience });
      const prev = store.arrivalSeen.get(load.id);
      store.arrivalSeen.set(load.id, eta.status);
      if (!isAlertableChange(prev, eta.status)) continue;
      const status: AlertStatus = eta.status;
      for (const accountId of audience) {
        const prefs = store.alertPrefs.get(accountId);
        if (!prefs?.instant || !prefs.statuses.includes(status)) continue;
        const key = `${accountId}:${load.id}`;
        if (isRepeat(store.alertSent.get(key), status, now)) continue;
        store.alertSent.set(key, { status, at });
        pushes.push(...this.ctx.notifier.deliver(accountId, { kind: "ARRIVAL", target: "LOAD", ...alertMessage({ loadNumber: load.loadNumber, ...lane(load), eta }, status, prefs.timeZone), loadId: load.id, status }));
        alerts++;
      }
    }

    for (const [accountId, prefs] of store.alertPrefs) {
      if (!prefs.schedule) continue;
      for (const slot of dueSlots(prefs.schedule, prefs.timeZone, now)) {
        const key = `${accountId}:${slot}`;
        if (store.digestsSent.has(key)) continue;
        store.digestsSent.set(key, at);
        const items = watched
          .filter((w) => w.audience.includes(accountId) && prefs.statuses.includes(w.eta.status as AlertStatus))
          .map((w) => ({ loadNumber: w.load.loadNumber, ...lane(w.load), eta: w.eta, status: w.eta.status as AlertStatus }));
        if (!items.length && prefs.schedule.skipWhenEmpty) continue;
        pushes.push(...this.ctx.notifier.deliver(accountId, { kind: "SUMMARY", ...digestMessage(items, prefs.statuses, prefs.timeZone) }));
        summaries++;
      }
    }
    for (const [key, sentAt] of store.digestsSent) if (now.getTime() - Date.parse(sentAt) > 2 * 86_400_000) store.digestsSent.delete(key);

    await this.ctx.notifier.send(pushes);
    return { alerts, summaries };
  }

  /** A test alert so a person can check their phone receives them. */
  async test(accountId: string): Promise<{ devices: number }> {
    const msgs = this.ctx.notifier.deliver(accountId, { kind: "TEST", title: "Arrival alerts are on", body: "This is how late and at-risk shipments will reach you." });
    await this.ctx.notifier.send(msgs);
    return { devices: msgs.length };
  }
}
