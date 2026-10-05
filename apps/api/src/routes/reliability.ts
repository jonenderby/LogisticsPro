import { DRIVER_BUSINESS_WINDOW, ExceptionType, type LoadException, carrierWindows, loadParties, newId, reliabilityByBusiness } from "@logisticspro/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, capsOf, getLoad, hasOrgCap, isDriverOn, me, parse, postMessage } from "../http.js";
import { carrierProfile, driverProfile, recordOutcome } from "../services/reliability.js";
import { driverCount } from "../store.js";

/**
 * Reliability profiles: on-time pickup, on-time delivery and damage-free rates.
 *
 * Truckers: last 1,000 shipments overall and the last 100 per business.
 * Carriers: the same depth per truck, so 100 x truckers per business and
 * 1,000 x truckers overall. A carrier with ten truckers is judged on its last
 * 1,000 shipments for one business and its last 10,000 overall.
 */
export function reliabilityRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };
  const name = (orgId: string) => ctx.store.orgs.get(orgId)?.name ?? orgId;
  const withNames = <T extends { businessOrgId: string }>(rows: T[]) => rows.slice(0, 20).map((r) => ({ ...r, businessName: name(r.businessOrgId) }));

  /** Report over/short/damage after pickup. Damage counts against the carrier and its drivers. */
  app.post("/v1/loads/:id/exceptions", auth, async (req, reply) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    const shipperSide = hasOrgCap(ctx, account.id, load.shipperOrgId, "SHIP") || hasOrgCap(ctx, account.id, load.brokerOrgId, "BROKER");
    if (!shipperSide && !isDriverOn(load, account.id) && !hasOrgCap(ctx, account.id, load.carrierOrgId, "DISPATCH")) {
      throw new HttpError(403, "FORBIDDEN", "Only parties to this load can report exceptions");
    }
    if (!load.pickedUpAt) throw new HttpError(409, "NOT_PICKED_UP", "Exceptions are reported after pickup");
    const body = parse(z.object({ type: ExceptionType, note: z.string().trim().min(1).max(1000), pieces: z.number().int().positive().optional() }), req.body);
    const orgId = ctx.store.membershipsOf(account.id).find((m) => loadParties(load).includes(m.orgId))?.orgId;
    const ex: LoadException = { id: newId("exc"), loadId: load.id, ...body, reportedByAccountId: account.id, reportedByOrgId: orgId, at: ctx.now().toISOString() };
    ctx.store.exceptions.set(load.id, [...(ctx.store.exceptions.get(load.id) ?? []), ex]);
    recordOutcome(ctx.store, load);
    postMessage(ctx, load, { senderAccountId: account.id, senderOrgId: orgId, kind: "SYSTEM", body: `${body.type.toLowerCase()} reported${body.pieces ? ` (${body.pieces} pieces)` : ""}: ${body.note}` });
    reply.code(201);
    return ex;
  });

  app.get("/v1/loads/:id/exceptions", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    return ctx.store.exceptions.get(load.id) ?? [];
  });

  app.get("/v1/reliability/drivers/:accountId", auth, async (req) => {
    const account = me(ctx, req);
    const { accountId } = req.params as { accountId: string };
    const { businessOrgId } = req.query as { businessOrgId?: string };
    const driver = ctx.store.accounts.get(accountId);
    if (!driver) throw new HttpError(404, "NOT_FOUND", "Driver not found");
    const theirCarriers = ctx.store.memberships.filter((m) => m.accountId === accountId && m.roles.includes("DRIVER")).map((m) => m.orgId);
    const allowed = account.id === accountId || theirCarriers.some((c) => hasOrgCap(ctx, account.id, c, "DISPATCH") || hasOrgCap(ctx, account.id, c, "MANAGE_ORG"));
    if (!allowed) throw new HttpError(403, "FORBIDDEN", "Only the driver and their carriers can see this profile");
    const outcomes = [...ctx.store.outcomes.values()].filter((o) => o.driverIds.includes(accountId));
    const pick = { pickup: (o: (typeof outcomes)[number]) => o.pickupDriverIds.includes(accountId), delivery: (o: (typeof outcomes)[number]) => o.deliveryDriverIds.includes(accountId) };
    return {
      accountId,
      name: driver.name,
      windows: { overall: 1000, perBusiness: DRIVER_BUSINESS_WINDOW },
      ...driverProfile(ctx.store, accountId, businessOrgId),
      byBusiness: withNames(reliabilityByBusiness(outcomes, DRIVER_BUSINESS_WINDOW, pick)),
    };
  });

  /**
   * Carrier members see everything. A shipper or broker sees the carrier's
   * overall score and its score with *their own* business only.
   */
  app.get("/v1/reliability/carriers/:orgId", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    const { businessOrgId } = req.query as { businessOrgId?: string };
    const carrier = ctx.store.orgs.get(orgId);
    if (!carrier?.kinds.includes("CARRIER")) throw new HttpError(404, "NOT_FOUND", "Carrier not found");
    const member = ctx.store.memberships.some((m) => m.accountId === account.id && m.orgId === orgId);
    if (member) {
      const outcomes = [...ctx.store.outcomes.values()].filter((o) => o.carrierOrgId === orgId);
      const w = carrierWindows(driverCount(ctx.store, orgId));
      return { carrierOrgId: orgId, name: carrier.name, ...carrierProfile(ctx.store, orgId, businessOrgId), byBusiness: withNames(reliabilityByBusiness(outcomes, w.perBusiness)) };
    }
    const caps = capsOf(ctx, account.id);
    const myBusinesses = [...caps.byOrg].filter(([, s]) => s.has("SHIP") || s.has("BROKER")).map(([id]) => id);
    if (!myBusinesses.length) throw new HttpError(403, "FORBIDDEN", "Shippers, brokers and the carrier's own team can see carrier reliability");
    const biz = businessOrgId ?? myBusinesses[0]!;
    if (!myBusinesses.includes(biz)) throw new HttpError(403, "FORBIDDEN", "You can only see a carrier's record with your own business");
    return { carrierOrgId: orgId, name: carrier.name, ...carrierProfile(ctx.store, orgId, biz) };
  });
}
