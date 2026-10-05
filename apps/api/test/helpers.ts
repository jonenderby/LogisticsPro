import { MemoryTransport, type OutboundMessage, as2 } from "@logisticspro/integration";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryPushSender } from "../src/services/push.js";
import { totp } from "../src/security/totp.js";

export interface Harness {
  app: FastifyInstance;
  ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
  https: MemoryTransport;
  van: MemoryTransport;
  sent: () => OutboundMessage[];
}

/** One station identity for all tests (RSA key generation is slow). */
export const STATION = as2.generateAs2Identity("LOGISTICSPRO");

export async function harness(opts: Parameters<typeof buildApp>[0] = {}): Promise<Harness> {
  const https = new MemoryTransport();
  const van = new MemoryTransport();
  const { app, ctx } = await buildApp({ transports: { HTTPS: https, VAN: van, SFTP: van }, secrets: (ref) => `secret-for-${ref}`, as2Identity: STATION, push: new MemoryPushSender(), ...opts, config: { alertIntervalSeconds: 0, ...opts.config } });
  return { app, ctx, https, van, sent: () => [...https.sent, ...van.sent] };
}

export interface Session {
  token: string;
  accountId: string;
  email: string;
  totpSecret: string;
  recoveryCodes: string[];
  refreshToken: string;
}

let n = 0;
export async function signUp(h: Harness, profileType: "TRUCKER" | "CARRIER" | "BROKER_3PL" | "BUSINESS", name: string): Promise<Session> {
  const email = `${name.toLowerCase().replace(/\W+/g, ".")}.${++n}@example.com`;
  const reg = await h.app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, password: "correct horse battery staple", name, profileType } });
  expect(reg.statusCode, reg.body).toBe(201);
  const r = reg.json();
  expect(r.status).toBe("MFA_ENROLLMENT_REQUIRED");
  const act = await h.app.inject({ method: "POST", url: "/v1/auth/mfa/activate", payload: { token: r.enrollToken, code: totp(r.totpSecret, h.ctx.now().getTime()) } });
  expect(act.statusCode, act.body).toBe(200);
  const a = act.json();
  return { token: a.accessToken, accountId: a.account.id, email, totpSecret: r.totpSecret, recoveryCodes: a.recoveryCodes, refreshToken: a.refreshToken };
}

export function api(h: Harness, s: Session) {
  const call = async (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown, expected?: number) => {
    const res = await h.app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${s.token}` } });
    if (expected !== undefined) expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(expected);
    return res;
  };
  return {
    get: async (url: string, expected = 200) => (await call("GET", url, undefined, expected)).json(),
    post: async (url: string, payload: unknown = {}, expected?: number) => {
      const res = await call("POST", url, payload);
      if (expected !== undefined) expect(res.statusCode, `POST ${url}: ${res.body}`).toBe(expected);
      else expect(res.statusCode, `POST ${url}: ${res.body}`).toBeLessThan(300);
      return res.json();
    },
    put: async (url: string, payload: unknown, expected = 200) => (await call("PUT", url, payload, expected)).json(),
    patch: async (url: string, payload: unknown, expected = 200) => (await call("PATCH", url, payload, expected)).json(),
  };
}

export const NYC = { name: "Acme Bronx DC", line1: "600 Food Center Dr", city: "Bronx", state: "NY", postalCode: "10474", country: "US", geo: { lat: 40.8091, lng: -73.8752 } };
export const HOU = { name: "Gulf Grocers", line1: "2800 Post Oak Blvd", city: "Houston", state: "TX", postalCode: "77056", country: "US", geo: { lat: 29.7419, lng: -95.4614 } };
export const NASH = { name: "Relay Yard", line1: "100 Relay Way", city: "Nashville", state: "TN", postalCode: "37210", country: "US", geo: { lat: 36.1447, lng: -86.7341 } };

export function loadBody(shipperOrgId: string, over: Record<string, unknown> = {}) {
  return {
    shipperOrgId,
    mode: "FTL",
    equipment: { type: "REEFER", lengthFt: 53 },
    references: { bol: "BOL-1", po: ["PO-77"] },
    stops: [
      { type: "PICKUP", address: NYC, window: { start: "2026-10-06T13:00:00Z", end: "2026-10-06T15:00:00Z" }, contact: { name: "Dock", phone: "7185550100" } },
      { type: "DELIVERY", address: HOU, window: { start: "2026-10-08T14:00:00Z", end: "2026-10-08T18:00:00Z" } },
    ],
    items: [{ description: "Frozen food", pieces: 20, packaging: "PLT", weightLb: 38000 }],
    rate: { amount: 5200, currency: "USD" },
    ...over,
  };
}
