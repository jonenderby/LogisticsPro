import { describe, expect, it } from "vitest";
import { checkDetention } from "../src/services/stops.js";
import { NYC, api, harness, loadBody, signUp } from "./helpers.js";

// Pickup at NYC 2026-10-06 13:00-15:00Z; delivery Houston 2026-10-08 14:00-18:00Z.
const off = (miles: number) => ({ lat: NYC.geo.lat + miles / 69.05, lng: NYC.geo.lng });

describe("arrival and detention", () => {
  it("records the stop from the truck's location, alerts on detention, and bills it", async () => {
    let now = Date.parse("2026-10-06T12:00:00Z");
    const h = await harness({ now: () => new Date(now) });
    const at = (iso: string) => (now = Date.parse(iso));
    const S = api(h, await signUp(h, "BUSINESS", "Shipper Sam"));
    const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
    const F = api(h, await signUp(h, "CARRIER", "Dispatch Dee"));
    const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"], scac: "BIGF" })).org;
    await F.put(`/v1/orgs/${fleet.id}/detention`, { freeHours: 2, ratePerHour: 80 });
    await S.put(`/v1/orgs/${fleet.id}/detention`, { freeHours: 0, ratePerHour: 999 }, 403);
    const ana = await signUp(h, "TRUCKER", "Ana");
    await F.post(`/v1/orgs/${fleet.id}/members`, { email: ana.email, roles: ["DRIVER"] }, 201);
    const A = api(h, ana);
    const load = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
    await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
    await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [ana.accountId] });

    // Rolls in at 12:40, early for the 13:00 appointment.
    at("2026-10-06T12:30:00Z");
    await A.post("/v1/me/location", { ...off(3), speedMps: 20 });
    at("2026-10-06T12:40:00Z");
    await A.post("/v1/me/location", { ...off(0.1), speedMps: 0 });
    const prompt = (await A.get("/v1/me/notifications")).items[0];
    expect(prompt).toMatchObject({ kind: "STOP", title: "You're at Acme Bronx DC", target: "LOAD", loadId: load.id });

    // Free time runs from the appointment: detention starts at 15:00 and is announced once.
    at("2026-10-06T14:55:00Z");
    expect(checkDetention(h.ctx)).toBe(0);
    at("2026-10-06T15:05:00Z");
    expect(checkDetention(h.ctx)).toBe(1);
    expect(checkDetention(h.ctx)).toBe(0);
    expect((await S.get("/v1/me/notifications")).items[0]).toMatchObject({ kind: "DETENTION", title: `Detention started: ${load.loadNumber}` });
    expect((await F.get("/v1/me/notifications")).items[0]).toMatchObject({ kind: "DETENTION" });

    // Leaves at 16:10: 3 h 10 min from the appointment, 1 h 15 min billed at $80.
    at("2026-10-06T16:10:00Z");
    await A.post(`/v1/loads/${load.id}/status`, { code: "LOADED" });
    await A.post("/v1/me/location", { ...off(2), speedMps: 20 });
    const d = await S.get(`/v1/loads/${load.id}/detention`);
    expect(d.terms).toMatchObject({ freeHours: 2, ratePerHour: 80 });
    expect(d.stops[0]).toMatchObject({ arrivedAt: "2026-10-06T12:40:00.000Z", departedAt: "2026-10-06T16:10:00.000Z", source: "GEOFENCE", billableMinutes: 75, amount: 100 });
    expect(d.total).toBe(100);

    // Delivered: the invoice carries the detention line on its own.
    at("2026-10-08T15:00:00Z");
    await A.post(`/v1/loads/${load.id}/status`, { code: "DELIVERED" });
    const { invoice } = await A.post(`/v1/loads/${load.id}/invoices`, {}, 201);
    expect(invoice.lines.map((l: { code: string; amount: number }) => [l.code, l.amount])).toEqual([
      ["LINEHAUL", 5200],
      ["DETENTION", 100],
    ]);
    expect(invoice.total).toBe(5300);
    await api(h, await signUp(h, "BUSINESS", "Nosy")).get(`/v1/loads/${load.id}/detention`, 404);
  });
});
