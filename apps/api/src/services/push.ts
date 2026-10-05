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
  /** The token is dead (app uninstalled, signed out) and should be forgotten. */
  unregistered?: boolean;
  error?: string;
}

export interface PushSender {
  send(messages: PushMessage[]): Promise<PushResult[]>;
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
  ) {}

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    const out: PushResult[] = [];
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      const body = chunk.map((m) => ({ to: m.to, title: m.title, body: m.body, data: m.data, sound: "default", priority: "high", channelId: "arrival" }));
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}) },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Expo push returned ${res.status}`);
        const tickets = ((await res.json()) as { data?: Array<{ status: string; message?: string; details?: { error?: string } }> }).data ?? [];
        chunk.forEach((m, j) => {
          const t = tickets[j];
          out.push(t?.status === "ok" ? { token: m.to, ok: true } : { token: m.to, ok: false, unregistered: t?.details?.error === "DeviceNotRegistered", error: t?.message ?? "No ticket" });
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
  dead = new Set<string>();
  async send(messages: PushMessage[]): Promise<PushResult[]> {
    this.sent.push(...messages);
    return messages.map((m) => (this.dead.has(m.to) ? { token: m.to, ok: false, unregistered: true, error: "DeviceNotRegistered" } : { token: m.to, ok: true }));
  }
}
