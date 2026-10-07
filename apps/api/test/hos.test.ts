import { describe, expect, it } from "vitest";
import { NYC, api, harness, loadBody, signUp } from "./helpers.js";

async function world() {
  let now = Date.parse("2026-10-08T06:00:00Z");
  const h = await harness({ now: () => new Date(now) });
  const at = (iso: string) => (now = Date.parse(iso));
  const S = api(h, await signUp(h, "BUSINESS", "Shipper Sam"));
  const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
  const F = api(h, await signUp(h, "CARRIER", "Dispatch Dee"));
  const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"], scac: "BIGF" })).org;
  const ana = await signUp(h, "TRUCKER", "Ana");
  const ben = await signUp(h, "TRUCKER", "Ben");
  for (const d of [ana, ben]) await F.post(`/v1/orgs/${fleet.id}/members`, { email: d.email, roles: ["DRIVER"] }, 201);
  return { h, at, S, acme, F, fleet, ana, ben, A: api(h, ana), B: api(h, ben) };
}

// A ping every 5 minutes heading north at 50 mph: 50/12 miles = 0.0603 degrees of latitude.
const ping = (A: ReturnType<typeof api>, i: number, minute: string, moving = true) =>
  A.post("/v1/me/location", { lat: 30 + (moving ? i : 0) * (50 / 12 / 69.05), lng: -95, at: minute, ...(moving ? { speedMps: 22.35 } : { speedMps: 0 }) });
const iso = (base: string, plusMin: number) => new Date(Date.parse(base) + plusMin * 60_000).toISOString();

describe("hours of service", () => {
  it("starts rested and lets the driver go on duty", async () => {
    const { A, S } = await world();
    expect(await A.get("/v1/me/hos")).toMatchObject({ status: "OFF_DUTY", drivingLeftMin: 660, windowLeftMin: 840, availableMin: 480, limitedBy: "BREAK", milesThisShift: 0, milesLeft: 400, avgMphSource: "DEFAULT", log: [] });
    const on = await A.post("/v1/me/duty-status", { status: "ON_DUTY", note: "Pre-trip inspection" });
    expect(on).toMatchObject({ status: "ON_DUTY", shiftStart: "2026-10-08T06:00:00.000Z" });
    expect((await A.get("/v1/me")).hos).toMatchObject({ status: "ON_DUTY", teamTruck: false });
    await S.get("/v1/me/hos", 403);
    await S.post("/v1/me/duty-status", { status: "DRIVING" }, 403);
  });

  it("switches to driving when the truck moves and back to on duty after 5 minutes stopped, and counts the miles", async () => {
    const { at, A, F } = await world();
    await A.post("/v1/me/duty-status", { status: "ON_DUTY" });
    // Rolls at 06:30 and drives two hours.
    const start = "2026-10-08T06:30:00Z";
    for (let i = 0; i <= 24; i++) {
      at(iso(start, i * 5));
      await ping(A, i, iso(start, i * 5));
    }
    // Stops at 08:30 for fuel; pings while stopped.
    for (const m of [125, 130, 135]) {
      at(iso(start, m));
      await A.post("/v1/me/location", { lat: 30 + 24 * (50 / 12 / 69.05), lng: -95, at: iso(start, m), speedMps: 0 });
    }
    const hos = await A.get("/v1/me/hos");
    expect(hos.log.map((e: { status: string; source: string }) => `${e.status}/${e.source}`)).toEqual(["ON_DUTY/AUTO", "DRIVING/AUTO", "ON_DUTY/DRIVER"]);
    expect(hos.log[0].at).toBe("2026-10-08T08:35:00.000Z");
    expect(hos).toMatchObject({ status: "ON_DUTY", drivingUsedMin: 125, drivingLeftMin: 535, breakLeftMin: 355, avgMphSource: "SHIFT" });
    expect(hos.milesThisShift).toBeCloseTo(100, 0);
    expect(hos.avgMph).toBe(48);
    expect(hos.milesLeft).toBe(Math.round((355 / 60) * 48));

    // Dispatch sees Ana's hours on the fleet view.
    const fleet = await F.get("/v1/tracking/fleet");
    expect(fleet.drivers.find((d: { name: string }) => d.name === "Ana").hos).toMatchObject({ status: "ON_DUTY", availableMin: 355, limitedBy: "BREAK" });
  });

  it("takes a batch of fixes collected in the background, in any order", async () => {
    const { at, A } = await world();
    const start = "2026-10-08T06:30:00Z";
    const fixes = Array.from({ length: 25 }, (_, i) => ({ lat: 30 + i * (50 / 12 / 69.05), lng: -95, at: iso(start, i * 5), speedMps: 22.35 })).reverse();
    at(iso(start, 125));
    expect(await A.post("/v1/me/locations", { fixes })).toMatchObject({ duty: { status: "DRIVING" } });
    const hos = await A.get("/v1/me/hos");
    expect(hos.milesThisShift).toBeCloseTo(100, 0);
    expect(hos.log.map((e: { status: string; source: string }) => `${e.status}/${e.source}`)).toEqual(["DRIVING/AUTO"]);
    await A.post("/v1/me/locations", { fixes: [] }, 400);
  });

  it("leaves duty status to the drivers on a team truck", async () => {
    const { at, S, acme, F, fleet, ana, ben, A } = await world();
    const load = await S.post("/v1/loads", loadBody(acme.id, { teamRequired: true }), 201);
    await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
    await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
    await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [ana.accountId, ben.accountId] });
    for (let i = 0; i <= 3; i++) {
      at(iso("2026-10-08T06:30:00Z", i * 5));
      await ping(A, i, iso("2026-10-08T06:30:00Z", i * 5));
    }
    expect((await A.get("/v1/me/hos")).status).toBe("OFF_DUTY");
    // The app offers "I'm the passenger" instead of locking a team driver out.
    expect((await A.get("/v1/me")).hos).toMatchObject({ teamTruck: true });
  });

  it("uses the 60-hour cycle when the driver's carrier runs 7 days", async () => {
    const { A } = await world();
    expect((await A.put("/v1/me/hos-settings", { cycle: "60/7" })).cycleLeftMin).toBe(3600);
    await A.put("/v1/me/hos-settings", { cycle: "80/8" }, 400);
  });
});
