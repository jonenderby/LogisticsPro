import { describe, expect, it } from "vitest";
import { HOU, NASH, NYC, api, harness, loadBody, signUp } from "./helpers.js";

const H = 3_600_000;

describe("shipper insights", () => {
  it("reports on-time by carrier and lane, cost per mile and the weekly trend", async () => {
    let now = Date.parse("2026-09-07T12:00:00Z");
    const h = await harness({ now: () => new Date(now) });
    const S = api(h, await signUp(h, "BUSINESS", "Shipper Sam"));
    const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
    const carrier = async (name: string) => {
      const F = api(h, await signUp(h, "CARRIER", `${name} Owner`));
      const org = (await F.post("/v1/orgs", { name, kinds: ["CARRIER"] })).org;
      const d = await signUp(h, "TRUCKER", `${name} Driver`);
      await F.post(`/v1/orgs/${org.id}/members`, { email: d.email, roles: ["DRIVER"] }, 201);
      return { F, org, D: api(h, d), driverId: d.accountId };
    };
    const fast = await carrier("Fast Freight");
    const slow = await carrier("Slow Lines");

    /** A load picked up at `start`, due 48 h later, arriving `lateHours` after its window closes (negative = early). */
    const haul = async (c: Awaited<ReturnType<typeof carrier>>, start: number, to: typeof HOU, rate: number, lateHours: number) => {
      now = start - 24 * H;
      const iso = (t: number) => new Date(t).toISOString();
      const load = await S.post("/v1/loads", loadBody(acme.id, { rate: { amount: rate, currency: "USD" }, stops: [{ type: "PICKUP", address: NYC, window: { start: iso(start), end: iso(start + 2 * H) } }, { type: "DELIVERY", address: to, window: { start: iso(start + 46 * H), end: iso(start + 48 * H) } }] }), 201);
      await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: c.org.id });
      await c.F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
      await c.F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [c.driverId] });
      now = start + 30 * 60_000;
      for (const code of ["ARRIVED_PICKUP", "LOADED"]) await c.D.post(`/v1/loads/${load.id}/status`, { code });
      now = start + (48 + lateHours) * H;
      for (const code of ["ARRIVED_DELIVERY", "DELIVERED"]) await c.D.post(`/v1/loads/${load.id}/status`, { code });
    };
    const sep = (day: number) => Date.parse(`2026-09-${String(day).padStart(2, "0")}T14:00:00Z`);
    await haul(fast, sep(8), HOU, 5200, -1);
    await haul(fast, sep(15), HOU, 5400, -1);
    await haul(fast, sep(22), HOU, 5600, -1);
    await haul(slow, sep(9), NASH, 2400, -1);
    await haul(slow, sep(16), NASH, 2600, 5);

    now = Date.parse("2026-10-01T12:00:00Z");
    const a = await S.get(`/v1/orgs/${acme.id}/analytics?days=30`);
    expect(a.totals).toMatchObject({ loads: 5, spend: 21200, onTimeDelivery: 0.8, onTimePickup: 1, damageFree: 1 });
    expect(a.totals.costPerMile).toBeCloseTo(a.totals.spend / a.totals.miles, 2);
    expect(a.previous).toMatchObject({ loads: 0, spend: 0 });
    expect(a.byCarrier.map((c: { name: string; loads: number; onTimeDelivery: number }) => [c.name, c.loads, c.onTimeDelivery])).toEqual([["Fast Freight", 3, 1], ["Slow Lines", 2, 0.5]]);
    expect(a.byLane.map((l: { lane: string; loads: number; averageRate: number }) => [l.lane, l.loads, l.averageRate])).toEqual([["Bronx, NY → Houston, TX", 3, 5400], ["Bronx, NY → Nashville, TN", 2, 2500]]);
    for (const l of a.byLane) expect(l.costPerMile).toBeCloseTo(l.spend / l.miles, 2);
    // Every week in the period, empty ones included.
    expect(a.weekly.map((w: { weekStart: string }) => w.weekStart)).toEqual(["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
    expect(a.weekly.map((w: { loads: number }) => w.loads)).toEqual([0, 2, 2, 1, 0]);
    expect(a.weekly[3].costPerMile).toBeGreaterThan(a.weekly[1].costPerMile * 0.5);

    await S.get(`/v1/orgs/${acme.id}/analytics?days=45`, 400);
    await fast.F.get(`/v1/orgs/${acme.id}/analytics`, 403);
    await fast.D.get(`/v1/orgs/${acme.id}/analytics`, 403);
  });
});
