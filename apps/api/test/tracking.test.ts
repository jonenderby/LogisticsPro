import { describe, expect, it } from "vitest";
import { HOU, NYC, type Session, api, harness, loadBody, signUp } from "./helpers.js";

// Clock: 2026-10-08 15:00Z. Loads deliver to Houston 10-08 14:00-18:00Z.
const NOW = Date.parse("2026-10-08T15:00:00Z");
const nearHouston = (miles: number) => ({ lat: HOU.geo.lat + miles / 69.05, lng: HOU.geo.lng });

async function world() {
  const h = await harness({ now: () => new Date(NOW) });
  const S = api(h, await signUp(h, "BUSINESS", "Shipper Sam"));
  const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
  const F = api(h, await signUp(h, "CARRIER", "Dispatch Dee"));
  const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"], scac: "BIGF" })).org;
  const drivers: Array<Session & { api: ReturnType<typeof api> }> = [];
  for (const n of ["Ana", "Ben", "Cal", "Dot", "Eve"]) {
    const d = await signUp(h, "TRUCKER", n);
    await F.post(`/v1/orgs/${fleet.id}/members`, { email: d.email, roles: ["DRIVER"] }, 201);
    drivers.push({ ...d, api: api(h, d) });
  }
  const book = async (driver: (typeof drivers)[number]) => {
    const load = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
    await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
    await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [driver.accountId] });
    return load;
  };
  const [ana, ben, cal, dot] = drivers;
  // Ana: moving, 40 miles out, location just now -> on time.
  const onTime = await book(ana!);
  await ana!.api.post(`/v1/loads/${onTime.id}/status`, { code: "LOADED", at: "2026-10-06T14:00:00Z", geo: NYC.geo });
  await ana!.api.post("/v1/me/location", { ...nearHouston(40), at: "2026-10-08T14:58:00Z", speedMps: 27 });
  // Ben: moving, but his phone went quiet four hours ago -> at risk.
  const quiet = await book(ben!);
  await ben!.api.post(`/v1/loads/${quiet.id}/status`, { code: "LOADED", at: "2026-10-06T14:00:00Z" });
  await ben!.api.post("/v1/me/location", { ...nearHouston(40), at: "2026-10-08T11:00:00Z" });
  // Cal: never picked up and the pickup window passed two days ago -> late.
  const missed = await book(cal!);
  // Dot: no load, location fresh -> available. Eve: nothing -> offline.
  await dot!.api.post("/v1/me/location", { lat: 32.78, lng: -96.8, at: "2026-10-08T14:30:00Z" });
  return { h, S, F, fleet, drivers, onTime, quiet, missed };
}

