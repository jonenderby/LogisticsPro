import { translator } from "@logisticspro/workspace";
import { describe, expect, it } from "vitest";
import { setupStatus } from "../src/services/setup.js";
import { api, harness, signUp } from "./helpers.js";

describe("setup status", () => {
  it("is shown only to the people who run the deployment", async () => {
    const h = await harness();
    const ops = await signUp(h, "BUSINESS", "Ops");
    const other = await signUp(h, "BUSINESS", "Shipper");
    h.ctx.cfg.adminEmails.push(ops.email);

    expect((await api(h, ops).get("/v1/me")).platformAdmin).toBe(true);
    expect((await api(h, other).get("/v1/me")).platformAdmin).toBe(false);
    await api(h, other).get("/v1/system/setup", 403);

    const { items } = await api(h, ops).get("/v1/system/setup");
    const state = Object.fromEntries(items.map((i: { id: string; state: string }) => [i.id, i.state]));
    // The test harness runs in memory with nothing connected.
    expect(state).toMatchObject({ database: "WARN", routing: "OFF", traffic: "OFF", geocoder: "OFF", fmcsa: "OFF", files: "WARN", "public-url": "WARN" });
    // Settings are named; secrets never appear.
    expect(items.find((i: { id: string }) => i.id === "sessions").settings).toEqual(["LP_JWT_SECRET"]);
    expect(JSON.stringify(items)).not.toContain("secret-for-");
  });

  it("checks that routing and address search answer, and speaks the admin's language", async () => {
    const h = await harness({ config: { valhallaUrl: "http://valhalla:8002", geocoder: { kind: "nominatim", url: "http://nominatim:8080" }, fmcsaWebKey: "key", publicUrl: "https://api.example.com", jwtSecretSet: true } });
    const asked: string[] = [];
    const items = await setupStatus(h.ctx, translator("es"), async (url) => {
      asked.push(url);
      return url.includes("valhalla");
    });
    expect(asked.sort()).toEqual(["http://nominatim:8080", "http://valhalla:8002/status"]);
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(by.routing!.state).toBe("OK");
    expect(by.geocoder!.state).toBe("WARN");
    expect(by.geocoder!.detail).toBe("Nominatim no responde en http://nominatim:8080.");
    expect(by.fmcsa!.state).toBe("OK");
    expect(by["public-url"]!.state).toBe("OK");
    expect(by.sessions!.state).toBe("OK");
    expect(by.routing!.title).toBe("Rutas para camiones");
  });
});
