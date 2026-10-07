import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, hasOrgCap, me, parse, requireOrgCap } from "../http.js";
import type { EldConnection } from "../store.js";
import { connectEld, disconnectEld, linkEldDriver, syncEld } from "../services/eld.js";

const Connect = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("MOTIVE"), apiKey: z.string().trim().min(8).max(200) }),
  z.object({ provider: z.literal("SAMSARA"), apiKey: z.string().trim().min(8).max(400) }),
  z.object({ provider: z.literal("GEOTAB"), server: z.string().trim().min(3).max(200).default("my.geotab.com"), database: z.string().trim().min(1).max(100), userName: z.string().trim().min(1).max(200), password: z.string().min(1).max(200) }),
]);

/** A carrier's ELD account: connect, match drivers, sync now, disconnect. Credentials never come back out. */
export function eldRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };
  const carrier = (orgId: string) => {
    if (!ctx.store.orgs.get(orgId)?.kinds.includes("CARRIER")) throw new HttpError(404, "NOT_FOUND", "Carrier not found");
  };
  const canView = (accountId: string, orgId: string) => {
    if (!hasOrgCap(ctx, accountId, orgId, "MANAGE_ORG") && !hasOrgCap(ctx, accountId, orgId, "DISPATCH")) throw new HttpError(403, "FORBIDDEN", "ELD settings are for the owner, admins and dispatch");
  };
  const view = (orgId: string, conn?: EldConnection) => {
    const drivers = ctx.store.memberships
      .filter((m) => m.orgId === orgId && m.roles.includes("DRIVER"))
      .map((m) => ({ accountId: m.accountId, name: ctx.store.accounts.get(m.accountId)?.name ?? m.accountId }));
    if (!conn) return { connected: false, members: drivers };
    const { sealedCredentials: _secret, ...rest } = conn;
    return {
      connected: true,
      ...rest,
      drivers: conn.drivers.map((d) => {
        const link = d.accountId ? ctx.store.eldDrivers.get(d.accountId) : undefined;
        return { externalId: d.externalId, name: d.name, email: d.email, accountId: d.accountId, accountName: d.accountId ? ctx.store.accounts.get(d.accountId)?.name : undefined, match: d.match, clock: link?.clock, syncedAt: link?.syncedAt };
      }),
      members: drivers,
    };
  };

  app.get("/v1/orgs/:orgId/eld", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    carrier(orgId);
    canView(account.id, orgId);
    return view(orgId, ctx.store.eldConnections.get(orgId));
  });

  app.put("/v1/orgs/:orgId/eld", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    carrier(orgId);
    requireOrgCap(ctx, account.id, orgId, "MANAGE_ORG");
    const body = parse(Connect, req.body);
    const creds = body.provider === "GEOTAB" ? { server: body.server, database: body.database, userName: body.userName, password: body.password } : { apiKey: body.apiKey };
    await connectEld(ctx, orgId, account.id, body.provider, creds);
    await syncEld(ctx, orgId);
    return view(orgId, ctx.store.eldConnections.get(orgId));
  });

  app.put("/v1/orgs/:orgId/eld/drivers/:externalId", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId, externalId } = req.params as { orgId: string; externalId: string };
    carrier(orgId);
    canView(account.id, orgId);
    const { accountId } = parse(z.object({ accountId: z.string().nullable() }), req.body);
    return view(orgId, linkEldDriver(ctx, orgId, externalId, accountId));
  });

  app.post("/v1/orgs/:orgId/eld/sync", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    carrier(orgId);
    canView(account.id, orgId);
    const result = await syncEld(ctx, orgId);
    return { ...result, ...view(orgId, ctx.store.eldConnections.get(orgId)) };
  });

  app.post("/v1/orgs/:orgId/eld/remove", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    carrier(orgId);
    requireOrgCap(ctx, account.id, orgId, "MANAGE_ORG");
    disconnectEld(ctx, orgId);
    return view(orgId);
  });
}
