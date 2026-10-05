import { Address, GeoPoint, MemberRole, type Organization, OrgKind, newId, toPublicAccount } from "@logisticspro/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withGeo } from "../services/geocode.js";
import { driverProfile } from "../services/reliability.js";
import { type AppContext, HttpError, authenticate, me, parse, requireOrgCap } from "../http.js";

const RegisterOrg = z.object({
  name: z.string().min(1).max(120),
  kinds: z.array(OrgKind).min(1),
  scac: z.string().regex(/^[A-Z]{2,4}$/).optional(),
  mcNumber: z.string().max(20).optional(),
  dotNumber: z.string().max(20).optional(),
  address: Address.optional(),
});

export function orgRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };

  /** Register a company. A trucker who registers a carrier becomes its owner-operator. */
  app.post("/v1/orgs", auth, async (req, reply) => {
    const account = me(ctx, req);
    const body = parse(RegisterOrg, req.body);
    if (body.scac && [...ctx.store.orgs.values()].some((o) => o.scac === body.scac)) throw new HttpError(409, "SCAC_TAKEN", "Another company already registered this SCAC");
    const org: Organization = { id: newId("org"), ...body, distributionCenters: [], createdAt: ctx.now().toISOString() };
    ctx.store.orgs.set(org.id, org);
    const roles: MemberRole[] = ["OWNER"];
    if (account.driver && org.kinds.includes("CARRIER")) roles.push("DRIVER");
    ctx.store.memberships.push({ accountId: account.id, orgId: org.id, roles });
    if (account.driver && org.kinds.includes("CARRIER") && !account.driver.homeCarrierOrgId) {
      ctx.store.accounts.set(account.id, { ...account, driver: { ...account.driver, homeCarrierOrgId: org.id } });
    }
    reply.code(201);
    return { org, roles };
  });

  app.get("/v1/orgs/:orgId", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    if (!ctx.store.membershipsOf(account.id).some((m) => m.orgId === orgId)) throw new HttpError(404, "NOT_FOUND", "Organization not found");
    const org = ctx.store.orgs.get(orgId)!;
    const members = ctx.store.memberships
      .filter((m) => m.orgId === orgId)
      .map((m) => ({ roles: m.roles, account: toPublicAccount(ctx.store.accounts.get(m.accountId)!) }));
    return { org, members };
  });

  app.patch("/v1/orgs/:orgId", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "MANAGE_ORG");
    const body = parse(RegisterOrg.partial(), req.body);
    const org = { ...ctx.store.orgs.get(orgId)!, ...body };
    ctx.store.orgs.set(orgId, org);
    return { org };
  });

  /** Add an existing account (by email) to the company, e.g. a driver or dispatcher. */
  app.post("/v1/orgs/:orgId/members", auth, async (req, reply) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "MANAGE_ORG");
    const body = parse(z.object({ email: z.string().email(), roles: z.array(MemberRole).min(1) }), req.body);
    if (body.roles.includes("OWNER")) throw new HttpError(400, "INVALID_REQUEST", "Ownership cannot be granted by invitation");
    const member = ctx.store.accountByEmail(body.email);
    if (!member) throw new HttpError(404, "NOT_FOUND", "No account with that email; ask them to sign up first");
    const existing = ctx.store.memberships.find((m) => m.accountId === member.id && m.orgId === orgId);
    if (existing) existing.roles = [...new Set([...existing.roles, ...body.roles])];
    else ctx.store.memberships.push({ accountId: member.id, orgId, roles: body.roles });
    if (body.roles.includes("DRIVER") && !member.driver) {
      ctx.store.accounts.set(member.id, { ...member, driver: { endorsements: [], twicCard: false, homeCarrierOrgId: orgId } });
    }
    reply.code(201);
    return { accountId: member.id, roles: ctx.store.memberships.find((m) => m.accountId === member.id && m.orgId === orgId)!.roles };
  });

  app.get("/v1/orgs/:orgId/drivers", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "DISPATCH");
    // With ?businessOrgId=, include each driver's record with that customer to help pick who runs the load.
    const { businessOrgId } = req.query as { businessOrgId?: string };
    return ctx.store.memberships
      .filter((m) => m.orgId === orgId && m.roles.includes("DRIVER"))
      .map((m) => ({ ...toPublicAccount(ctx.store.accounts.get(m.accountId)!), reliability: driverProfile(ctx.store, m.accountId, businessOrgId) }));
  });

  app.post("/v1/orgs/:orgId/distribution-centers", auth, async (req, reply) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "MANAGE_FLEET");
    const body = parse(z.object({ name: z.string().min(1), address: Address, geo: GeoPoint.optional(), serviceZip3: z.array(z.string().length(3)).default([]) }), req.body);
    const located = body.geo ? { address: body.address } : await withGeo(ctx, body.address, "Distribution center");
    const geo = body.geo ?? located.address.geo;
    if (!geo) throw new HttpError(422, "NO_GEO", located.warning ?? "Could not place this address on the map");
    const org = ctx.store.orgs.get(orgId)!;
    const dc = { id: newId("dc"), ...body, address: { ...located.address, geo }, geo };
    ctx.store.orgs.set(orgId, { ...org, distributionCenters: [...org.distributionCenters, dc] });
    reply.code(201);
    return dc;
  });
}
