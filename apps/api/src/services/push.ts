/** One phone notification. `data.loadId` opens that load when tapped. */
export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushResult {
  token: string;
  ok: boolean;
  /** Accepted by the push service; its delivery receipt is checked later. */
  ticketId?: string;
  /** The token is dead (app uninstalled, signed out) and should be forgotten. */
  unregistered?: boolean;
  error?: string;
}

export interface Receipt {
  ok: boolean;
  unregistered?: boolean;
  error?: string;
}

export interface PushSender {
  send(messages: PushMessage[]): Promise<PushResult[]>;
  /**
   * Delivery receipts by ticket id. Most uninstalled apps are reported here,
   * not when sending. Ids with no receipt yet are left out.
   */
  receipts?(ticketIds: string[]): Promise<Record<string, Receipt>>;
}

export const isExpoPushToken = (t: string) => /^Expo(nent)?PushToken\[[^\]]+\]$/.test(t);

/**
 * Expo's push service relays to Apple (APNs) and Google (FCM), so the server
 * needs no Apple or Google keys of its own; those live in the Expo project.
 */
export class ExpoPushSender implements PushSender {
  constructor(
    private readonly accessToken?: string,
    private readonly url = "https://exp.host/--/api/v2/push/send",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly receiptsUrl = "https://exp.host/--/api/v2/push/getReceipts",
  ) {}

  private headers() {
    return { "content-type": "application/json", accept: "application/json", ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}) };
  }

  async receipts(ticketIds: string[]): Promise<Record<string, Receipt>> {
    const out: Record<string, Receipt> = {};
    // Expo accepts up to 1,000 ids per request.
    for (let i = 0; i < ticketIds.length; i += 1000) {
      const res = await this.fetchImpl(this.receiptsUrl, { method: "POST", headers: this.headers(), body: JSON.stringify({ ids: ticketIds.slice(i, i + 1000) }) });
      if (!res.ok) throw new Error(`Expo receipts returned ${res.status}`);
      const data = ((await res.json()) as { data?: Record<string, { status: string; message?: string; details?: { error?: string } }> }).data ?? {};
      for (const [id, r] of Object.entries(data)) out[id] = r.status === "ok" ? { ok: true } : { ok: false, unregistered: r.details?.error === "DeviceNotRegistered", error: r.message };
    }
    return out;
  }

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    const out: PushResult[] = [];
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      const body = chunk.map((m) => ({ to: m.to, title: m.title, body: m.body, data: m.data, sound: "default", priority: "high", channelId: "arrival" }));
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Expo push returned ${res.status}`);
        const tickets = ((await res.json()) as { data?: Array<{ status: string; id?: string; message?: string; details?: { error?: string } }> }).data ?? [];
        chunk.forEach((m, j) => {
          const t = tickets[j];
          out.push(t?.status === "ok" ? { token: m.to, ok: true, ticketId: t.id } : { token: m.to, ok: false, unregistered: t?.details?.error === "DeviceNotRegistered", error: t?.message ?? "No ticket" });
        });
      } catch (e) {
        for (const m of chunk) out.push({ token: m.to, ok: false, error: (e as Error).message });
      }
    }
    return out;
  }
}

/** Keeps alerts in the in-app inbox only. */
export class NoPushSender implements PushSender {
  async send(messages: PushMessage[]): Promise<PushResult[]> {
    return messages.map((m) => ({ token: m.to, ok: false, error: "Push is turned off" }));
  }
}

/** For tests: records what would have been sent. */
export class MemoryPushSender implements PushSender {
  sent: PushMessage[] = [];
  /** Rejected at send time. */
  dead = new Set<string>();
  /** Accepted, but the receipt later says the app is gone. */
  goneLater = new Set<string>();
  private tickets = new Map<string, string>();
  async send(messages: PushMessage[]): Promise<PushResult[]> {
    this.sent.push(...messages);
    return messages.map((m) => {
      if (this.dead.has(m.to)) return { token: m.to, ok: false, unregistered: true, error: "DeviceNotRegistered" };
      const ticketId = `ticket-${this.tickets.size + 1}`;
      this.tickets.set(ticketId, m.to);
      return { token: m.to, ok: true, ticketId };
    });
  }
  async receipts(ids: string[]): Promise<Record<string, Receipt>> {
    return Object.fromEntries(ids.filter((id) => this.tickets.has(id)).map((id) => [id, this.goneLater.has(this.tickets.get(id)!) ? { ok: false, unregistered: true, error: "DeviceNotRegistered" } : { ok: true }]));
  }
}
