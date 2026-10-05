import { type Load, type Message, carrierKeyOf, newId } from "@logisticspro/domain";
import { type AppContext, capsOf } from "../http.js";
import type { InboxItem, NotificationSettings } from "../store.js";
import type { PushMessage } from "./push.js";
import { lane } from "./tracking.js";

const INBOX_LIMIT = 200;
const RECEIPT_AFTER_MS = 15 * 60_000;
const RECEIPT_KEEP_MS = 24 * 3_600_000;
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = { tenders: true, messages: true };

/**
 * Every notification goes through here: it lands in the person's in-app
 * inbox and is pushed to each phone they registered. Pushes are sent in the
 * background so a request never waits on Expo.
 */
export class Notifier {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: AppContext) {}

  settings(accountId: string): NotificationSettings {
    return { ...DEFAULT_NOTIFICATION_SETTINGS, ...this.ctx.store.notificationSettings.get(accountId) };
  }

  timeZone(accountId: string): string {
    return this.settings(accountId).timeZone ?? this.ctx.store.alertPrefs.get(accountId)?.timeZone ?? "UTC";
  }

  /** Adds the item to the inbox and returns one push per registered phone. */
  deliver(accountId: string, item: Omit<InboxItem, "id" | "at" | "read">, extra: Record<string, string> = {}): PushMessage[] {
    const { store } = this.ctx;
    const entry: InboxItem = { id: newId("ntf"), at: this.ctx.now().toISOString(), read: false, ...item };
    store.notifications.set(accountId, [entry, ...(store.notifications.get(accountId) ?? [])].slice(0, INBOX_LIMIT));
    const data: Record<string, string> = { notificationId: entry.id, kind: item.kind, ...(item.loadId ? { loadId: item.loadId } : {}), ...(item.target ? { open: item.target } : {}), ...extra };
    return (store.pushTokens.get(accountId) ?? []).map((t) => ({ to: t.token, title: item.title, body: item.body, data }));
  }

  /** Queue pushes; dead phones are forgotten. Resolves when these are sent. */
  send(messages: PushMessage[]): Promise<void> {
    if (!messages.length) return this.queue;
    this.queue = this.queue
      .then(async () => {
        const results = await this.ctx.push.send(messages);
        const at = this.ctx.now().toISOString();
        for (const r of results) if (r.ticketId) this.ctx.store.pushTickets.push({ id: r.ticketId, token: r.token, at });
        this.forget(new Set(results.filter((r) => r.unregistered).map((r) => r.token)));
      })
      .catch(() => undefined);
    return this.queue;
  }

  private forget(dead: Set<string>) {
    if (!dead.size) return;
    for (const [id, tokens] of this.ctx.store.pushTokens) this.ctx.store.pushTokens.set(id, tokens.filter((t) => !dead.has(t.token)));
  }

  /**
   * Check delivery receipts for pushes sent 15 minutes to a day ago, as Expo
   * recommends, and forget phones whose app is gone. Expo keeps receipts for
   * a day; older tickets are dropped unchecked.
   */
  async checkReceipts(): Promise<{ checked: number; forgotten: number }> {
    const sender = this.ctx.push;
    const store = this.ctx.store;
    const now = this.ctx.now().getTime();
    const due = store.pushTickets.filter((t) => now - Date.parse(t.at) >= RECEIPT_AFTER_MS && now - Date.parse(t.at) < RECEIPT_KEEP_MS);
    store.pushTickets = store.pushTickets.filter((t) => now - Date.parse(t.at) < RECEIPT_AFTER_MS);
    if (!due.length || !sender.receipts) return { checked: 0, forgotten: 0 };
    let receipts: Awaited<ReturnType<NonNullable<typeof sender.receipts>>>;
    try {
      receipts = await sender.receipts(due.map((t) => t.id));
    } catch {
      // Try again next time.
      store.pushTickets.push(...due);
      return { checked: 0, forgotten: 0 };
    }
    // Receipts not ready yet stay for the next check.
    store.pushTickets.push(...due.filter((t) => !receipts[t.id]));
    const dead = new Set(due.filter((t) => receipts[t.id]?.unregistered).map((t) => t.token));
    this.forget(dead);
    return { checked: due.length, forgotten: dead.size };
  }

  /** Wait for queued pushes (tests and shutdown). */
  flush(): Promise<void> {
    return this.queue;
  }

  /** Members of an org who hold a capability there. */
  private holders(orgId: string | undefined, cap: "SHIP" | "BROKER" | "DISPATCH"): string[] {
    if (!orgId) return [];
    return this.ctx.store.memberships.filter((m) => m.orgId === orgId && capsOf(this.ctx, m.accountId).byOrg.get(orgId)?.has(cap)).map((m) => m.accountId);
  }

  private carrierName(load: Pick<Load, "carrierOrgId" | "externalCarrierKey" | "brokerOrgId" | "shipperOrgId">): string {
    if (load.carrierOrgId) return this.ctx.store.orgs.get(load.carrierOrgId)?.name ?? "The carrier";
    const owner = load.brokerOrgId ?? load.shipperOrgId;
    return (load.externalCarrierKey && this.ctx.store.profile(owner, load.externalCarrierKey)?.name) || load.externalCarrierKey || "The carrier";
  }

  /** New tenders to a carrier's dispatchers; accepted or declined tenders back to whoever tendered. */
  loadSaved(prior: Load | undefined, next: Load): void {
    const pushes: PushMessage[] = [];
    const { origin, destination } = lane(next);
    const tenderedNow = next.status === "TENDERED" && !!next.carrierOrgId && (prior?.status !== "TENDERED" || prior.carrierOrgId !== next.carrierOrgId);
    if (tenderedNow) {
      const from = this.ctx.store.orgs.get(next.brokerOrgId ?? next.shipperOrgId)?.name ?? "A shipper";
      const pickup = [...next.stops].sort((a, b) => a.sequence - b.sequence)[0];
      for (const id of this.holders(next.carrierOrgId, "DISPATCH")) {
        if (!this.settings(id).tenders) continue;
        const when = pickup ? `, pickup ${new Intl.DateTimeFormat("en-US", { timeZone: this.timeZone(id), weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(pickup.window.start))}` : "";
        const rate = next.rate ? `, $${next.rate.amount.toLocaleString("en-US")}` : "";
        pushes.push(...this.deliver(id, { kind: "TENDER", target: "LOAD", loadId: next.id, title: `New tender ${next.loadNumber}`, body: `${from}: ${origin} to ${destination}${when}${rate}. Accept or decline.` }));
      }
    }
    if (prior?.status === "TENDERED" && carrierKeyOf(prior)) {
      const accepted = next.status === "BOOKED" && carrierKeyOf(next) === carrierKeyOf(prior);
      const declined = next.status === "DRAFT" && !carrierKeyOf(next);
      if (accepted || declined) {
        const carrier = this.carrierName(prior);
        const tenderer = next.brokerOrgId ?? next.shipperOrgId;
        for (const id of this.holders(tenderer, next.brokerOrgId ? "BROKER" : "SHIP")) {
          if (!this.settings(id).tenders) continue;
          pushes.push(
            ...this.deliver(id, {
              kind: "TENDER",
              target: "LOAD",
              loadId: next.id,
              title: `Tender ${accepted ? "accepted" : "declined"}: ${next.loadNumber}`,
              body: accepted ? `${carrier} booked ${origin} to ${destination}${next.references.pro ? `, PRO ${next.references.pro}` : ""}.` : `${carrier} declined ${origin} to ${destination}. Tender it to another carrier or post it to the board.`,
            }),
          );
        }
      }
    }
    void this.send(pushes);
  }

  /** A person's message to everyone else on the load: drivers, dispatch, shipping staff. */
  messagePosted(msg: Message, load: Load): void {
    if (msg.kind !== "TEXT") return;
    const visible = new Set(msg.visibleToOrgIds);
    const to = new Set<string>([
      ...(visible.has(load.shipperOrgId) ? this.holders(load.shipperOrgId, "SHIP") : []),
      ...(load.brokerOrgId && visible.has(load.brokerOrgId) ? this.holders(load.brokerOrgId, "BROKER") : []),
      ...(load.carrierOrgId && visible.has(load.carrierOrgId) ? [...this.holders(load.carrierOrgId, "DISPATCH"), ...load.legs.flatMap((l) => l.driverAccountIds)] : []),
    ]);
    to.delete(msg.senderAccountId);
    const sender = this.ctx.store.accounts.get(msg.senderAccountId)?.name ?? "Someone";
    const body = msg.body.length > 200 ? `${msg.body.slice(0, 197)}...` : msg.body;
    const pushes: PushMessage[] = [];
    for (const id of to) {
      if (!this.settings(id).messages) continue;
      pushes.push(...this.deliver(id, { kind: "MESSAGE", target: "THREAD", loadId: load.id, title: `${sender} · ${load.loadNumber}`, body }, { loadNumber: load.loadNumber }));
    }
    void this.send(pushes);
  }
}
