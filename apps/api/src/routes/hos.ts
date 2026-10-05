import { DutyStatus, HosCycle } from "@logisticspro/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, capsOf, me, parse } from "../http.js";
import { hosFor, setDutyStatus } from "../services/hos.js";

/**
 * A driver's hours of service: legal driving time left by each limit, miles
 * driven this shift, and about how many more miles that time allows.
 *
 * This is an estimate from the driver's duty status and phone location. It
 * is not an ELD; a registered ELD's record is the legal one.
 */
export function hosRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };
  const driver = (accountId: string) => {
    if (!capsOf(ctx, accountId).all.has("DRIVE")) throw new HttpError(403, "FORBIDDEN", "Hours of service are for drivers");
  };

  app.get("/v1/me/hos", auth, async (req) => {
    const account = me(ctx, req);
    driver(account.id);
    const now = ctx.now();
    const since = new Date(now.getTime() - 8 * 86_400_000).toISOString();
    const log = ctx.store.dutyLogs.get(account.id) ?? [];
    return { ...hosFor(ctx.store, account.id, now), log: log.filter((e) => e.at >= since).reverse() };
  });

  /** The driver changes duty status now. The log is not edited after the fact. */
  app.post("/v1/me/duty-status", auth, async (req) => {
    const account = me(ctx, req);
    driver(account.id);
    const body = parse(z.object({ status: DutyStatus, note: z.string().trim().max(200).optional() }), req.body);
    const now = ctx.now();
    const eld = ctx.store.eldDrivers.get(account.id);
    if (eld) throw new HttpError(409, "ON_ELD", `Your hours are kept by your ${eld.provider[0]}${eld.provider.slice(1).toLowerCase()} ELD. Change your duty status there.`);
    setDutyStatus(ctx.store, account.id, { status: body.status, at: now.toISOString(), source: "DRIVER", note: body.note || undefined }, now);
    return hosFor(ctx.store, account.id, now);
  });

  /** 70 hours in 8 days (default) or 60 in 7, as the carrier operates. */
  app.put("/v1/me/hos-settings", auth, async (req) => {
    const account = me(ctx, req);
    driver(account.id);
    const { cycle } = parse(z.object({ cycle: HosCycle }), req.body);
    ctx.store.hosSettings.set(account.id, { cycle });
    return hosFor(ctx.store, account.id, ctx.now());
  });
}
