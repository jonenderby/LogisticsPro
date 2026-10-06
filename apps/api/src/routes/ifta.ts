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
  const drivesFor = (accountId: string, orgId: string) => !!member(accountId, orgId)?.roles.includes("DRIVER");
  const driverTruck = (accountId: string) => ({ vehicle: `driver:${accountId}`, label: `${ctx.store.accounts.get(accountId)?.name ?? "Driver"}'s truck` });

  /**
   * The truck a fill-up went into: a unit number, a driver's own truck, or,
   * when left out, the truck the person entering it is driving.
   */
  const truckFor = (accountId: string, orgId: string, vehicle?: string): { vehicle: string; label: string } => {
    if (!vehicle) {
      if (!drivesFor(accountId, orgId)) throw new HttpError(400, "INVALID_REQUEST", "Choose the truck this fuel went into");
      const v = vehicleOf(ctx, accountId);
      return { vehicle: v.vehicle, label: v.label };
    }
    if (vehicle.startsWith("driver:")) {
      const id = vehicle.slice("driver:".length);
      if (id !== accountId && !office(accountId, orgId)) throw new HttpError(403, "FORBIDDEN", "Only the office enters fuel for another driver");
      if (!drivesFor(id, orgId)) throw new HttpError(400, "INVALID_REQUEST", "Not one of this company's drivers");
      return driverTruck(id);
    }
    const unit = vehicle.replace(/^unit:/, "").trim();
    if (!/^[\w-]{1,20}$/.test(unit)) throw new HttpError(400, "INVALID_REQUEST", "Unit numbers are letters, digits and dashes");
    return { vehicle: `unit:${unit}`, label: `Unit ${unit}` };
  };
  const currentQuarter = () => quarterOf(ctx.now().toISOString().slice(0, 10));

  app.post("/v1/orgs/:orgId/fuel-purchases", auth, async (req, reply) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    carrier(orgId);
    if (!member(account.id, orgId)) throw new HttpError(403, "FORBIDDEN", "Not your company");
    const body = parse(FuelPurchase.pick({ date: true, jurisdiction: true, gallons: true, amount: true, vendor: true }).extend({ vehicle: z.string().max(80).optional() }), req.body);
    if (!jurisdictionName(body.jurisdiction)) throw new HttpError(400, "INVALID_REQUEST", "Unknown state or province");
    if (body.date > ctx.now().toISOString().slice(0, 10)) throw new HttpError(400, "INVALID_REQUEST", "Purchase date is in the future");
    const v = truckFor(account.id, orgId, body.vehicle);
    const p: FuelPurchase = { id: newId("fuel"), carrierOrgId: orgId, vehicle: v.vehicle, vehicleLabel: v.label, date: body.date, jurisdiction: body.jurisdiction, gallons: body.gallons, amount: body.amount, vendor: body.vendor, enteredByAccountId: account.id, createdAt: ctx.now().toISOString() };
    ctx.store.fuelPurchases.set(p.id, p);
    reply.code(201);
    return p;
  });

  /** Trucks the office can log fuel against: units seen on the carrier's legs and trails, and each driver's own truck. */
  app.get("/v1/orgs/:orgId/fuel-vehicles", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    carrier(orgId);
    if (!office(account.id, orgId)) throw new HttpError(403, "FORBIDDEN", "Only the office enters fuel for other trucks");
    const out = new Map<string, string>();
    for (const l of ctx.store.loadsOfParty(orgId)) if (l.carrierOrgId === orgId) for (const leg of l.legs) if (leg.tractorId) out.set(`unit:${leg.tractorId}`, `Unit ${leg.tractorId}`);
    for (const d of ctx.store.jurisdictionMiles.values()) if (d.carrierOrgId === orgId) out.set(d.vehicle, d.vehicleLabel);
    for (const m of ctx.store.memberships) if (m.orgId === orgId && m.roles.includes("DRIVER")) {
      const t = driverTruck(m.accountId);
      out.set(t.vehicle, t.label);
    }
    return [...out].map(([vehicle, label]) => ({ vehicle, label })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
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
