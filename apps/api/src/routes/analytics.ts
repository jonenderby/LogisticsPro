import { shipperAnalytics } from "@logisticspro/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, hasOrgCap, me, parse } from "../http.js";

/**
 * Insights for shippers and brokers: on-time performance by carrier and
 * lane, cost per mile, and the weekly rate trend, for the last 30, 90 or
 * 365 days against the period before.
 */
export function analyticsRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };

  app.get("/v1/orgs/:orgId/analytics", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    if (!hasOrgCap(ctx, account.id, orgId, "SHIP") && !hasOrgCap(ctx, account.id, orgId, "BROKER")) throw new HttpError(403, "FORBIDDEN", "Insights are for shippers and brokers");
    const { days } = parse(z.object({ days: z.coerce.number().int().refine((d) => [30, 90, 365].includes(d), "30, 90 or 365 days").default(90) }), req.query ?? {});
    const to = ctx.now();
    const from = new Date(to.getTime() - days * 86_400_000);
    return shipperAnalytics({
      orgId,
      loads: [...ctx.store.loads.values()],
      outcomes: [...ctx.store.outcomes.values()],
      from: from.toISOString(),
      to: to.toISOString(),
      carrierName: (key, load) => {
        if (load.carrierOrgId && key === load.carrierOrgId) return ctx.store.orgs.get(load.carrierOrgId)?.name ?? key;
        const owner = load.brokerOrgId ?? load.shipperOrgId;
        return (load.externalCarrierKey && ctx.store.profile(owner, load.externalCarrierKey)?.name) || load.externalCarrierKey || "Unknown carrier";
      },
    });
  });
}
