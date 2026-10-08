import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { basePathOf } from "../src/config.js";
import { totp } from "../src/security/totp.js";
import { harness } from "./helpers.js";

const WEB = { "x-lp-client": "web" };

describe("a server under a path on a shared domain", () => {
  it("takes its path from the public address", () => {
    expect(basePathOf("https://jonnysserver.com/logistics")).toBe("/logistics");
    expect(basePathOf("https://jonnysserver.com/apps/logistics/")).toBe("/apps/logistics");
    expect(basePathOf("https://app.logisticspro.example")).toBe("");
    expect(basePathOf("not a url")).toBe("");
  });

  it("answers with or without the path, so the proxy may pass it on or strip it", async () => {
    const h = await harness({ config: { publicUrl: "https://jonnysserver.com/logistics" } });
    expect(h.ctx.cfg.basePath).toBe("/logistics");
    for (const url of ["/logistics/health", "/health", "/logistics/health?x=1"]) expect((await h.app.inject({ method: "GET", url })).json(), url).toEqual({ ok: true });
    // Only the whole path segment is the base: /logisticsfoo is something else.
    expect((await h.app.inject({ method: "GET", url: "/logisticsfoo/health" })).statusCode).toBe(404);
  });

  it("scopes the browser session cookie to the app's path", async () => {
    const h = await harness({ config: { publicUrl: "https://jonnysserver.com/logistics" } });
    const reg = (await h.app.inject({ method: "POST", url: "/logistics/v1/auth/register", headers: WEB, payload: { email: "path@example.com", password: "correct horse battery staple", name: "Path", profileType: "BUSINESS" } })).json();
    const act = await h.app.inject({ method: "POST", url: "/logistics/v1/auth/mfa/activate", headers: WEB, payload: { token: reg.enrollToken, code: totp(reg.totpSecret, h.ctx.now().getTime()) } });
    expect(act.statusCode).toBe(200);
    expect(String(act.headers["set-cookie"])).toContain("; Path=/logistics/v1/auth;");
    const cookie = String(act.headers["set-cookie"]).split(";")[0]!;
    expect((await h.app.inject({ method: "POST", url: "/logistics/v1/auth/refresh", headers: { ...WEB, cookie } })).statusCode).toBe(200);
  });

  it("links the download page within the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lp-downloads-"));
    await writeFile(join(dir, "logistics-pro.apk"), "apk");
    const h = await harness({ config: { publicUrl: "https://jonnysserver.com/logistics", downloadsDir: dir } });
    const page = await h.app.inject({ method: "GET", url: "/logistics/download" });
    expect(page.body).toContain('href="/logistics/download/logistics-pro.apk"');
    expect(page.body).toContain('href="/logistics/"');
    expect((await h.app.inject({ method: "GET", url: "/logistics/download/logistics-pro.apk" })).body).toBe("apk");
  });
});
