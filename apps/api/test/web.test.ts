import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { totp } from "../src/security/totp.js";

const WEB = { "x-lp-client": "web" };

describe("browser sessions", () => {
  it("keeps the refresh token in an httpOnly cookie that rotates", async () => {
    const { app } = await buildApp();
    const reg = (await app.inject({ method: "POST", url: "/v1/auth/register", headers: WEB, payload: { email: "web@example.com", password: "correct horse battery staple", name: "Web", profileType: "BUSINESS" } })).json();
    const act = await app.inject({ method: "POST", url: "/v1/auth/mfa/activate", headers: WEB, payload: { token: reg.enrollToken, code: totp(reg.totpSecret) } });
    expect(act.statusCode).toBe(200);
    expect(act.json().refreshToken).toBeUndefined();
    expect(act.json().accessToken).toBeTruthy();
    const cookie = String(act.headers["set-cookie"]);
    expect(cookie).toMatch(/^lp_rt=[^;]+; HttpOnly; SameSite=Strict; Path=\/v1\/auth; Max-Age=2592000$/);
    const value = cookie.split(";")[0]!;

    // A page reload restores the session from the cookie alone.
    const r1 = await app.inject({ method: "POST", url: "/v1/auth/refresh", headers: { ...WEB, cookie: value } });
    expect(r1.statusCode).toBe(200);
    const rotated = String(r1.headers["set-cookie"]).split(";")[0]!;
    expect(rotated).not.toBe(value);
    // The old cookie is single-use, and a failed refresh clears it.
    const reuse = await app.inject({ method: "POST", url: "/v1/auth/refresh", headers: { ...WEB, cookie: value } });
    expect(reuse.statusCode).toBe(401);
    expect(String(reuse.headers["set-cookie"])).toContain("Max-Age=0");

    const out = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { ...WEB, cookie: rotated } });
    expect(String(out.headers["set-cookie"])).toContain("lp_rt=; ");
    expect((await app.inject({ method: "POST", url: "/v1/auth/refresh", headers: { ...WEB, cookie: rotated } })).statusCode).toBe(401);
  });

  it("marks the cookie Secure when configured", async () => {
    const { app } = await buildApp({ config: { cookieSecure: true } });
    const reg = (await app.inject({ method: "POST", url: "/v1/auth/register", headers: WEB, payload: { email: "s@example.com", password: "correct horse battery staple", name: "S", profileType: "BUSINESS" } })).json();
    const act = await app.inject({ method: "POST", url: "/v1/auth/mfa/activate", headers: WEB, payload: { token: reg.enrollToken, code: totp(reg.totpSecret) } });
    expect(String(act.headers["set-cookie"])).toMatch(/; Secure$/);
  });

  it("allows credentialed CORS only from configured web origins", async () => {
    const { app } = await buildApp({ config: { webOrigins: ["https://app.logisticspro.example"] } });
    const ok = await app.inject({ method: "OPTIONS", url: "/v1/auth/refresh", headers: { origin: "https://app.logisticspro.example", "access-control-request-method": "POST" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("https://app.logisticspro.example");
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");
    const evil = await app.inject({ method: "OPTIONS", url: "/v1/auth/refresh", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("serving the website", () => {
  it("serves the app, falls back to it for deep links, and keeps API 404s as JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lp-web-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>Logistics Pro</title><div id=root></div>");
    await mkdir(join(dir, "_expo"));
    await writeFile(join(dir, "_expo", "app.js"), "console.log(1)");
    const { app } = await buildApp({ config: { webDir: dir } });

    const home = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain("<title>Logistics Pro</title>");
    expect(home.headers["x-frame-options"]).toBe("DENY");

    const deep = await app.inject({ method: "GET", url: "/loads/load/load_123", headers: { accept: "text/html,application/xhtml+xml" } });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('<div id=root>');
    expect(deep.headers["cache-control"]).toBe("no-cache");

    const asset = await app.inject({ method: "GET", url: "/_expo/app.js" });
    expect(asset.headers["cache-control"]).toContain("immutable");

    const api404 = await app.inject({ method: "GET", url: "/v1/nothing-here", headers: { accept: "text/html" } });
    expect(api404.statusCode).toBe(404);
    expect(api404.json().error.code).toBe("NOT_FOUND");
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true });
  });
});
