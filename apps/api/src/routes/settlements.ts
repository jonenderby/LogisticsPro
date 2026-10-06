import { DriverPayRule, type Load, type SettlementStatement, newId, settlementCsv, settlementLine, settlementTotal } from "@logisticspro/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, hasOrgCap, me, parse, requireOrgCap } from "../http.js";

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Driver settlement: each driver's pay rule, statements per pay period from
 * the loads they delivered, adjustments, approval and payment. The office
 * (people with PAY) runs it; drivers see their own statements once approved.
 */
export function settlementRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };
  const carrier = (orgId: string) => {
    const org = ctx.store.orgs.get(orgId);
    if (!org?.kinds.includes("CARRIER")) throw new HttpError(404, "NOT_FOUND", "Carrier not found");
    return org;
  };
  const drivers = (orgId: string) => ctx.store.memberships.filter((m) => m.orgId === orgId && m.roles.includes("DRIVER"));
  const ruleKey = (orgId: string, accountId: string) => `${orgId}|${accountId}`;
  const find = (accountId: string, id: string, office = false): SettlementStatement => {
    const s = ctx.store.settlements.get(id);
    const isOffice = !!s && hasOrgCap(ctx, accountId, s.carrierOrgId, "PAY");
    if (!s || (!isOffice && (office || s.driverAccountId !== accountId || s.status === "DRAFT"))) throw new HttpError(404, "NOT_FOUND", "Statement not found");
    return s;
  };
  const save = (s: SettlementStatement) => {
    const next = { ...s, total: settlementTotal(s) };
    ctx.store.settlements.set(next.id, next);
    return next;
  };

  // ------------------------------------------------------------ pay rules

  app.get("/v1/orgs/:orgId/driver-pay", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "PAY");
    carrier(orgId);
    return drivers(orgId).map((m) => ({ accountId: m.accountId, name: ctx.store.accounts.get(m.accountId)?.name ?? "Driver", rule: ctx.store.driverPayRules.get(ruleKey(orgId, m.accountId)) ?? null }));
  });

  app.put("/v1/orgs/:orgId/drivers/:accountId/pay", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId, accountId } = req.params as { orgId: string; accountId: string };
    requireOrgCap(ctx, account.id, orgId, "PAY");
    carrier(orgId);
    if (!drivers(orgId).some((m) => m.accountId === accountId)) throw new HttpError(404, "NOT_FOUND", "Not one of your drivers");
    const rule = parse(DriverPayRule, req.body);
    if (rule.kind === "PERCENT" && rule.rate > 100) throw new HttpError(400, "INVALID_REQUEST", "A percentage can't be over 100");
    const stored = { ...rule, setAt: ctx.now().toISOString(), setByAccountId: account.id };
    ctx.store.driverPayRules.set(ruleKey(orgId, accountId), stored);
    return stored;
  });

  // ------------------------------------------------------------ statements

  /** Statements for every driver who delivered loads in the period and isn't paid for them yet. */
  app.post("/v1/orgs/:orgId/settlements", auth, async (req, reply) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "PAY");
    carrier(orgId);
    const { periodStart, periodEnd } = parse(z.object({ periodStart: DAY, periodEnd: DAY }), req.body);
    if (periodEnd < periodStart) throw new HttpError(400, "INVALID_REQUEST", "The period ends before it starts");
    const until = new Date(Date.parse(`${periodEnd}T00:00:00Z`) + 86_400_000).toISOString();
    const from = `${periodStart}T00:00:00.000Z`;
    const created: SettlementStatement[] = [];
    const noRule: string[] = [];
    for (const m of drivers(orgId)) {
      const loads = ctx.store
        .loadsOfParty(m.accountId)
        .filter((l: Load) => l.carrierOrgId === orgId && (l.status === "DELIVERED" || l.status === "INVOICED") && !!l.deliveredAt && l.deliveredAt >= from && l.deliveredAt < until)
        .filter((l) => !ctx.store.settlements.where("paid", `${l.id}|${m.accountId}`).length)
        .sort((a, b) => a.deliveredAt!.localeCompare(b.deliveredAt!));
      if (!loads.length) continue;
      const name = ctx.store.accounts.get(m.accountId)?.name ?? "Driver";
      const rule = ctx.store.driverPayRules.get(ruleKey(orgId, m.accountId));
      if (!rule) {
        noRule.push(name);
        continue;
      }
      const { setAt: _a, setByAccountId: _b, ...payRule } = rule;
      created.push(
        save({
          id: newId("set"),
          carrierOrgId: orgId,
          driverAccountId: m.accountId,
          driverName: name,
          periodStart,
          periodEnd,
          rule: payRule,
          lines: loads.map((l) => settlementLine(l, m.accountId, payRule)),
          adjustments: [],
          total: 0,
          status: "DRAFT",
          createdAt: ctx.now().toISOString(),
        }),
      );
    }
    reply.code(201);
    return { created, driversWithoutPayRule: noRule };
  });

  app.get("/v1/orgs/:orgId/settlements", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "PAY");
    return ctx.store.settlements.where("carrier", orgId).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || a.driverName.localeCompare(b.driverName));
  });

  /** Statements for a period as CSV, for payroll: the file itself, or `/export` as { name, content } for the app. */
  const csvFor = (req: { params: unknown; query: unknown }, accountId: string) => {
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, accountId, orgId, "PAY");
    const q = parse(z.object({ periodStart: DAY.optional(), periodEnd: DAY.optional() }), req.query ?? {});
    const list = ctx.store.settlements.where("carrier", orgId).filter((s) => (!q.periodStart || s.periodStart >= q.periodStart) && (!q.periodEnd || s.periodEnd <= q.periodEnd));
    return { name: `driver-pay-${q.periodStart ?? "all"}${q.periodEnd ? `-to-${q.periodEnd}` : ""}.csv`, content: settlementCsv(list.sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.driverName.localeCompare(b.driverName))) };
  };
  app.get("/v1/orgs/:orgId/settlements.csv", auth, async (req, reply) => {
    const file = csvFor(req, me(ctx, req).id);
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${file.name}"`);
    return file.content;
  });
  app.get("/v1/orgs/:orgId/settlements/export", auth, async (req) => csvFor(req, me(ctx, req).id));

  app.get("/v1/me/settlements", auth, async (req) => {
    const account = me(ctx, req);
    return ctx.store.settlements
      .where("driver", account.id)
      .filter((s) => s.status !== "DRAFT")
      .map((s) => ({ ...s, carrierName: ctx.store.orgs.get(s.carrierOrgId)?.name }))
      .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  });

  app.get("/v1/settlements/:id", auth, async (req) => {
    const account = me(ctx, req);
    const s = find(account.id, (req.params as { id: string }).id);
    return { ...s, carrierName: ctx.store.orgs.get(s.carrierOrgId)?.name, canManage: hasOrgCap(ctx, account.id, s.carrierOrgId, "PAY") };
  });

  const draft = (accountId: string, id: string) => {
    const s = find(accountId, id, true);
    if (s.status !== "DRAFT") throw new HttpError(409, "NOT_DRAFT", "Approved statements can't be changed");
    return s;
  };

  app.post("/v1/settlements/:id/adjustments", auth, async (req, reply) => {
    const account = me(ctx, req);
    const s = draft(account.id, (req.params as { id: string }).id);
    const body = parse(z.object({ description: z.string().trim().min(1).max(80), amount: z.number().refine((n) => n !== 0 && Math.abs(n) < 100_000, "Enter an amount") }), req.body);
    reply.code(201);
    return save({ ...s, adjustments: [...s.adjustments, { id: newId("adj"), description: body.description, amount: Math.round(body.amount * 100) / 100, byAccountId: account.id, at: ctx.now().toISOString() }] });
  });

  app.post("/v1/settlements/:id/adjustments/:adjId/remove", auth, async (req) => {
    const account = me(ctx, req);
    const { id, adjId } = req.params as { id: string; adjId: string };
    const s = draft(account.id, id);
    return save({ ...s, adjustments: s.adjustments.filter((a) => a.id !== adjId) });
  });

  /** Throw away a draft; its loads can go on another statement. */
  app.post("/v1/settlements/:id/discard", auth, async (req) => {
    const account = me(ctx, req);
    const s = draft(account.id, (req.params as { id: string }).id);
    ctx.store.settlements.delete(s.id);
    return { discarded: s.id };
  });

  app.post("/v1/settlements/:id/approve", auth, async (req) => {
    const account = me(ctx, req);
    const s = draft(account.id, (req.params as { id: string }).id);
    const next = save({ ...s, status: "APPROVED", approvedAt: ctx.now().toISOString(), approvedByAccountId: account.id });
    ctx.notifier.driverPay(s.driverAccountId, { title: `Pay statement ${s.periodStart} to ${s.periodEnd}`, body: `${ctx.store.orgs.get(s.carrierOrgId)?.name}: ${money(next.total)} for ${s.lines.length} load${s.lines.length === 1 ? "" : "s"}.`, settlementId: s.id });
    return next;
  });

  app.post("/v1/settlements/:id/paid", auth, async (req) => {
    const account = me(ctx, req);
    const s = find(account.id, (req.params as { id: string }).id, true);
    if (s.status !== "APPROVED") throw new HttpError(409, "NOT_APPROVED", s.status === "PAID" ? "Already paid" : "Approve the statement first");
    const { reference } = parse(z.object({ reference: z.string().trim().max(60).optional() }), req.body ?? {});
    const next = save({ ...s, status: "PAID", paidAt: ctx.now().toISOString(), paidReference: reference || undefined });
    ctx.notifier.driverPay(s.driverAccountId, { title: `Paid: ${money(next.total)}`, body: `${ctx.store.orgs.get(s.carrierOrgId)?.name} paid your statement for ${s.periodStart} to ${s.periodEnd}${reference ? ` (ref ${reference})` : ""}.`, settlementId: s.id });
    return next;
  });
}