describe("live tracking", () => {
  it("shows a carrier every truck under its umbrella with load and arrival status", async () => {
    const { F, onTime, quiet, missed } = await world();
    const fleet = await F.get("/v1/tracking/fleet");
    expect(fleet.trucks).toEqual({ total: 5, onLoad: 3, otherCarrier: 0, available: 1, offline: 1 });
    expect(fleet.summary).toMatchObject({ LATE: 1, AT_RISK: 1, ON_TIME: 1 });
    expect(fleet.drivers.map((d: { name: string; state: string; load?: { loadNumber: string; eta: { status: string } } }) => [d.name, d.state, d.load?.loadNumber, d.load?.eta.status])).toEqual([
      ["Cal", "ON_LOAD", missed.loadNumber, "LATE"],
      ["Ben", "ON_LOAD", quiet.loadNumber, "AT_RISK"],
      ["Ana", "ON_LOAD", onTime.loadNumber, "ON_TIME"],
      ["Dot", "AVAILABLE", undefined, undefined],
      ["Eve", "OFFLINE", undefined, undefined],
    ]);
    const ana = fleet.drivers.find((d: { name: string }) => d.name === "Ana");
    expect(ana.position).toMatchObject({ speedMps: 27, stale: false });
    expect(ana.load.eta.reasons).toEqual(["On track for the delivery window"]);
    const ben = fleet.drivers.find((d: { name: string }) => d.name === "Ben");
    expect(ben.load.eta.reasons).toContain("No location update for 4 h");
  });

  it("shows a shipper every undelivered shipment with ETA and status, most urgent first", async () => {
    const { S, onTime, quiet, missed } = await world();
    const t = await S.get("/v1/tracking/shipments");
    expect(t.summary).toEqual({ LATE: 1, AT_RISK: 1, ON_TIME: 1, EARLY: 0, UNKNOWN: 0 });
    expect(t.shipments.map((s: { loadNumber: string; eta: { status: string } }) => [s.loadNumber, s.eta.status])).toEqual([
      [missed.loadNumber, "LATE"],
      [quiet.loadNumber, "AT_RISK"],
      [onTime.loadNumber, "ON_TIME"],
    ]);
    const live = t.shipments.find((s: { loadNumber: string }) => s.loadNumber === onTime.loadNumber);
    expect(live).toMatchObject({ carrierName: "Big Fleet", origin: "Bronx, NY", destination: "Houston, TX", truck: { stale: false }, eta: { etaSource: "COMPUTED", window: { end: "2026-10-08T18:00:00Z" } } });
    expect(Date.parse(live.eta.eta)).toBeLessThan(Date.parse("2026-10-08T18:00:00Z"));
    // Not moving yet: no truck position is shared with the shipper.
    expect(t.shipments.find((s: { loadNumber: string }) => s.loadNumber === missed.loadNumber).truck).toBeUndefined();

    const feed = (await S.get("/v1/me")).feed.map((i: { title: string }) => i.title);
    expect(feed).toContain(`${missed.loadNumber} will be late`);
    expect(feed).toContain(`${quiet.loadNumber} is at risk of arriving late`);
  });

  it("keeps fleets and shipments private and validates locations", async () => {
    const { h, S, F, drivers } = await world();
    const other = api(h, await signUp(h, "BUSINESS", "Other Shipper"));
    await other.post("/v1/orgs", { name: "Other Co", kinds: ["SHIPPER"] }, 201);
    expect((await other.get("/v1/tracking/shipments")).shipments).toEqual([]);
    await S.get("/v1/tracking/fleet", 403);
    await drivers[0]!.api.get("/v1/tracking/fleet", 403);
    await F.get("/v1/tracking/shipments", 403);
    await S.post("/v1/me/location", { lat: 1, lng: 1 }, 403);
    await drivers[0]!.api.post("/v1/me/location", { lat: 1, lng: 1, at: "2026-10-09T15:00:00Z" }, 400);
  });

  it("shows a driver shared with another carrier as busy, without location, while hauling for that carrier", async () => {
    const { h, drivers } = await world();
    const O = api(h, await signUp(h, "CARRIER", "Other Owner"));
    const other = (await O.post("/v1/orgs", { name: "Other Fleet", kinds: ["CARRIER"], scac: "OTHR" })).org;
    await O.post(`/v1/orgs/${other.id}/members`, { email: drivers[0]!.email, roles: ["DRIVER"] }, 201);
    await O.post(`/v1/orgs/${other.id}/members`, { email: drivers[3]!.email, roles: ["DRIVER"] }, 201);
    const fleet = await O.get("/v1/tracking/fleet");
    const ana = fleet.drivers.find((d: { name: string }) => d.name === "Ana")!;
    expect(ana).toMatchObject({ state: "OTHER_CARRIER" });
    expect(ana.position).toBeUndefined();
    expect(ana.load).toBeUndefined();
    // Dot is free, so either carrier can see where she is.
    expect(fleet.drivers.find((d: { name: string }) => d.name === "Dot")).toMatchObject({ state: "AVAILABLE" });
    expect(fleet.trucks).toMatchObject({ total: 2, otherCarrier: 1, available: 1 });
  });

  it("gives each party on a load its arrival estimate, and nobody else", async () => {
    const { h, S, F, drivers, onTime } = await world();
    const forShipper = await S.get(`/v1/loads/${onTime.id}/tracking`);
    expect(forShipper.eta.status).toBe("ON_TIME");
    expect(forShipper.truck.geo.lat).toBeCloseTo(nearHouston(40).lat, 3);
    expect((await F.get(`/v1/loads/${onTime.id}/tracking`)).loadNumber).toBe(onTime.loadNumber);
    expect((await drivers[0]!.api.get(`/v1/loads/${onTime.id}/tracking`)).eta.status).toBe("ON_TIME");
    await drivers[1]!.api.get(`/v1/loads/${onTime.id}/tracking`, 404);
    await api(h, await signUp(h, "BUSINESS", "Nosy")).get(`/v1/loads/${onTime.id}/tracking`, 404);
  });

  it("updates a driver's position from status updates and carrier-reported ETAs", async () => {
    const { F, drivers, quiet } = await world();
    await drivers[1]!.api.post(`/v1/loads/${quiet.id}/status`, { code: "DELAYED", reason: "WEATHER", eta: "2026-10-08T19:30:00Z", geo: nearHouston(60), at: "2026-10-08T14:59:00Z" });
    const ben = (await F.get("/v1/tracking/fleet")).drivers.find((d: { name: string }) => d.name === "Ben");
    expect(ben.position).toMatchObject({ at: "2026-10-08T14:59:00.000Z".replace(".000", ""), stale: false });
    expect(ben.load.eta).toMatchObject({ status: "LATE", etaSource: "CARRIER", eta: "2026-10-08T19:30:00.000Z" });
  });
});
