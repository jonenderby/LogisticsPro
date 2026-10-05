import { StaticGeocoder } from "@logisticspro/navigation";
import { describe, expect, it } from "vitest";
import { HOU, NYC, api, harness, loadBody, signUp } from "./helpers.js";

const geocoder = new StaticGeocoder([
  { match: "600 food center", result: { label: "600 Food Center Dr, Bronx, NY 10474", line1: "600 Food Center Dr", city: "Bronx", state: "NY", postalCode: "10474", country: "US", geo: NYC.geo } },
  { match: "post oak", result: { label: "2800 Post Oak Blvd, Houston, TX 77056", line1: "2800 Post Oak Blvd", city: "Houston", state: "TX", postalCode: "77056", country: "US", geo: HOU.geo } },
  { match: "pilot travel center", result: { label: "Pilot Travel Center, Carneys Point, NJ", city: "Carneys Point", state: "NJ", country: "US", geo: { lat: 39.69, lng: -75.47 } } },
]);
const noGeo = ({ geo: _g, ...a }: typeof NYC) => a;

describe("addresses and navigation", () => {
  it("places stops on the map from their addresses and warns about ones it can't find", async () => {
    const h = await harness({ geocoder });
    const S = api(h, await signUp(h, "BUSINESS", "Geo Shipper"));
    const org = (await S.post("/v1/orgs", { name: "Geo Co", kinds: ["SHIPPER"] })).org;
    const stops = loadBody(org.id).stops.map((s: { address: typeof NYC }) => ({ ...s, address: noGeo(s.address) }));
    const load = await S.post("/v1/loads", loadBody(org.id, { stops }), 201);
    expect(load.stops.map((s: { address: { geo?: unknown } }) => s.address.geo)).toEqual([NYC.geo, HOU.geo]);
    expect(load.warnings).toBeUndefined();

    const unknown = { ...stops[1]!, address: { ...stops[1]!.address, line1: "1 Nowhere Ln", name: "Mystery" } };
    const partial = await S.post("/v1/loads", loadBody(org.id, { stops: [stops[0], unknown] }), 201);
    expect(partial.warnings).toEqual(["Stop 2 (delivery): address not found on the map"]);

    const results = await S.get("/v1/geocode?q=pilot%20travel%20center");
    expect(results[0]).toMatchObject({ city: "Carneys Point", geo: { lat: 39.69 } });
  });

  it("routes a driver to any address, but not an oversize load", async () => {
    const h = await harness({ geocoder });
    const D = api(h, await signUp(h, "TRUCKER", "Nav Driver"));
    const r = await D.post("/v1/navigation/route", { from: { lat: 39.7, lng: -75.6 }, to: { query: "Pilot Travel Center" } });
    expect(r.destination.label).toBe("Pilot Travel Center, Carneys Point, NJ");
    expect(r.route.geometry.length).toBe(2);
    expect((await D.post("/v1/navigation/route", { from: { lat: 39.7, lng: -75.6 }, to: { query: "nothing matches" } }, 404)).error.code).toBe("NOT_FOUND");
  });

  it("explains when address search is not configured", async () => {
    const h = await harness();
    const S = api(h, await signUp(h, "BUSINESS", "No Geo"));
    expect((await S.get("/v1/geocode?q=600%20food%20center", 503)).error.code).toBe("GEOCODER_UNAVAILABLE");
    const org = (await S.post("/v1/orgs", { name: "NoGeo Co", kinds: ["SHIPPER"] })).org;
    const stops = loadBody(org.id).stops.map((s: { address: typeof NYC }) => ({ ...s, address: noGeo(s.address) }));
    const load = await S.post("/v1/loads", loadBody(org.id, { stops }), 201);
    expect(load.warnings).toHaveLength(2);
  });
});
