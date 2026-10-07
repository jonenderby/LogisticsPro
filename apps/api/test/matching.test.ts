import { describe, expect, it } from "vitest";
import { NYC, api, harness, loadBody, signUp } from "./helpers.js";

const NASHVILLE = { name: "Nashville Yard", line1: "1 Yard Rd", city: "Nashville", state: "TN", postalCode: "37210", country: "US", geo: { lat: 36.1447, lng: -86.7341 } };

describe("board suggestions", () => {
  it("shows a driver the loads they can legally take, best per mile first", async () => {
    const h = await harness({ now: () => new Date("2026-10-06T07:00:00Z") });
    const S = api(h, await signUp(h, "BUSINESS", "Shipper Sam"));
    const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
    // Nashville to Houston: reachable from Memphis. New York to Houston: too far for a solo driver.
    const base = loadBody(acme.id);
    const near = await S.post("/v1/loads", { ...base, stops: [{ ...base.stops[0], address: NASHVILLE }, base.stops[1]], rate: { amount: 2600, currency: "USD" } }, 201);
    const far = await S.post("/v1/loads", base, 201);
    for (const l of [near, far]) await S.post(`/v1/loads/${l.id}/post`, {});

    // An owner-operator: drives and dispatches their own truck.
    const ollie = await signUp(h, "TRUCKER", "Ollie Owner");
    const O = api(h, ollie);
    await O.post("/v1/orgs", { name: "Ollie Trucking", kinds: ["CARRIER"], scac: "OLLY" });
    await O.get("/v1/board/suggestions", 409); // no location yet
    await O.post("/v1/me/location", { lat: 35.15, lng: -90.05 });
    const mine = await O.get("/v1/board/suggestions");
    expect(mine.driver.name).toBe("Ollie Owner");
    expect(mine.suggestions.map((s: { loadNumber: string; feasible: boolean }) => [s.loadNumber, s.feasible])).toEqual([
      [near.loadNumber, true],
      [far.loadNumber, false],
    ]);
    expect(mine.suggestions[0]).toMatchObject({ origin: "Nashville, TN", destination: "Houston, TX", deadheadMiles: 234, reasons: ["Includes a 10-hour rest on the way"] });

    // A dispatcher plans for a driver from a chosen point; outsiders cannot.
    const D = api(h, await signUp(h, "CARRIER", "Dispatch Dee"));
    const fleet = (await D.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"], scac: "BIGF" })).org;
    const ana = await signUp(h, "TRUCKER", "Ana");
    await D.post(`/v1/orgs/${fleet.id}/members`, { email: ana.email, roles: ["DRIVER"] }, 201);
    const forAna = await D.get(`/v1/board/suggestions?driverAccountId=${ana.accountId}&lat=40.75&lng=-73.99&team=true`);
    expect(forAna.from.source).toBe("CHOSEN");
    expect(forAna.suggestions.find((s: { loadNumber: string }) => s.loadNumber === far.loadNumber).feasible).toBe(true);
    await D.get(`/v1/board/suggestions?driverAccountId=${ollie.accountId}&lat=1&lng=1`, 403);
    await S.get("/v1/board/suggestions", 403);
  });
});
