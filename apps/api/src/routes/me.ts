import { toPublicAccount } from "@logisticspro/domain";
import { hosFor } from "../services/hos.js";
import { buildFeed, buildWorkspace } from "@logisticspro/workspace";
import type { FastifyInstance } from "fastify";
import { type AppContext, authenticate, canSeeLoad, capsOf, me } from "../http.js";
import { UNDELIVERED, etaFor } from "../services/tracking.js";

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
    const managed = new Set([...caps.byOrg].filter(([, s]) => s.has("DISPATCH") || s.has("MANAGE_ORG")).map(([id]) => id));
    const joinRequests = [...ctx.store.joinRequests.values()]
      .filter((r) => r.status === "PENDING" && managed.has(r.carrierOrgId))
      .map((r) => ({ id: r.id, carrierOrgId: r.carrierOrgId, carrierName: ctx.store.orgs.get(r.carrierOrgId)?.name, accountName: ctx.store.accounts.get(r.accountId)?.name ?? "A driver" }));
    // Late and at-risk shipments surface on Today for shippers, brokers and dispatch.
    const watched = new Set([...caps.byOrg].filter(([, s]) => s.has("SHIP") || s.has("BROKER") || s.has("DISPATCH")).map(([id]) => id));
    const arrivalAlerts = loads
      .filter((l) => UNDELIVERED.includes(l.status) && [l.shipperOrgId, l.brokerOrgId, l.carrierOrgId].some((o) => o && watched.has(o)))
      .map((l) => ({ load: l, eta: etaFor(ctx.store, l, ctx.now()) }))
      .filter((x) => x.eta.status === "LATE" || x.eta.status === "AT_RISK")
      .map((x) => ({ loadId: x.load.id, loadNumber: x.load.loadNumber, status: x.eta.status as "LATE" | "AT_RISK", eta: x.eta.eta, reason: x.eta.reasons[0] }));
    return {
      account: toPublicAccount(account),
      orgs: ctx.store.orgsOf(account.id).map((o) => ({ ...o, roles: ctx.store.membershipsOf(account.id).find((m) => m.orgId === o.id)!.roles })),
      capabilities: [...caps.all].sort(),
      ownerOperator: caps.ownerOperator,
      workspace: buildWorkspace(caps),
      feed: buildFeed(caps, { accountId: account.id, loads, boardLoads, bids, invoices, unreadByLoad, joinRequests, arrivalAlerts, now: ctx.now().toISOString() }),
      hos: caps.all.has("DRIVE") ? hosFor(ctx.store, account.id, ctx.now()) : undefined,
    };
  });
}
