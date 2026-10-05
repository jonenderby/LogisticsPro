import { toPublicAccount } from "@logisticspro/domain";
import { buildFeed, buildWorkspace } from "@logisticspro/workspace";
import type { FastifyInstance } from "fastify";
import { type AppContext, authenticate, canSeeLoad, capsOf, me } from "../http.js";

/**
 * Everything the app needs to draw its home screen: who you are, what you
 * can do, the tab layout built from those capabilities, and one action feed
 * across every role you hold.
 */
export function meRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/me", { preHandler: authenticate(ctx) }, async (req) => {
    const account = me(ctx, req);
    const caps = capsOf(ctx, account.id);
    const loads = [...ctx.store.loads.values()].filter((l) => l.status !== "POSTED" && canSeeLoad(ctx, account.id, l));
    const boardLoads = caps.all.has("BID") ? [...ctx.store.loads.values()].filter((l) => l.status === "POSTED") : [];
    const myOrgIds = new Set(ctx.store.membershipsOf(account.id).map((m) => m.orgId));
    const bids = [...ctx.store.bids.values()].filter((b) => myOrgIds.has(b.carrierOrgId) || loads.some((l) => l.id === b.loadId));
    const invoices = [...ctx.store.invoices.values()].filter((i) => myOrgIds.has(i.carrierOrgId) || (i.billTo.orgId && myOrgIds.has(i.billTo.orgId)) || loads.some((l) => l.id === i.loadId));
    const unreadByLoad: Record<string, number> = {};
    for (const l of loads) {
      const lastRead = ctx.store.reads.get(`${account.id}:load:${l.id}`) ?? "";
      const n = ctx.store.messages.filter((m) => m.loadId === l.id && m.senderAccountId !== account.id && m.createdAt > lastRead).length;
      if (n) unreadByLoad[l.id] = n;
    }
    return {
      account: toPublicAccount(account),
      orgs: ctx.store.orgsOf(account.id).map((o) => ({ ...o, roles: ctx.store.membershipsOf(account.id).find((m) => m.orgId === o.id)!.roles })),
      capabilities: [...caps.all].sort(),
      ownerOperator: caps.ownerOperator,
      workspace: buildWorkspace(caps),
      feed: buildFeed(caps, { accountId: account.id, loads, boardLoads, bids, invoices, unreadByLoad, now: ctx.now().toISOString() }),
    };
  });
}
