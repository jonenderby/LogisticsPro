import {
  As2PartnerSettings,
  CARRIER_CATALOG,
  Channel,
  EdiSettings,
  type IntegrationMethod,
  METHOD_PRIORITY,
  PartnerKind,
  type PartnerProfile,
  TRANSACTIONS,
  TransactionType,
  fieldPaths,
  findCarrier,
  invoiceDoc,
  methodSupports,
  profileFromCatalog,
  statusFromEvent,
  tenderFromLoad,
  validateProfile,
} from "@logisticspro/integration";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, getLoad, me, parse, requireOrgCap } from "../http.js";
import { newOpaqueToken, sha256 } from "../security/tokens.js";
import { RECEIVING } from "../services/hub.js";
import { applyEdi, recordInbound } from "../services/inbound.js";
import type { StoredProfile } from "../store.js";

const ProfileInput = z.object({
  name: z.string().min(1),
  kind: PartnerKind,
  scac: z.string().regex(/^[A-Z]{2,4}$/).optional(),
  catalogCode: z.string().optional(),
  channels: z.partialRecord(TransactionType, Channel),
  edi: EdiSettings.partial({ senderId: true }).optional(),
  as2: As2PartnerSettings.optional(),
});

function redact(p: StoredProfile) {
  const { inboundTokenHash, ...rest } = p;
  return { ...rest, inboundEnabled: !!inboundTokenHash, issues: validateProfile(p) };
}

