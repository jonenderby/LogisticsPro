import type { GeoPoint } from "@logisticspro/domain";
import type { RoutingProvider, TrafficProvider } from "@logisticspro/navigation";
import { describe, expect, it } from "vitest";
import { refreshRoutes } from "../src/services/routes.js";
import { HOU, NYC, api, harness, loadBody, signUp } from "./helpers.js";

// Houston delivery window 2026-10-08 14:00-18:00Z (see loadBody).
const near = (miles: number) => ({ lat: HOU.geo.lat + miles / 69.05, lng: HOU.geo.lng });

async function world(opts: { routing?: RoutingProvider; traffic?: TrafficProvider } = {}) {
  let now = Date.parse("2026-10-08T08:00:00Z");
  const h = await harness({ now: () => new Date(now), ...opts });
  const at = (iso: string) => (now = Date.parse(iso));
  const S = api(h, await signUp(h, "BUSINESS", "Shipper Sam"));
  const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
  const F = api(h, await signUp(h, "CARRIER", "Dispatch Dee"));
  const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"], scac: "BIGF" })).org;
  const ana = await signUp(h, "TRUCKER", "Ana");
  await F.post(`/v1/orgs/${fleet.id}/members`, { email: ana.email, roles: ["DRIVER"] }, 201);
  const A = api(h, ana);
  const load = await S.post("/v1/loads", loadBody(acme.id), 201);
  await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
  await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
  await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [ana.accountId] });
  await A.post(`/v1/loads/${load.id}/status`, { code: "LOADED", at: "2026-10-06T14:00:00Z" });
  const eta = async () => (await S.get(`/v1/loads/${load.id}/tracking`)).eta;
  return { h, at: (iso: string) => at(iso), now: () => now, S, A, load, eta };
}

describe("ETAs from the driver's real hours", () => {
  it("adds the 10-hour rest a driver out of hours must take", async () => {
    const { at, A, eta } = await world();
    // 200 miles out at 08:00, fresh driver: about 4 h 45 min, so early for the 14:00 window.
    await A.post("/v1/me/location", { ...near(200), speedMps: 0 });
    expect(await eta()).toMatchObject({ status: "EARLY" });

    // Ana has been driving since 21:30 yesterday with a break: 1 h 30 min of her 11 hours left.
    at("2026-10-07T21:00:00Z");
    await A.post("/v1/me/duty-status", { status: "ON_DUTY" });
    at("2026-10-07T21:30:00Z");
    await A.post("/v1/me/duty-status", { status: "DRIVING" });
    at("2026-10-08T05:30:00Z");
    await A.post("/v1/me/duty-status", { status: "ON_DUTY" });
    at("2026-10-08T06:00:00Z");
    await A.post("/v1/me/duty-status", { status: "DRIVING" });
    at("2026-10-08T07:30:00Z");
    await A.post("/v1/me/duty-status", { status: "ON_DUTY" });
    at("2026-10-08T08:00:00Z");
    await A.post("/v1/me/location", { ...near(200), speedMps: 0 });
    const e = await eta();
    expect(e.status).toBe("LATE");
    expect(e.reasons).toContain("Includes a 10-hour rest under driving-hour rules");
  });

  it("uses the routing server's distance and time when it has a route", async () => {
    const calls: GeoPoint[][] = [];
    const routing: RoutingProvider = {
      async route(waypoints) {
        calls.push(waypoints);
        return { geometry: waypoints, distanceM: 300 * 1609.344, durationS: 6 * 3600, maneuvers: [], source: "valhalla" };
      },
    };
    const { h, A, eta } = await world({ routing });
    await A.post("/v1/me/location", { ...near(200), speedMps: 20 });
    expect((await eta()).remainingMiles).toBe(Math.round(200 * 1.18));
    expect(await refreshRoutes(h.ctx)).toBe(1);
    expect(calls[0]).toHaveLength(2);
    const e = await eta();
    // 300 routed miles taking 6 h: 08:00 + 6 h (no rests for a fresh driver) = 14:00.
    expect(e.remainingMiles).toBe(300);
    expect(e.eta).toBe("2026-10-08T14:00:00.000Z");
    // Not re-routed until 30 minutes or 50 miles later.
    expect(await refreshRoutes(h.ctx)).toBe(0);
  });

  it("uses live traffic when a traffic provider is set up, and says what traffic adds", async () => {
    let fail = false;
    const asked: string[] = [];
    const traffic: TrafficProvider = {
      name: "here",
      async travelTime(waypoints, _truck, departAt) {
        asked.push(departAt);
        if (fail) throw new Error("HERE is down");
        return { distanceM: 300 * 1609.344, durationS: 6.5 * 3600, trafficDelayS: 40 * 60, source: "here" };
      },
    };
    const routing: RoutingProvider = {
      async route(waypoints) {
        return { geometry: waypoints, distanceM: 290 * 1609.344, durationS: 5 * 3600, maneuvers: [], source: "valhalla" };
      },
    };
    const { h, at, A, eta } = await world({ traffic, routing });
    await A.post("/v1/me/location", { ...near(200), speedMps: 20 });
    expect(await refreshRoutes(h.ctx)).toBe(1);
    let e = await eta();
    // 6 h 30 min with traffic from 08:00.
    expect(e.eta).toBe("2026-10-08T14:30:00.000Z");
    expect(e.reasons).toContain("Traffic adds about 40 min");
    expect(h.ctx.store.routeEstimates.get([...h.ctx.store.routeEstimates.keys()][0]!)).toMatchObject({ source: "here", trafficDelayMinutes: 40 });

    // Traffic is refreshed after 15 minutes, not 30.
    at("2026-10-08T08:10:00Z");
    expect(await refreshRoutes(h.ctx)).toBe(0);
    at("2026-10-08T08:16:00Z");
    await A.post("/v1/me/location", { ...near(200), speedMps: 20 });
    // When the traffic provider fails, the routing server's time is used.
    fail = true;
    expect(await refreshRoutes(h.ctx)).toBe(1);
    e = await eta();
    expect(h.ctx.store.routeEstimates.get([...h.ctx.store.routeEstimates.keys()][0]!)).toMatchObject({ source: "valhalla" });
    expect(e.reasons).not.toContain("Traffic adds about 40 min");
    expect(asked).toHaveLength(2);
  });
});
