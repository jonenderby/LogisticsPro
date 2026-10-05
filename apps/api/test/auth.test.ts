import { describe, expect, it } from "vitest";
import { totp } from "../src/security/totp.js";
import { api, harness, signUp } from "./helpers.js";

describe("accounts and two-factor authentication", () => {
  it("requires 2FA enrollment before issuing a session", async () => {
    const h = await harness();
    const reg = await h.app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "new@example.com", password: "correct horse battery staple", name: "New", profileType: "BUSINESS" } });
    const r = reg.json();
    expect(r.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Logistics%20Pro%3Anew%40example\.com\?secret=/);
    expect(r.accessToken).toBeUndefined();
    // the enrollment token is not a session
    const meRes = await h.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${r.enrollToken}` } });
    expect(meRes.statusCode).toBe(401);
    const bad = await h.app.inject({ method: "POST", url: "/v1/auth/mfa/activate", payload: { token: r.enrollToken, code: "000000" } });
    expect(bad.statusCode).toBe(400);
    // signing in before enrolling sends you back to enrollment
    const login = await h.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "new@example.com", password: "correct horse battery staple" } });
    expect(login.json().status).toBe("MFA_ENROLLMENT_REQUIRED");
  });

  it("signs in with password + authenticator code, or a single-use recovery code", async () => {
    let now = Date.parse("2026-10-05T15:00:00Z");
    const h = await harness({ now: () => new Date(now) });
    const s = await signUp(h, "BUSINESS", "Pat Shipper");
    expect(s.recoveryCodes).toHaveLength(10);
    const login = async () => (await h.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: s.email, password: "correct horse battery staple" } })).json();
    const l1 = await login();
    expect(l1.status).toBe("MFA_REQUIRED");
    // The code used to activate two-factor cannot be used again.
    const replay = await h.app.inject({ method: "POST", url: "/v1/auth/login/mfa", payload: { token: l1.mfaToken, code: totp(s.totpSecret, now) } });
    expect(replay.statusCode).toBe(400);
    now += 30_000;
    const code = totp(s.totpSecret, now);
    const ok = await h.app.inject({ method: "POST", url: "/v1/auth/login/mfa", payload: { token: l1.mfaToken, code } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().accessToken).toBeTruthy();
    // Each code opens one session.
    expect((await h.app.inject({ method: "POST", url: "/v1/auth/login/mfa", payload: { token: (await login()).mfaToken, code } })).statusCode).toBe(400);

    const rec = await h.app.inject({ method: "POST", url: "/v1/auth/login/mfa", payload: { token: (await login()).mfaToken, code: s.recoveryCodes[0] } });
    expect(rec.json()).toMatchObject({ usedRecoveryCode: true, recoveryCodesLeft: 9 });
    const again = await h.app.inject({ method: "POST", url: "/v1/auth/login/mfa", payload: { token: (await login()).mfaToken, code: s.recoveryCodes[0] } });
    expect(again.statusCode).toBe(400);
  });

  it("rejects weak passwords and duplicate emails, and locks out repeated failures", async () => {
    const h = await harness();
    const weak = await h.app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "w@example.com", password: "short", name: "W", profileType: "TRUCKER" } });
    expect(weak.json().error.code).toBe("WEAK_PASSWORD");
    const s = await signUp(h, "TRUCKER", "Dup");
    const dup = await h.app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: s.email, password: "correct horse battery staple", name: "Dup", profileType: "TRUCKER" } });
    expect(dup.statusCode).toBe(409);
    for (let i = 0; i < 5; i++) {
      const r = await h.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: s.email, password: "wrong password here" } });
      expect(r.statusCode).toBe(401);
    }
    const locked = await h.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: s.email, password: "correct horse battery staple" } });
    expect(locked.statusCode).toBe(429);
  });

  it("rotates refresh tokens", async () => {
    const h = await harness();
    const s = await signUp(h, "TRUCKER", "Rota");
    const r1 = await h.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: s.refreshToken } });
    expect(r1.statusCode).toBe(200);
    const reuse = await h.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: s.refreshToken } });
    expect(reuse.statusCode).toBe(401);
    expect((await api(h, { ...s, token: r1.json().accessToken }).get("/v1/me")).account.email).toBe(s.email);
  });
});