export function integrationRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };

  app.get("/v1/integrations/catalog", auth, async () =>
    CARRIER_CATALOG.map((c) => ({ ...c, defaultMethods: profileFromCatalog(c, "-").channels })),
  );

  /** Each transaction's required and optional fields: identical for every method. */
  app.get("/v1/integrations/transactions", auth, async () =>
    Object.values(TRANSACTIONS).map((t) => ({
      type: t.type,
      title: t.title,
      x12: t.x12?.set,
      methods: METHOD_PRIORITY.filter((m) => methodSupports(m, t.type)),
      ...fieldPaths(t.type),
    })),
  );

  app.get("/v1/orgs/:orgId/partners", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "MANAGE_INTEGRATIONS");
    return ctx.store.profilesOf(orgId).map(redact);
  });

  const save = (orgId: string, key: string, body: z.infer<typeof ProfileInput>): StoredProfile => {
    const prior = ctx.store.profile(orgId, key);
    const profile: StoredProfile = {
      key,
      ownerOrgId: orgId,
      ...body,
      edi: body.edi ? (EdiSettings.parse({ senderId: ctx.cfg.ediSenderId, ...body.edi }) as PartnerProfile["edi"]) : undefined,
      inboundTokenHash: prior?.inboundTokenHash,
      updatedAt: ctx.now().toISOString(),
    };
    ctx.store.profiles.set(`${orgId}:${key}`, profile);
    return profile;
  };

  /**
   * Configure how this business exchanges data with one partner, per
   * transaction: Estes on API JSON, R+L on EDI, a shipper on XML, etc.
   */
  app.put("/v1/orgs/:orgId/partners/:key", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId, key } = req.params as { orgId: string; key: string };
    requireOrgCap(ctx, account.id, orgId, "MANAGE_INTEGRATIONS");
    if (key === RECEIVING) throw new HttpError(400, "INVALID_REQUEST", "Use /receiving for your own receiving preferences");
    return redact(save(orgId, key, parse(ProfileInput, req.body)));
  });

  app.post("/v1/orgs/:orgId/partners/from-catalog/:code", auth, async (req, reply) => {
    const account = me(ctx, req);
    const { orgId, code } = req.params as { orgId: string; code: string };
    requireOrgCap(ctx, account.id, orgId, "MANAGE_INTEGRATIONS");
    const entry = findCarrier(code);
    if (!entry) throw new HttpError(404, "NOT_FOUND", "Carrier not in catalog");
    const seeded = profileFromCatalog(entry, orgId);
    reply.code(201);
    return redact(save(orgId, entry.code, { name: seeded.name, kind: seeded.kind, scac: seeded.scac, catalogCode: seeded.catalogCode, channels: seeded.channels }));
  });

  /**
   * How this business wants to RECEIVE data from anyone on the platform
   * (its ERP/TMS). Senders need no setup: the hub reads these preferences.
   */
  app.put("/v1/orgs/:orgId/receiving", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "MANAGE_INTEGRATIONS");
    const body = parse(ProfileInput.omit({ kind: true, name: true }).extend({ name: z.string().default("Our ERP") }), req.body);
    return redact(save(orgId, RECEIVING, { ...body, kind: "ERP" }));
  });

  /** Issue (or rotate) the token a partner uses to post inbound API/EDI to us. */
  app.post("/v1/orgs/:orgId/partners/:key/inbound-token", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId, key } = req.params as { orgId: string; key: string };
    requireOrgCap(ctx, account.id, orgId, "MANAGE_INTEGRATIONS");
    const profile = ctx.store.profile(orgId, key);
    if (!profile) throw new HttpError(404, "NOT_FOUND", "Partner not configured");
    const t = newOpaqueToken();
    ctx.store.profiles.set(`${orgId}:${key}`, { ...profile, inboundTokenHash: t.hash });
    return { inboundToken: t.token, endpoints: { edi: `/v1/inbound/${orgId}/${key}/edi`, api: `/v1/inbound/${orgId}/${key}/{TRANSACTION}` } };
  });

  /** Render what a partner would receive, without sending. Used while setting up a partner. */
  app.post("/v1/integrations/preview", auth, async (req) => {
    const account = me(ctx, req);
    const body = parse(
      z.object({ orgId: z.string(), partnerKey: z.string(), transaction: TransactionType, loadId: z.string().optional(), invoiceId: z.string().optional(), doc: z.unknown().optional(), method: z.enum(["API_JSON", "API_XML", "EDI_X12"]).optional() }),
      req.body,
    );
    requireOrgCap(ctx, account.id, body.orgId, "MANAGE_INTEGRATIONS");
    const profile = ctx.store.profile(body.orgId, body.partnerKey);
    if (!profile) throw new HttpError(404, "NOT_FOUND", "Partner not configured");
    let doc = body.doc;
    if (!doc && body.loadId) {
      const load = getLoad(ctx, account.id, body.loadId);
      const scac = profile.scac ?? ctx.store.orgs.get(load.carrierOrgId ?? "")?.scac ?? "XXXX";
      if (body.transaction === "LOAD_TENDER") doc = tenderFromLoad(load, scac);
      else if (body.transaction === "SHIPMENT_STATUS") {
        const e = load.events[load.events.length - 1];
        doc = e ? statusFromEvent(load, e, scac) : undefined;
      }
    }
    if (!doc && body.invoiceId) {
      const inv = ctx.store.invoices.get(body.invoiceId);
      const load = inv && ctx.store.loads.get(inv.loadId);
      if (inv && load) doc = invoiceDoc(inv, load.paymentTerms, load.loadNumber);
    }
    if (!doc) throw new HttpError(400, "INVALID_REQUEST", "Provide doc, or a loadId/invoiceId to build one");
    const withEdi = profile.edi ? profile : body.method === "EDI_X12" ? { ...profile, edi: EdiSettings.parse({ senderId: ctx.cfg.ediSenderId, receiverId: profile.scac ?? "PARTNER" }) } : profile;
    const rendered = ctx.engine.render(body.transaction, doc, withEdi, body.method as IntegrationMethod | undefined);
    return { method: rendered.method, contentType: rendered.contentType, body: rendered.body };
  });

  app.get("/v1/orgs/:orgId/transmissions", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "MANAGE_INTEGRATIONS");
    const { loadId } = req.query as { loadId?: string };
    return ctx.store.transmissions.filter((t) => t.ownerOrgId === orgId && (!loadId || t.refs.loadId === loadId)).slice(-200).reverse();
  });

  // ---------------------------------------------------------------- inbound (partner -> us)

  const inboundProfile = (req: FastifyRequest): StoredProfile => {
    const { orgId, key } = req.params as { orgId: string; key: string };
    const token = req.headers["x-lp-inbound-token"];
    const profile = ctx.store.profile(orgId, key);
    if (!profile?.inboundTokenHash || typeof token !== "string" || sha256(token) !== profile.inboundTokenHash) {
      throw new HttpError(401, "UNAUTHENTICATED", "Invalid inbound token");
    }
    return profile;
  };

  /** Raw X12 in, 997 out. Each transaction set is applied independently. */
  app.post("/v1/inbound/:orgId/:key/edi", async (req, reply) => {
    const profile = inboundProfile(req);
    const raw = typeof req.body === "string" ? req.body : "";
    const result = ctx.engine.parseEdi(raw, (profile.edi?.codeOverrides ?? {}) as never);
    const applied = await applyEdi(ctx, raw, result, () => profile, "HTTPS");
    for (const err of result.errors) recordInbound(ctx, profile, "LOAD_TENDER", "EDI_X12", "HTTPS", raw, "REJECTED", `set ${err.setControl} (${err.setId}): ${err.message}`);
    reply.header("x-lp-results", JSON.stringify(applied).slice(0, 2000));
    if (result.ack997) {
      reply.type("application/edi-x12");
      return result.ack997;
    }
    return { applied, acks: result.acks };
  });

  /** JSON or XML in (by content type), shaped by the partner's field map for that transaction. */
  app.post("/v1/inbound/:orgId/:key/:transaction", async (req, reply) => {
    const profile = inboundProfile(req);
    const tx = parse(TransactionType, (req.params as { transaction: string }).transaction.toUpperCase());
    const ct = String(req.headers["content-type"] ?? "");
    const method: "API_JSON" | "API_XML" = ct.includes("xml") ? "API_XML" : "API_JSON";
    const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    let doc: unknown;
    try {
      doc = ctx.engine.parseApi(tx, method, raw, profile.channels[tx]);
    } catch (e) {
      recordInbound(ctx, profile, tx, method, "HTTPS", raw, "REJECTED", (e as Error).message);
      throw new HttpError(422, "INVALID_DOCUMENT", (e as Error).message);
    }
    const r = await ctx.hub.applyInbound(profile.ownerOrgId, profile.key, tx, doc, "API");
    recordInbound(ctx, profile, tx, method, "HTTPS", raw, "RECEIVED", undefined, r.loadId ? { loadId: r.loadId } : {});
    reply.code(202);
    return r;
  });
}
