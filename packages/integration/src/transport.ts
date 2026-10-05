import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthConfig, TransportKind } from "./profile.js";

export interface OutboundMessage {
  partnerKey: string;
  transport: TransportKind;
  url?: string;
  httpMethod: "POST" | "PUT";
  headers: Record<string, string>;
  contentType: string;
  body: string;
  /** Suggested file name for file-based transports. */
  filename: string;
}

export interface TransportResult {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
  attempts: number;
}

export interface Transport {
  send(msg: OutboundMessage): Promise<TransportResult>;
}

export type SecretResolver = (ref: string) => string | undefined;

/** Resolve secret references from environment variables (LP_SECRET_<REF>). */
export const envSecrets: SecretResolver = (ref) => process.env[`LP_SECRET_${ref.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** HTTPS delivery with retry on network errors, 429 and 5xx. */
export class HttpTransport implements Transport {
  constructor(
    private readonly opts: { fetch?: FetchLike; maxAttempts?: number; baseDelayMs?: number } = {},
  ) {}

  async send(msg: OutboundMessage): Promise<TransportResult> {
    if (!msg.url) return { ok: false, error: "no endpoint url", attempts: 0 };
    const doFetch = this.opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const max = this.opts.maxAttempts ?? 3;
    let last: TransportResult = { ok: false, attempts: 0 };
    for (let attempt = 1; attempt <= max; attempt++) {
      try {
        const res = await doFetch(msg.url, { method: msg.httpMethod, headers: { "content-type": msg.contentType, ...msg.headers }, body: msg.body });
        const body = await res.text();
        last = { ok: res.ok, status: res.status, body, attempts: attempt, error: res.ok ? undefined : `HTTP ${res.status}` };
        if (res.ok || (res.status < 500 && res.status !== 429)) return last;
      } catch (e) {
        last = { ok: false, error: (e as Error).message, attempts: attempt };
      }
      if (attempt < max) await new Promise((r) => setTimeout(r, (this.opts.baseDelayMs ?? 500) * 2 ** (attempt - 1)));
    }
    return last;
  }
}

/**
 * AS2, SFTP and VAN delivery are handed to an EDI gateway (for example an
 * AS2 server or VAN client) through an outbox directory per partner.
 */
export class OutboxTransport implements Transport {
  constructor(private readonly dir: string) {}
  async send(msg: OutboundMessage): Promise<TransportResult> {
    const folder = join(this.dir, msg.transport.toLowerCase(), msg.partnerKey.replace(/[^\w.-]/g, "_"));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, msg.filename), msg.body, "utf8");
    return { ok: true, attempts: 1, body: join(folder, msg.filename) };
  }
}

/** Records messages in memory. Used in development and tests. */
export class MemoryTransport implements Transport {
  readonly sent: OutboundMessage[] = [];
  constructor(private readonly respond: (m: OutboundMessage) => TransportResult = () => ({ ok: true, status: 200, attempts: 1 })) {}
  async send(msg: OutboundMessage): Promise<TransportResult> {
    this.sent.push(msg);
    return this.respond(msg);
  }
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function authHeaders(auth: AuthConfig, secrets: SecretResolver, fetchImpl?: FetchLike): Promise<Record<string, string>> {
  const need = (ref: string) => {
    const v = secrets(ref);
    if (!v) throw new Error(`secret "${ref}" is not configured`);
    return v;
  };
  switch (auth.type) {
    case "none":
      return {};
    case "apiKey":
      return { [auth.header]: need(auth.secretRef) };
    case "bearer":
      return { authorization: `Bearer ${need(auth.secretRef)}` };
    case "basic":
      return { authorization: `Basic ${Buffer.from(`${need(auth.usernameRef)}:${need(auth.passwordRef)}`).toString("base64")}` };
    case "oauth2": {
      const key = `${auth.tokenUrl}|${auth.clientIdRef}`;
      const cached = tokenCache.get(key);
      if (cached && cached.expiresAt > Date.now() + 30_000) return { authorization: `Bearer ${cached.token}` };
      const doFetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
      const form = new URLSearchParams({ grant_type: "client_credentials", client_id: need(auth.clientIdRef), client_secret: need(auth.clientSecretRef) });
      if (auth.scope) form.set("scope", auth.scope);
      const res = await doFetch(auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
      if (!res.ok) throw new Error(`OAuth token request failed: HTTP ${res.status}`);
      const json = JSON.parse(await res.text()) as { access_token: string; expires_in?: number };
      tokenCache.set(key, { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 });
      return { authorization: `Bearer ${json.access_token}` };
    }
  }
}
