import { type InboundEdiResult, as2 } from "@logisticspro/integration";
import type { FastifyInstance } from "fastify";
import { type AppContext, authenticate } from "../http.js";
import { applyAcks, type AppliedDoc, applyEdi, shipmentIdOf } from "../services/inbound.js";
import type { StoredProfile } from "../store.js";

const unquote = (v: unknown) => String(v ?? "").trim().replace(/^"(.*)"$/, "$1");

/**
 * One central AS2 station for the whole platform.
 *
 * Partners point their AS2 software at POST /as2 with AS2-To = the station id
 * and trust the station certificate (GET /as2/certificate). Each business
 * only records the partner's AS2 id, URL and certificate on its partner
 * profile. Inbound messages are matched to the business by AS2-From and the
 * X12 interchange receiver id, decrypted, verified, applied, answered with a
 * synchronous MDN, and acknowledged with a 997 sent back over AS2.
 */
export function as2Routes(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/integrations/as2", { preHandler: authenticate(ctx) }, async () => ({
    as2Id: ctx.as2.as2Id,
    url: `${ctx.cfg.publicUrl}/as2`,
    certificateUrl: `${ctx.cfg.publicUrl}/as2/certificate`,
    certificatePem: ctx.as2.certificatePem,
    fingerprintSha256: as2.certificateFingerprint(ctx.as2.certificatePem),
    encryption: ["aes256-CBC", "aes192-CBC", "aes128-CBC", "des-EDE3-CBC"],
    signing: ["sha256", "sha384", "sha512", "sha1"],
    mdn: "synchronous, signed or unsigned",
  }));

  app.get("/as2/certificate", async (_req, reply) => {
    reply.type("application/x-pem-file").header("content-disposition", 'attachment; filename="logisticspro-as2.pem"');
    return ctx.as2.certificatePem;
  });

  app.post("/as2", async (req, reply) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""), "latin1");
    const from = unquote(req.headers["as2-from"]);
    const candidates = [...ctx.store.profiles.values()].filter((p) => p.as2 && p.as2.as2Id.toLowerCase() === from.toLowerCase());
    const messageId = String(req.headers["message-id"] ?? "").trim();
    const wantsMdn = !!req.headers["disposition-notification-to"];
    const signMdn = /pkcs7-signature/i.test(String(req.headers["disposition-notification-options"] ?? ""));

    const answer = (opts: { mic?: string; error?: string; text?: string }) => {
      if (!wantsMdn) {
        reply.code(opts.error ? 400 : 200);
        return opts.error ? { error: opts.error } : "";
      }
      const mdn = as2.buildMdn({ us: ctx.as2, partnerAs2Id: from || "UNKNOWN", originalMessageId: messageId || "<unknown>", sign: signMdn, ...opts });
      for (const [k, v] of Object.entries(mdn.headers)) reply.header(k, v);
      return mdn.body;
    };

    let received: ReturnType<typeof as2.receiveAs2>;
    try {
      received = as2.receiveAs2(req.headers as Record<string, string>, body, ctx.as2, () => candidates[0]?.as2);
    } catch (e) {
      const disposition = e instanceof as2.As2Error ? e.disposition : "unexpected-processing-error";
      req.log.warn({ from, err: (e as Error).message }, "AS2 message rejected");
      return answer({ error: disposition, text: (e as Error).message });
    }

    const raw = received.payload.toString("latin1");
    let result: InboundEdiResult;
    try {
      result = ctx.engine.parseEdi(raw, (candidates[0]?.edi?.codeOverrides ?? {}) as never);
    } catch (e) {
      return answer({ error: "unexpected-processing-error", text: `Not a valid X12 interchange: ${(e as Error).message}` });
    }

    // Which business is this for? The interchange receiver id names it; when
    // several businesses share an id with this partner, the load number decides.
    const receiver = result.interchange.receiverId.toUpperCase();
    const byId = candidates.filter((p) => (p.edi?.senderId ?? ctx.cfg.ediSenderId).toUpperCase() === receiver);
    const pool = byId.length ? byId : candidates;
    const profileFor = (d: { doc: unknown }): StoredProfile | { error: string } => {
      if (pool.length === 1) return pool[0]!;
      const sid = shipmentIdOf(d.doc);
      const load = sid ? ctx.store.loadByNumber(sid) : undefined;
      const owner = load && pool.find((p) => [load.shipperOrgId, load.brokerOrgId, load.carrierOrgId].includes(p.ownerOrgId));
      return owner ?? { error: `Several businesses trade with ${from} under interchange id ${receiver}; give each a distinct EDI interchange id` };
    };
    const applied: AppliedDoc[] = await applyEdi(ctx, raw, result, profileFor, "AS2");
    applyAcks(ctx, result.acks, (t) => candidates.some((p) => p.ownerOrgId === t.ownerOrgId && p.key === t.partnerKey));
    reply.header("x-lp-results", JSON.stringify(applied).slice(0, 2000));

    // The 997 goes back as its own AS2 message, after this response.
    const ackTo = pool[0];
    if (result.ack997 && ackTo?.as2) {
      const ack = result.ack997;
      setImmediate(async () => {
        const r = await ctx.as2Transport.send({ partnerKey: ackTo.key, transport: "AS2", httpMethod: "POST", headers: {}, contentType: "application/edi-x12", body: ack, filename: "997.x12", as2: ackTo.as2 });
        ctx.store.transmissions.push({ id: `tx_997_${Date.now().toString(36)}`, partnerKey: ackTo.key, ownerOrgId: ackTo.ownerOrgId, transaction: "TENDER_RESPONSE", method: "EDI_X12", transport: "AS2", direction: "OUTBOUND", status: r.ok ? "SENT" : "FAILED", contentType: "application/edi-x12", payload: ack, response: r, error: r.error, refs: { ack: "997", originalMessageId: received.messageId }, createdAt: ctx.now().toISOString() });
      });
    }
    return answer({ mic: received.mic });
  });
}
