import type { OutboundMessage, Transport, TransportResult } from "../transport.js";
import { type As2Identity, As2Error, buildAs2Message, micMatches, parseMdn } from "./as2.js";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Sends EDI over AS2 from the platform's single station and checks the
 * synchronous MDN: the partner must report "processed" and return the MIC we
 * computed, which proves they received exactly what we sent.
 */
export class As2Transport implements Transport {
  constructor(
    private readonly us: () => As2Identity,
    private readonly opts: { fetch?: FetchLike; receiptUrl?: string } = {},
  ) {}

  async send(msg: OutboundMessage): Promise<TransportResult> {
    const partner = msg.as2;
    if (!partner) return { ok: false, error: "AS2 partner settings are missing", attempts: 0 };
    const out = buildAs2Message(Buffer.from(msg.body, "utf8"), { contentType: msg.contentType, filename: msg.filename, us: this.us(), partner, receiptUrl: this.opts.receiptUrl });
    const doFetch = this.opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    try {
      const res = await doFetch(partner.url, { method: "POST", headers: out.headers, body: new Uint8Array(out.body) });
      const raw = Buffer.from(await res.arrayBuffer());
      if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}`, body: raw.toString("utf8").slice(0, 500), attempts: 1 };
      if (partner.mdn === "none") return { ok: true, status: res.status, body: JSON.stringify({ messageId: out.messageId }), attempts: 1 };
      const mdn = parseMdn(res.headers.get("content-type") ?? "", raw, partner.mdn === "signed" ? partner.certificatePem : undefined);
      const micOk = micMatches(mdn.mic, out.mic);
      const ok = mdn.processed && micOk && (partner.mdn !== "signed" || mdn.signed);
      return {
        ok,
        status: res.status,
        attempts: 1,
        body: JSON.stringify({ messageId: out.messageId, mdn: mdn.disposition, micMatched: micOk, signedReceipt: mdn.signed }),
        error: ok ? undefined : mdn.error ?? (!micOk ? "MDN MIC does not match what was sent" : "MDN was not signed"),
      };
    } catch (e) {
      return { ok: false, error: e instanceof As2Error ? `${e.disposition}: ${e.message}` : (e as Error).message, attempts: 1 };
    }
  }
}
