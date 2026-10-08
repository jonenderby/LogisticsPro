import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { Config } from "../config.js";

export type TokenPurpose = "access" | "mfa" | "enroll";

export interface TokenClaims {
  sub: string;
  purpose: TokenPurpose;
  /** A platform admin using this (test) account: the admin's account id. */
  actor?: string;
}

const TTL: Record<Exclude<TokenPurpose, "access">, string> = { mfa: "5m", enroll: "30m" };

export class Tokens {
  constructor(private readonly cfg: Config) {}

  sign(accountId: string, purpose: TokenPurpose, opts: { actor?: string } = {}): Promise<string> {
    return new SignJWT({ purpose, ...(opts.actor ? { act: { sub: opts.actor } } : {}) })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(accountId)
      .setIssuer(this.cfg.issuer)
      .setAudience(`lp:${purpose}`)
      .setIssuedAt()
      .setExpirationTime(purpose === "access" ? this.cfg.accessTokenTtl : TTL[purpose])
      .sign(this.cfg.jwtSecret);
  }

  async verify(token: string, purpose: TokenPurpose): Promise<TokenClaims> {
    const { payload } = await jwtVerify(token, this.cfg.jwtSecret, { issuer: this.cfg.issuer, audience: `lp:${purpose}`, algorithms: ["HS256"] });
    if (payload.purpose !== purpose || typeof payload.sub !== "string") throw new Error("wrong token purpose");
    const act = (payload.act as { sub?: unknown } | undefined)?.sub;
    return { sub: payload.sub, purpose, ...(typeof act === "string" ? { actor: act } : {}) };
  }
}

/** Opaque refresh tokens; only their hash is stored. */
export function newOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256(token) };
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
