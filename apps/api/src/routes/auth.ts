import { type Account, ProfileType, newId, toPublicAccount } from "@logisticspro/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, me, parse } from "../http.js";
import { hashPassword, passwordProblems, verifyPassword } from "../security/password.js";
import { acceptTotpCode } from "../security/stepup.js";
import { hashCode, newRecoveryCodes, newTotpSecret, otpauthUri } from "../security/totp.js";
import { newOpaqueToken, sha256 } from "../security/tokens.js";

const Register = z.object({
  email: z.string().email().max(254),
  password: z.string(),
  name: z.string().min(1).max(120),
  phone: z.string().max(30).optional(),
  profileType: ProfileType,
  driver: z.object({ cdlNumber: z.string().optional(), cdlState: z.string().optional() }).optional(),
  /** Chosen when the account is set up; English unless they pick Spanish. */
  language: z.enum(["en", "es"]).default("en"),
});

const Login = z.object({ email: z.string(), password: z.string() });
const Code = z.object({ token: z.string(), code: z.string().min(6).max(12) });

const MAX_FAILURES = 5;
const COOKIE = "lp_rt";

/** Browsers keep the refresh token in an httpOnly cookie that page scripts cannot read. */
const isWeb = (req: FastifyRequest) => req.headers["x-lp-client"] === "web";

function readCookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
const LOCK_MS = 15 * 60_000;

/**
 * Sign-up and sign-in with mandatory two-factor authentication (TOTP).
 * Registration returns an enrollment token that can only activate 2FA; a
 * full session is issued only after a valid authenticator code.
 */
