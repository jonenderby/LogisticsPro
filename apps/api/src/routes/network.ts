import { randomInt } from "node:crypto";
import { JOIN_CODE_ALPHABET, type JoinCode, type JoinRequest, formatJoinCode, newId, normalizeJoinCode, toPublicAccount } from "@logisticspro/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, hasOrgCap, me, parse, requireOrgCap } from "../http.js";

/**
 * A carrier's driver network.
 *
 * - Carriers add drivers directly (by email) or share a join code.
 * - A join code only lets a trucker *request* to join; dispatch approves.
 * - Codes expire (LP_JOIN_CODE_TTL_HOURS, default 7 days) and rotate
 *   automatically; the carrier can rotate early at any time, which
 *   immediately invalidates the old code.
 * - Truckers are limited to a few code attempts per hour so codes cannot be
 *   guessed.
 */
export function networkRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };
  const attempts = ctx.store.joinAttempts;

  const newCode = (orgId: string): JoinCode => {
    const raw = Array.from({ length: 8 }, () => JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)]).join("");
    const now = ctx.now();
    const code: JoinCode = { carrierOrgId: orgId, code: raw, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ctx.cfg.joinCodeTtlHours * 3_600_000).toISOString() };
    ctx.store.joinCodes.set(orgId, code);
    return code;
  };
  const current = (orgId: string): JoinCode => {
    const c = ctx.store.joinCodes.get(orgId);
    return c && c.expiresAt > ctx.now().toISOString() ? c : newCode(orgId);
  };
  const view = (c: JoinCode) => ({ code: formatJoinCode(c.code), expiresAt: c.expiresAt, createdAt: c.createdAt, rotatesEveryHours: ctx.cfg.joinCodeTtlHours });
  const carrierOf = (orgId: string) => {
    const org = ctx.store.orgs.get(orgId);
    if (!org?.kinds.includes("CARRIER")) throw new HttpError(404, "NOT_FOUND", "Carrier not found");
    return org;
  };
  const canManage = (accountId: string, orgId: string) => hasOrgCap(ctx, accountId, orgId, "MANAGE_ORG") || hasOrgCap(ctx, accountId, orgId, "DISPATCH");
  const requireManage = (accountId: string, orgId: string) => {
    if (!canManage(accountId, orgId)) throw new HttpError(403, "FORBIDDEN", "Only the carrier's owner, admins or dispatchers can manage its drivers");
  };
  const requestView = (r: JoinRequest) => ({ ...r, account: toPublicAccount(ctx.store.accounts.get(r.accountId)!), carrierName: ctx.store.orgs.get(r.carrierOrgId)?.name });

  app.get("/v1/orgs/:orgId/join-code", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    carrierOf(orgId);
    requireManage(account.id, orgId);
    return view(current(orgId));
  });

  app.post("/v1/orgs/:orgId/join-code/rotate", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    carrierOf(orgId);
    requireManage(account.id, orgId);
    return view(newCode(orgId));
  });

  /** A trucker asks to join the carrier that issued this code. */
  app.post("/v1/carriers/join", auth, async (req, reply) => {
    const account = me(ctx, req);
    const { code, message } = parse(z.object({ code: z.string().min(4).max(20), message: z.string().max(500).optional() }), req.body);
    const now = ctx.now().getTime();
    const recent = (attempts.get(account.id) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= 10) throw new HttpError(429, "TOO_MANY_ATTEMPTS", "Too many join code attempts. Try again in an hour.");
    attempts.set(account.id, [...recent, now]);
    const wanted = normalizeJoinCode(code);
    const match = [...ctx.store.joinCodes.values()].find((c) => c.code === wanted && c.expiresAt > ctx.now().toISOString());
    if (!match) throw new HttpError(404, "INVALID_CODE", "That join code is not valid or has expired. Ask the carrier for its current code.");
    const org = carrierOf(match.carrierOrgId);
    if (ctx.store.memberships.some((m) => m.accountId === account.id && m.orgId === org.id && m.roles.includes("DRIVER"))) {
      throw new HttpError(409, "ALREADY_MEMBER", `You already drive for ${org.name}`);
    }
    const pending = [...ctx.store.joinRequests.values()].find((r) => r.accountId === account.id && r.carrierOrgId === org.id && r.status === "PENDING");
    if (pending) return requestView(pending);
    const r: JoinRequest = { id: newId("jreq"), carrierOrgId: org.id, accountId: account.id, status: "PENDING", message, createdAt: ctx.now().toISOString() };
    ctx.store.joinRequests.set(r.id, r);
    reply.code(201);
    return requestView(r);
  });

  app.get("/v1/me/join-requests", auth, async (req) => {
    const account = me(ctx, req);
    return [...ctx.store.joinRequests.values()].filter((r) => r.accountId === account.id).map(requestView);
  });

  app.post("/v1/join-requests/:id/cancel", auth, async (req) => {
    const account = me(ctx, req);
    const r = ctx.store.joinRequests.get((req.params as { id: string }).id);
    if (!r || r.accountId !== account.id) throw new HttpError(404, "NOT_FOUND", "Request not found");
    if (r.status !== "PENDING") throw new HttpError(409, "NOT_PENDING", "Request is already decided");
    const next = { ...r, status: "CANCELLED" as const, decidedAt: ctx.now().toISOString() };
    ctx.store.joinRequests.set(r.id, next);
    return requestView(next);
  });

  app.get("/v1/orgs/:orgId/join-requests", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireManage(account.id, orgId);
    const { status } = req.query as { status?: string };
    return [...ctx.store.joinRequests.values()].filter((r) => r.carrierOrgId === orgId && (!status || r.status === status)).map(requestView);
  });

  app.post("/v1/orgs/:orgId/join-requests/:id/:decision", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId, id, decision } = req.params as { orgId: string; id: string; decision: string };
    requireManage(account.id, orgId);
    if (decision !== "approve" && decision !== "decline") throw new HttpError(404, "NOT_FOUND", "Unknown decision");
    const r = ctx.store.joinRequests.get(id);
    if (!r || r.carrierOrgId !== orgId) throw new HttpError(404, "NOT_FOUND", "Request not found");
    if (r.status !== "PENDING") throw new HttpError(409, "NOT_PENDING", "Request is already decided");
    const next: JoinRequest = { ...r, status: decision === "approve" ? "APPROVED" : "DECLINED", decidedAt: ctx.now().toISOString(), decidedByAccountId: account.id };
    ctx.store.joinRequests.set(id, next);
    if (decision === "approve") {
      const existing = ctx.store.memberships.find((m) => m.accountId === r.accountId && m.orgId === orgId);
      if (existing) {
        existing.roles = [...new Set([...existing.roles, "DRIVER" as const])];
        ctx.store.memberships.touch(existing);
      }
      else ctx.store.memberships.push({ accountId: r.accountId, orgId, roles: ["DRIVER"] });
      const driver = ctx.store.accounts.get(r.accountId)!;
      ctx.store.accounts.set(driver.id, { ...driver, driver: { endorsements: [], twicCard: false, ...driver.driver, homeCarrierOrgId: driver.driver?.homeCarrierOrgId ?? orgId } });
    }
    return requestView(next);
  });

  /** Carrier removes someone from its network (never the owner). */
  app.post("/v1/orgs/:orgId/members/:accountId/remove", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId, accountId } = req.params as { orgId: string; accountId: string };
    requireOrgCap(ctx, account.id, orgId, "MANAGE_ORG");
    const m = ctx.store.memberships.find((x) => x.accountId === accountId && x.orgId === orgId);
    if (!m) throw new HttpError(404, "NOT_FOUND", "Not a member");
    if (m.roles.includes("OWNER")) throw new HttpError(409, "OWNER", "The owner cannot be removed");
    ctx.store.memberships.removeWhere((x) => x === m);
    return { ok: true };
  });

  /** A trucker leaves a carrier's network. */
  app.post("/v1/orgs/:orgId/leave", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    const m = ctx.store.memberships.find((x) => x.accountId === account.id && x.orgId === orgId);
    if (!m) throw new HttpError(404, "NOT_FOUND", "You are not a member");
    if (m.roles.includes("OWNER")) throw new HttpError(409, "OWNER", "Owners cannot leave their own company");
    ctx.store.memberships.removeWhere((x) => x === m);
    const acct = ctx.store.accounts.get(account.id)!;
    if (acct.driver?.homeCarrierOrgId === orgId) ctx.store.accounts.set(acct.id, { ...acct, driver: { ...acct.driver, homeCarrierOrgId: undefined } });
    return { ok: true };
  });
}
