import { randomBytes } from "node:crypto";
import { type Account, MemberRole, type Organization, OrgKind, ProfileType, newId, toPublicAccount } from "@logisticspro/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, parse } from "../http.js";
import { hashPassword } from "../security/password.js";
import { isPlatformAdmin } from "../services/setup.js";

/**
 * Tools for the people who run this deployment (LP_ADMIN_EMAILS): every
 * account and company, new accounts and companies for setup, and test
 * accounts of each kind they can switch into to see the app as that user.
 * Switching is limited to test accounts, so an admin can't act as a customer.
 */

/** The company a new account starts with, by profile. */
const KINDS_FOR: Record<ProfileType, OrgKind[]> = { TRUCKER: ["CARRIER"], CARRIER: ["CARRIER"], BROKER_3PL: ["BROKER_3PL"], BUSINESS: ["SHIPPER"] };

const NewAccount = z.object({
  name: z.string().trim().min(1).max(80),
  profileType: ProfileType,
  /** Test accounts get a made-up address; real ones need the person's email. */
  test: z.boolean().default(true),
  email: z.string().email().optional(),
  /** A company this account owns, e.g. "Acme Freight". */
  company: z.object({ name: z.string().trim().min(1).max(120), kinds: z.array(OrgKind).min(1).optional(), scac: z.string().regex(/^[A-Z]{2,4}$/).optional() }).optional(),
  /** For a trucker: the carrier they drive for. */
  driverFor: z.string().optional(),
});

/** A password nobody knows, for test accounts. */
const unusablePassword = () => randomBytes(32).toString("base64url");
/** A one-time password for a real account; its owner sets up two-factor on first sign-in. */
const temporaryPassword = () => `${randomBytes(9).toString("base64url")}-Lp1`;

