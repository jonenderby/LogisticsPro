import { FuelPurchase, Quarter, iftaCsv, iftaReport, newId, quarterOf } from "@logisticspro/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, hasOrgCap, me, parse } from "../http.js";
import { vehicleOf } from "../services/ifta.js";
import { isIftaMember, jurisdictionInfo, jurisdictionName } from "../services/jurisdictions.js";

/**
 * Fuel tax (IFTA): miles by state and province come from the trucks'
 * location trails; fuel purchases are entered by drivers or the office. The
 * quarterly report gives miles, taxable gallons, tax-paid gallons and the net
 * per jurisdiction, ready to file.
 */
export function iftaRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };
  const member = (accountId: string, orgId: string) => ctx.store.memberships.find((m) => m.accountId === accountId && m.orgId === orgId);
  const office = (accountId: string, orgId: string) => hasOrgCap(ctx, accountId, orgId, "MANAGE_ORG") || !!member(accountId, orgId)?.roles.includes("BILLING");
  const carrier = (orgId: string) => {
    const org = ctx.store.orgs.get(orgId);
    if (!org?.kinds.includes("CARRIER")) throw new HttpError(404, "NOT_FOUND", "Carrier not found");
    return org;
  };
  const currentQuarter = () => quarterOf(ctx.now().toISOString().slice(0, 10));

  app.post("/v1/orgs/:orgId/fuel-purchases", auth, async (req, reply) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    carrier(orgId);
    if (!member(account.id, orgId)) throw new HttpError(403, "FORBIDDEN", "Not your company");
    const body = parse(FuelPurchase.pick({ date: true, jurisdiction: true, gallons: true, amount: true, vendor: true }).extend({ vehicle: z.string().max(40).optional() }), req.body);
    if (!jurisdictionName(body.jurisdiction)) throw new HttpError(400, "INVALID_REQUEST", "Unknown state or province");
    if (body.date > ctx.now().toISOString().slice(0, 10)) throw new HttpError(400, "INVALID_REQUEST", "Purchase date is in the future");
    const v = body.vehicle ? { vehicle: `unit:${body.vehicle}` } : vehicleOf(ctx, account.id);
    const p: FuelPurchase = { id: newId("fuel"), carrierOrgId: orgId, vehicle: v.vehicle, date: body.date, jurisdiction: body.jurisdiction, gallons: body.gallons, amount: body.amount, vendor: body.vendor, enteredByAccountId: account.id, createdAt: ctx.now().toISOString() };
    ctx.store.fuelPurchases.set(p.id, p);
    reply.code(201);
    return p;
  });

  app.get("/v1/orgs/:orgId/fuel-purchases", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    carrier(orgId);
    if (!member(account.id, orgId)) throw new HttpError(403, "FORBIDDEN", "Not your company");
    const quarter = parse(Quarter.optional(), (req.query as { quarter?: string }).quarter) ?? currentQuarter();
    const all = [...ctx.store.fuelPurchases.values()].filter((p) => p.carrierOrgId === orgId && quarterOf(p.date) === quarter);
    // Drivers see their own entries; the office sees everyone's.
    return (office(account.id, orgId) ? all : all.filter((p) => p.enteredByAccountId === account.id)).sort((a, b) => b.date.localeCompare(a.date));
  });

  app.get("/v1/orgs/:orgId/ifta", auth, async (req, reply) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    const org = carrier(orgId);
    if (!office(account.id, orgId)) throw new HttpError(403, "FORBIDDEN", "Fuel tax reports are for the owner, admins and billing");
    const q = req.query as { quarter?: string; format?: string };
    const quarter = parse(Quarter.optional(), q.quarter) ?? currentQuarter();
    const days = [...ctx.store.jurisdictionMiles.values()].filter((d) => d.carrierOrgId === orgId);
    const purchases = [...ctx.store.fuelPurchases.values()].filter((p) => p.carrierOrgId === orgId);
    const report = iftaReport(quarter, days, purchases, (code) => {
      const j = jurisdictionInfo(code);
      return { name: j?.name, member: !!j && isIftaMember(j) };
    });
    if (q.format === "csv") {
      reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="ifta-${org.name.replace(/\W+/g, "-")}-${quarter}.csv"`);
      return iftaCsv(report);
    }
    return report;
  });
}
