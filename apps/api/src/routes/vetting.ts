import { VettingPolicy } from "@logisticspro/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, canShip, capsOf, getLoad, hasOrgCap, me, parse, requireOrgCap } from "../http.js";
import { approvalKey, pickupCheck, vettingFor } from "../services/vetting.js";

/**
 * Carrier vetting for shippers and brokers: FMCSA facts, the checks, and a
 * sign-off for carriers that need a person to look.
 */
export function vettingRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };
  const shipping = (accountId: string, orgId: string) => hasOrgCap(ctx, accountId, orgId, "SHIP") || hasOrgCap(ctx, accountId, orgId, "BROKER");

  /** Which shipper or broker is asking: the one named, or the person's first. */
  const payerFor = (accountId: string, payerOrgId?: string) => {
    if (payerOrgId) {
      if (!shipping(accountId, payerOrgId)) throw new HttpError(403, "FORBIDDEN", "Not your company");
      return payerOrgId;
    }
    return [...capsOf(ctx, accountId).byOrg].find(([, s]) => s.has("SHIP") || s.has("BROKER"))?.[0];
  };

  const report = async (accountId: string, carrierOrgId: string, payerOrgId?: string, force = false) => {
    const carrier = ctx.store.orgs.get(carrierOrgId);
    if (!carrier?.kinds.includes("CARRIER")) throw new HttpError(404, "NOT_FOUND", "Carrier not found");
    const own = ctx.store.memberships.some((m) => m.accountId === accountId && m.orgId === carrierOrgId);
    const payer = payerFor(accountId, payerOrgId);
    if (!own && !payer) throw new HttpError(403, "FORBIDDEN", "Carrier checks are for shippers, brokers and the carrier itself");
    const v = await vettingFor(ctx, carrierOrgId, own ? undefined : payer, force);
    const dot = carrier.dotNumber?.replace(/\D/g, "");
    const approval = payer ? ctx.store.carrierApprovals.get(approvalKey(payer, carrierOrgId)) : undefined;
    return {
      carrier: { id: carrier.id, name: carrier.name, dotNumber: carrier.dotNumber, mcNumber: carrier.mcNumber, scac: carrier.scac },
      payerOrgId: own ? undefined : payer,
      ...v,
      changes: dot ? (ctx.store.fmcsa.get(dot)?.history ?? []).map((h) => ({ replacedAt: h.fetchedAt, phone: h.phone, email: h.email, legalName: h.legalName, address: h.address })) : [],
      approval: approval ? { ...approval, approvedByName: ctx.store.accounts.get(approval.approvedByAccountId)?.name } : undefined,
    };
  };

  app.get("/v1/carriers/:orgId/vetting", auth, async (req) => {
    const account = me(ctx, req);
    return report(account.id, (req.params as { orgId: string }).orgId, (req.query as { payerOrgId?: string }).payerOrgId);
  });

  app.post("/v1/carriers/:orgId/vetting/refresh", auth, async (req) => {
    const account = me(ctx, req);
    return report(account.id, (req.params as { orgId: string }).orgId, (req.query as { payerOrgId?: string }).payerOrgId, true);
  });

  /** Someone at the shipper or broker looked at a carrier needing review and is satisfied. A failing carrier can't be approved. */
  app.post("/v1/orgs/:orgId/carrier-approvals", auth, async (req, reply) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    if (!shipping(account.id, orgId)) throw new HttpError(403, "FORBIDDEN", "Not your company");
    const body = parse(z.object({ carrierOrgId: z.string(), note: z.string().trim().min(3).max(500) }), req.body);
    const v = await vettingFor(ctx, body.carrierOrgId, orgId);
    if (v.verdict === "FAIL") throw new HttpError(409, "CARRIER_NOT_ELIGIBLE", "A carrier that fails its check can't be approved");
    const approval = { payerOrgId: orgId, carrierOrgId: body.carrierOrgId, approvedByAccountId: account.id, at: ctx.now().toISOString(), note: body.note };
    ctx.store.carrierApprovals.set(approvalKey(orgId, body.carrierOrgId), approval);
    reply.code(201);
    return approval;
  });

  app.post("/v1/orgs/:orgId/carrier-approvals/:carrierOrgId/remove", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId, carrierOrgId } = req.params as { orgId: string; carrierOrgId: string };
    if (!shipping(account.id, orgId)) throw new HttpError(403, "FORBIDDEN", "Not your company");
    ctx.store.carrierApprovals.delete(approvalKey(orgId, carrierOrgId));
    return { ok: true };
  });

  app.put("/v1/orgs/:orgId/vetting-policy", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "MANAGE_ORG");
    const org = ctx.store.orgs.get(orgId)!;
    if (!org.kinds.some((k) => k === "SHIPPER" || k === "BROKER_3PL")) throw new HttpError(400, "INVALID_REQUEST", "Vetting rules are for shippers and brokers");
    const policy = parse(VettingPolicy, req.body);
    ctx.store.orgs.set(orgId, { ...org, vetting: policy });
    return policy;
  });

  /** For the shipping side of a load: its carrier's check, and whether the pickup was made by the carrier's own driver. */
  app.get("/v1/loads/:id/carrier-check", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    if (!canShip(ctx, account.id, load)) throw new HttpError(403, "FORBIDDEN", "Carrier checks are for the shipper or broker");
    if (!load.carrierOrgId) return { carrier: undefined, pickup: undefined };
    const payer = load.brokerOrgId ?? load.shipperOrgId;
    const v = await vettingFor(ctx, load.carrierOrgId, payer);
    return { carrier: { id: load.carrierOrgId, name: ctx.store.orgs.get(load.carrierOrgId)?.name, verdict: v.verdict, approved: !!ctx.store.carrierApprovals.get(approvalKey(payer, load.carrierOrgId)) }, pickup: pickupCheck(ctx, load) };
  });
}