export function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };

  /** The admin behind the request, also while they are switched into a test account. */
  const admin = (req: FastifyRequest): Account => {
    const a = ctx.store.accounts.get(req.actorId ?? req.accountId ?? "");
    if (!a || !isPlatformAdmin(ctx, a.email)) throw new HttpError(403, "FORBIDDEN", "This is for the people who run this deployment");
    return a;
  };

  const summary = (a: Account) => ({
    ...toPublicAccount(a),
    test: !!a.testAccountOf,
    platformAdmin: isPlatformAdmin(ctx, a.email),
    orgs: ctx.store.membershipsOf(a.id).map((m) => ({ id: m.orgId, name: ctx.store.orgs.get(m.orgId)?.name ?? m.orgId, kinds: ctx.store.orgs.get(m.orgId)?.kinds ?? [], roles: m.roles })),
  });

  app.get("/v1/admin/accounts", auth, async (req) => {
    admin(req);
    return [...ctx.store.accounts.values()].sort((a, b) => Number(!!b.testAccountOf) - Number(!!a.testAccountOf) || b.createdAt.localeCompare(a.createdAt)).map(summary);
  });

  app.get("/v1/admin/orgs", auth, async (req) => {
    admin(req);
    return [...ctx.store.orgs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((o) => ({ id: o.id, name: o.name, kinds: o.kinds, scac: o.scac, createdAt: o.createdAt, members: ctx.store.memberships.filter((m) => m.orgId === o.id).length }));
  });

  /** A new account, with its company if it has one. Real accounts get a one-time password to hand over. */
  app.post("/v1/admin/accounts", auth, async (req, reply) => {
    const by = admin(req);
    const body = parse(NewAccount, req.body);
    const now = ctx.now().toISOString();
    let email: string;
    let password: string | undefined;
    if (body.test) {
      const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "") || "test";
      email = `${slug}.${randomBytes(3).toString("hex")}@test.invalid`;
    } else {
      if (!body.email) throw new HttpError(400, "INVALID_REQUEST", "Enter the person's email");
      email = body.email.trim().toLowerCase();
      password = temporaryPassword();
    }
    if (ctx.store.accountByEmail(email)) throw new HttpError(409, "EMAIL_TAKEN", "An account with this email already exists");
    const carrier = body.driverFor ? ctx.store.orgs.get(body.driverFor) : undefined;
    if (body.driverFor && !carrier?.kinds.includes("CARRIER")) throw new HttpError(404, "NOT_FOUND", "Carrier not found");
    if (body.company?.scac && [...ctx.store.orgs.values()].some((o) => o.scac === body.company!.scac)) throw new HttpError(409, "SCAC_TAKEN", "Another company already registered this SCAC");

    const account: Account = {
      id: newId("acct"),
      email,
      name: body.name,
      profileType: body.profileType,
      passwordHash: await hashPassword(password ?? unusablePassword()),
      mfa: { enabled: false, recoveryCodeHashes: [] },
      driver: body.profileType === "TRUCKER" ? { endorsements: [], twicCard: false, homeCarrierOrgId: carrier?.id } : undefined,
      ...(body.test ? { testAccountOf: by.id } : {}),
      createdAt: now,
    };
    ctx.store.accounts.set(account.id, account);

    let org: Organization | undefined;
    if (body.company) {
      org = { id: newId("org"), name: body.company.name, kinds: body.company.kinds ?? KINDS_FOR[body.profileType], scac: body.company.scac, distributionCenters: [], createdAt: now };
      ctx.store.orgs.set(org.id, org);
      const roles: MemberRole[] = ["OWNER"];
      if (account.driver && org.kinds.includes("CARRIER")) roles.push("DRIVER");
      ctx.store.memberships.push({ accountId: account.id, orgId: org.id, roles });
      // A trucker with their own company is an owner-operator, dispatched by it.
      if (account.driver && org.kinds.includes("CARRIER") && !account.driver.homeCarrierOrgId) ctx.store.accounts.set(account.id, { ...account, driver: { ...account.driver, homeCarrierOrgId: org.id } });
    }
    if (carrier) ctx.store.memberships.push({ accountId: account.id, orgId: carrier.id, roles: ["DRIVER"] });

    req.log.info({ admin: by.id, account: account.id, test: body.test }, "admin created an account");
    reply.code(201);
    return { account: summary(ctx.store.accounts.get(account.id)!), org, ...(password ? { temporaryPassword: password } : {}) };
  });

  /** Put an account in a company, e.g. a dispatcher or a driver. */
  app.post("/v1/admin/orgs/:orgId/members", auth, async (req, reply) => {
    admin(req);
    const { orgId } = req.params as { orgId: string };
    if (!ctx.store.orgs.has(orgId)) throw new HttpError(404, "NOT_FOUND", "Company not found");
    const body = parse(z.object({ accountId: z.string(), roles: z.array(MemberRole).min(1) }), req.body);
    const account = ctx.store.accounts.get(body.accountId);
    if (!account) throw new HttpError(404, "NOT_FOUND", "Account not found");
    const existing = ctx.store.memberships.find((m) => m.orgId === orgId && m.accountId === account.id);
    if (existing) {
      existing.roles = [...new Set([...existing.roles, ...body.roles])];
      ctx.store.memberships.touch(existing);
    } else ctx.store.memberships.push({ accountId: account.id, orgId, roles: body.roles });
    if (body.roles.includes("DRIVER") && !account.driver?.homeCarrierOrgId) ctx.store.accounts.set(account.id, { ...account, driver: { endorsements: [], twicCard: false, ...account.driver, homeCarrierOrgId: orgId } });
    reply.code(201);
    return summary(ctx.store.accounts.get(account.id)!);
  });

  /**
   * Switch into a test account to use the app as it. The session is short
   * (an access token only) and names the admin; the admin's own sign-in is
   * untouched, so switching back is just going back to it.
   */
  app.post("/v1/admin/switch", auth, async (req) => {
    const by = admin(req);
    const { accountId } = parse(z.object({ accountId: z.string() }), req.body);
    const target = ctx.store.accounts.get(accountId);
    if (!target) throw new HttpError(404, "NOT_FOUND", "Account not found");
    if (target.id === by.id) return { accessToken: await ctx.tokens.sign(by.id, "access"), account: toPublicAccount(by) };
    if (!target.testAccountOf) throw new HttpError(403, "NOT_A_TEST_ACCOUNT", "Only test accounts can be switched into");
    req.log.info({ admin: by.id, account: target.id }, "admin switched into a test account");
    return { accessToken: await ctx.tokens.sign(target.id, "access", { actor: by.id }), account: toPublicAccount(target) };
  });
}
