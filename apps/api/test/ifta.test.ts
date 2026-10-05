import { describe, expect, it } from "vitest";
import { NYC, api, harness, loadBody, signUp } from "./helpers.js";

describe("fuel tax miles", () => {
  it("credits miles to each state from the truck's trail and reports the quarter", async () => {
    let now = Date.parse("2026-10-06T14:00:00Z");
    const h = await harness({ now: () => new Date(now) });
    const S = api(h, await signUp(h, "BUSINESS", "Shipper Sam"));
    const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
    const olga = await signUp(h, "CARRIER", "Owner Olga");
    const F = api(h, olga);
    const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"], scac: "BIGF" })).org;
    const ana = await signUp(h, "TRUCKER", "Ana");
    await F.post(`/v1/orgs/${fleet.id}/members`, { email: ana.email, roles: ["DRIVER"] }, 201);
    const A = api(h, ana);
    const load = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
    await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
    await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [ana.accountId], tractorId: "112" });

    // West out of Memphis at 50 mph for an hour: a few miles in Tennessee, the rest in Arkansas.
    const step = 50 / 12 / (69.05 * Math.cos((35.15 * Math.PI) / 180));
    for (let i = 0; i <= 12; i++) {
      now = Date.parse("2026-10-06T14:00:00Z") + i * 5 * 60_000;
      await A.post("/v1/me/location", { lat: 35.15, lng: -90.0 - i * step, speedMps: 22.35 });
    }
    // Parked: drift does not count.
    now += 10 * 60_000;
    await A.post("/v1/me/location", { lat: 35.1501, lng: -90.0 - 12 * step, speedMps: 0 });

    const day = h.ctx.store.jurisdictionMiles.get(`${fleet.id}|unit:112|2026-10-06`)!;
    expect(day.vehicleLabel).toBe("Unit 112");
    expect(Object.keys(day.miles).sort()).toEqual(["AR", "TN"]);
    expect(day.miles.TN! + day.miles.AR!).toBeCloseTo(50, 0);
    expect(day.miles.TN!).toBeGreaterThan(3);
    expect(day.miles.TN!).toBeLessThan(12);

    // Fuel: entered by the driver, for her truck.
    await A.post(`/v1/orgs/${fleet.id}/fuel-purchases`, { date: "2026-10-06", jurisdiction: "AR", gallons: 8.33, amount: 31.5, vendor: "Love's" }, 201);
    await A.post(`/v1/orgs/${fleet.id}/fuel-purchases`, { date: "2026-10-06", jurisdiction: "ZZ", gallons: 5 }, 400);
    await A.post(`/v1/orgs/${fleet.id}/fuel-purchases`, { date: "2026-12-01", jurisdiction: "AR", gallons: 5 }, 400);
    // The office picks the truck; it can't log fuel to a truck nobody drives.
    expect(await F.get(`/v1/orgs/${fleet.id}/fuel-vehicles`)).toEqual([
      { vehicle: `driver:${ana.accountId}`, label: "Ana's truck" },
      { vehicle: "unit:112", label: "Unit 112" },
    ]);
    await F.post(`/v1/orgs/${fleet.id}/fuel-purchases`, { date: "2026-10-06", jurisdiction: "TN", gallons: 1 }, 400);
    await F.post(`/v1/orgs/${fleet.id}/fuel-purchases`, { date: "2026-10-06", jurisdiction: "TN", gallons: 1, vehicle: `driver:${olga.accountId}` }, 400);
    await F.post(`/v1/orgs/${fleet.id}/fuel-purchases`, { date: "2026-10-06", jurisdiction: "TN", gallons: 1, vehicle: "112; drop" }, 400);
    await A.post(`/v1/orgs/${fleet.id}/fuel-purchases`, { date: "2026-10-06", jurisdiction: "TN", gallons: 1, vehicle: `driver:${olga.accountId}` }, 403);
    await A.get(`/v1/orgs/${fleet.id}/fuel-vehicles`, 403);
    expect(await F.post(`/v1/orgs/${fleet.id}/fuel-purchases`, { date: "2026-10-06", jurisdiction: "TN", gallons: 1.67, vehicle: "unit:112" }, 201)).toMatchObject({ vehicle: "unit:112", vehicleLabel: "Unit 112" });

    const report = await F.get(`/v1/orgs/${fleet.id}/ifta?quarter=2026-Q4`);
    expect(report).toMatchObject({ quarter: "2026-Q4", totalMiles: 50, totalGallons: 10, mpg: 5 });
    expect(report.rows.map((r: { jurisdiction: string; member: boolean; name: string }) => [r.jurisdiction, r.name, r.member])).toEqual([
      ["AR", "Arkansas", true],
      ["TN", "Tennessee", true],
    ]);
    expect(report.vehicles).toEqual([{ vehicle: "unit:112", label: "Unit 112", miles: 50, gallons: 10 }]);
    const csv = await h.app.inject({ method: "GET", url: `/v1/orgs/${fleet.id}/ifta?quarter=2026-Q4&format=csv`, headers: { authorization: `Bearer ${olga.token}` } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[2]).toMatch(/^AR,Arkansas,yes,\d+,[\d.]+,8\.33,/);
    expect(csv.body.split("\n")[3]).toMatch(/^TN,Tennessee,yes,\d+,[\d.]+,1\.67,/);
    // Drivers enter fuel but don't see the company's tax report.
    await A.get(`/v1/orgs/${fleet.id}/ifta`, 403);
    expect(await A.get(`/v1/orgs/${fleet.id}/fuel-purchases?quarter=2026-Q4`)).toHaveLength(1);
    await S.get(`/v1/orgs/${fleet.id}/fuel-purchases`, 403);
  });

  it("counts a team truck's miles once, from whichever phone is reporting", async () => {
    let now = Date.parse("2026-10-06T14:00:00Z");
    const h = await harness({ now: () => new Date(now) });
    const S = api(h, await signUp(h, "BUSINESS", "Shipper Sam"));
    const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
    const F = api(h, await signUp(h, "CARRIER", "Owner Olga"));
    const fleet = (await F.post("/v1/orgs", { name: "Team Fleet", kinds: ["CARRIER"], scac: "TEMF" })).org;
    const ana = await signUp(h, "TRUCKER", "Ana");
    const ben = await signUp(h, "TRUCKER", "Ben");
    for (const d of [ana, ben]) await F.post(`/v1/orgs/${fleet.id}/members`, { email: d.email, roles: ["DRIVER"] }, 201);
    const load = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
    await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
    await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [ana.accountId, ben.accountId] });
    const [A, B] = [api(h, ana), api(h, ben)];

    // Both phones ride along through Arkansas for an hour.
    const step = 50 / 12 / (69.05 * Math.cos((34.75 * Math.PI) / 180));
    const at = (i: number) => ({ lat: 34.75, lng: -92.0 - i * step, speedMps: 22.35 });
    for (let i = 0; i <= 12; i++) {
      now = Date.parse("2026-10-06T14:00:00Z") + i * 5 * 60_000;
      await A.post("/v1/me/location", at(i));
      await B.post("/v1/me/location", at(i));
    }
    const key = `${fleet.id}|driver:${ana.accountId}|2026-10-06`;
    expect(h.ctx.store.jurisdictionMiles.get(key)!.miles.AR).toBeCloseTo(50, 0);
    expect([...h.ctx.store.jurisdictionMiles.keys()]).toEqual([key]);

    // Ana's phone dies; after ten quiet minutes Ben's phone carries on.
    for (let i = 13; i <= 24; i++) {
      now = Date.parse("2026-10-06T14:00:00Z") + i * 5 * 60_000;
      await B.post("/v1/me/location", at(i));
    }
    expect(h.ctx.store.jurisdictionMiles.get(key)!.miles.AR).toBeGreaterThan(85);
    expect(h.ctx.store.jurisdictionMiles.get(key)!.miles.AR).toBeLessThan(100);
  });
});
