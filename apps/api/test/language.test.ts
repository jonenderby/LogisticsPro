import { describe, expect, it } from "vitest";
import { NYC, api, harness, loadBody, signUp } from "./helpers.js";

describe("language", () => {
  it("defaults every new account to English, with Spanish chosen at sign-up", async () => {
    const h = await harness();
    const reg = (language?: string) => h.app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: `${language ?? "none"}@example.com`, password: "correct horse battery staple", name: "New Driver", profileType: "TRUCKER", ...(language ? { language } : {}) } });
    expect((await reg()).json().account.language).toBe("en");
    expect((await reg("es")).json().account.language).toBe("es");
    expect((await reg("fr")).statusCode).toBe(400);
  });

  it("gives a Spanish-speaking driver a Spanish feed and pushes", async () => {
    let now = Date.parse("2026-10-06T12:00:00Z");
    const h = await harness({ now: () => new Date(now) });
    const ana = await signUp(h, "TRUCKER", "Ana");
    const A = api(h, ana);
    await A.put("/v1/me/preferences", { language: "fr" }, 400);
    expect((await A.put("/v1/me/preferences", { language: "es" })).language).toBe("es");
    expect((await A.get("/v1/me")).feed[0]).toMatchObject({ title: "Únete a tu transportista", cta: { label: "Unirte a un transportista" } });

    const S = api(h, await signUp(h, "BUSINESS", "Shipper Sam"));
    const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
    const F = api(h, await signUp(h, "CARRIER", "Owner Olga"));
    const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"] })).org;
    await F.post(`/v1/orgs/${fleet.id}/members`, { email: ana.email, roles: ["DRIVER"] }, 201);
    const load = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
    await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
    await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [ana.accountId] });
    expect((await A.get("/v1/me")).feed.find((i: { id: string }) => i.id === `drive:${load.id}`)).toMatchObject({ title: `Siguiente carga ${load.loadNumber}`, cta: { label: "Llegué a la recogida", statusCode: "ARRIVED_PICKUP" } });
    // Everyone else stays in English.
    expect((await F.get("/v1/me")).feed.some((i: { title: string }) => /carga/.test(i.title))).toBe(false);

    // Rolling up to the pickup: the push is in Spanish.
    now = Date.parse("2026-10-06T12:50:00Z");
    await A.post("/v1/me/location", { lat: NYC.geo.lat + 0.03, lng: NYC.geo.lng, speedMps: 15 });
    now += 5 * 60_000;
    await A.post("/v1/me/location", { lat: NYC.geo.lat, lng: NYC.geo.lng, speedMps: 0 });
    expect((await A.get("/v1/me/notifications")).items[0]).toMatchObject({ kind: "STOP", title: "Estás en Acme Bronx DC", body: `Toca para marcar la llegada a la recogida de ${load.loadNumber}.` });
  });
});