export function authRoutes(app: FastifyInstance, ctx: AppContext) {
  // Lockout is shared across API servers through the store.
  const failures = ctx.store.loginFailures;

  /** An authenticator code works once: a code seen on the wire cannot open a second session. */
  const acceptCode = (accountId: string, secret: string, code: string): boolean => acceptTotpCode(ctx, accountId, secret, code);

  const setCookie = (reply: FastifyReply, value: string, maxAge: number) =>
    reply.header("set-cookie", `${COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/v1/auth; Max-Age=${maxAge}${ctx.cfg.cookieSecure ? "; Secure" : ""}`);

  const issueSession = async (account: Account, req: FastifyRequest, reply: FastifyReply) => {
    const refresh = newOpaqueToken();
    const days = ctx.cfg.refreshTokenDays;
    ctx.store.refreshTokens.set(refresh.hash, { hash: refresh.hash, accountId: account.id, expiresAt: new Date(ctx.now().getTime() + days * 86_400_000).toISOString(), revoked: false });
    const accessToken = await ctx.tokens.sign(account.id, "access");
    if (isWeb(req)) {
      setCookie(reply, refresh.token, days * 86_400);
      return { accessToken, account: toPublicAccount(account) };
    }
    return { accessToken, refreshToken: refresh.token, account: toPublicAccount(account) };
  };

  const refreshTokenFrom = (req: FastifyRequest) => (req.body as { refreshToken?: string } | undefined)?.refreshToken ?? readCookie(req, COOKIE);

  const enrollment = async (account: Account) => {
    const secret = account.mfa.totpSecret ?? newTotpSecret();
    ctx.store.accounts.set(account.id, { ...account, mfa: { ...account.mfa, totpSecret: secret } });
    return { status: "MFA_ENROLLMENT_REQUIRED", enrollToken: await ctx.tokens.sign(account.id, "enroll"), totpSecret: secret, otpauthUrl: otpauthUri(secret, account.email) };
  };

  app.post("/v1/auth/register", async (req, reply) => {
    const body = parse(Register, req.body);
    const email = body.email.trim().toLowerCase();
    const problems = passwordProblems(body.password, email);
    if (problems.length) throw new HttpError(400, "WEAK_PASSWORD", problems.join(". "));
    if (ctx.store.accountByEmail(email)) throw new HttpError(409, "EMAIL_TAKEN", "An account with this email already exists");
    const account: Account = {
      id: newId("acct"),
      email,
      name: body.name,
      phone: body.phone,
      profileType: body.profileType,
      passwordHash: await hashPassword(body.password),
      mfa: { enabled: false, recoveryCodeHashes: [] },
      driver: body.profileType === "TRUCKER" ? { ...body.driver, endorsements: [], twicCard: false } : undefined,
      language: body.language,
      createdAt: ctx.now().toISOString(),
    };
    ctx.store.accounts.set(account.id, account);
    reply.code(201);
    return { account: toPublicAccount(account), ...(await enrollment(account)) };
  });

  app.post("/v1/auth/mfa/activate", async (req, reply) => {
    const body = parse(Code, req.body);
    const claims = await ctx.tokens.verify(body.token, "enroll").catch(() => {
      throw new HttpError(401, "UNAUTHENTICATED", "Enrollment expired; sign in again");
    });
    const account = ctx.store.accounts.get(claims.sub)!;
    if (!account.mfa.totpSecret || !acceptCode(account.id, account.mfa.totpSecret, body.code)) throw new HttpError(400, "BAD_CODE", "That code did not match. Check your authenticator app's time and try again.");
    const codes = newRecoveryCodes();
    const updated: Account = { ...account, mfa: { enabled: true, totpSecret: account.mfa.totpSecret, recoveryCodeHashes: codes.map(hashCode) } };
    ctx.store.accounts.set(account.id, updated);
    return { ...(await issueSession(updated, req, reply)), recoveryCodes: codes };
  });

  app.post("/v1/auth/login", async (req) => {
    const body = parse(Login, req.body);
    const email = body.email.trim().toLowerCase();
    const f = failures.get(email);
    if (f && f.until > Date.now()) throw new HttpError(429, "LOCKED", "Too many attempts. Try again in a few minutes.");
    const account = ctx.store.accountByEmail(email);
    const ok = account ? await verifyPassword(body.password, account.passwordHash) : await verifyPassword(body.password, "scrypt$16384$AAAA$AAAA");
    if (!account || !ok) {
      const count = (f?.count ?? 0) + 1;
      failures.set(email, { count, until: count >= MAX_FAILURES ? Date.now() + LOCK_MS : 0 });
      throw new HttpError(401, "BAD_CREDENTIALS", "Email or password is incorrect");
    }
    failures.delete(email);
    if (!account.mfa.enabled) return enrollment(account);
    return { status: "MFA_REQUIRED", mfaToken: await ctx.tokens.sign(account.id, "mfa") };
  });

  app.post("/v1/auth/login/mfa", async (req, reply) => {
    const body = parse(Code, req.body);
    const claims = await ctx.tokens.verify(body.token, "mfa").catch(() => {
      throw new HttpError(401, "UNAUTHENTICATED", "Sign-in expired; start again");
    });
    const account = ctx.store.accounts.get(claims.sub)!;
    const secret = account.mfa.totpSecret!;
    if (acceptCode(account.id, secret, body.code)) return issueSession(account, req, reply);
    const h = hashCode(body.code);
    if (account.mfa.recoveryCodeHashes.includes(h)) {
      const updated = { ...account, mfa: { ...account.mfa, recoveryCodeHashes: account.mfa.recoveryCodeHashes.filter((x) => x !== h) } };
      ctx.store.accounts.set(account.id, updated);
      return { ...(await issueSession(updated, req, reply)), usedRecoveryCode: true, recoveryCodesLeft: updated.mfa.recoveryCodeHashes.length };
    }
    throw new HttpError(400, "BAD_CODE", "That code did not match");
  });

  app.post("/v1/auth/refresh", async (req, reply) => {
    const refreshToken = refreshTokenFrom(req);
    const rec = refreshToken ? ctx.store.refreshTokens.get(sha256(refreshToken)) : undefined;
    if (!rec || rec.revoked || rec.expiresAt < ctx.now().toISOString()) {
      if (isWeb(req)) setCookie(reply, "", 0);
      throw new HttpError(401, "UNAUTHENTICATED", "Session expired; sign in again");
    }
    // Rotate: each refresh token is single-use.
    rec.revoked = true;
    ctx.store.refreshTokens.touch(sha256(refreshToken!));
    return issueSession(ctx.store.accounts.get(rec.accountId)!, req, reply);
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const refreshToken = refreshTokenFrom(req);
    const rec = refreshToken ? ctx.store.refreshTokens.get(sha256(refreshToken)) : undefined;
    if (rec) {
      rec.revoked = true;
      ctx.store.refreshTokens.touch(sha256(refreshToken!));
    }
    if (isWeb(req)) setCookie(reply, "", 0);
    return { ok: true };
  });

  app.post("/v1/auth/mfa/recovery-codes", { preHandler: authenticate(ctx) }, async (req) => {
    const { code } = parse(z.object({ code: z.string() }), req.body);
    const account = me(ctx, req);
    if (!acceptCode(account.id, account.mfa.totpSecret!, code)) throw new HttpError(400, "BAD_CODE", "That code did not match");
    const codes = newRecoveryCodes();
    ctx.store.accounts.set(account.id, { ...account, mfa: { ...account.mfa, recoveryCodeHashes: codes.map(hashCode) } });
    return { recoveryCodes: codes };
  });
}
