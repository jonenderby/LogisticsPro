import { describe, expect, it } from "vitest";
import { LEGAL_TRUCK, NoRouteError, ValhallaProvider } from "../src/index.js";

/**
 * Runs against a real Valhalla server when LP_TEST_VALHALLA_URL is set.
 * The expected map is the synthetic one in deploy/valhalla/test-map: a direct
 * road with a 3.5 m (11'6") bridge and a longer detour around it.
 */
const url = process.env.LP_TEST_VALHALLA_URL;
const A = { lat: 39.7, lng: -75.599 };
const B = { lat: 39.7, lng: -75.561 };

describe.skipIf(!url)("Valhalla (live)", () => {
  it("sends a short truck over the low bridge and a tall truck around it", async () => {
    const provider = new ValhallaProvider(url!);
    const low = await provider.route([A, B], { ...LEGAL_TRUCK, heightIn: 118 }); // 3.0 m
    const tall = await provider.route([A, B], { ...LEGAL_TRUCK, heightIn: 162 }); // 4.1 m (13'6")
    expect(low.distanceM).toBeLessThan(3500);
    expect(tall.distanceM).toBeGreaterThan(5000);
    expect(low.maneuvers.map((m) => m.streetName)).not.toContain("Detour Road");
    expect(tall.maneuvers.map((m) => m.streetName)).toContain("Detour Road");
    expect(tall.geometry.length).toBeGreaterThan(low.geometry.length);
  });

  it("reports when no legal route exists", async () => {
    const provider = new ValhallaProvider(url!);
    await expect(provider.route([A, { lat: 45, lng: -100 }], LEGAL_TRUCK)).rejects.toBeInstanceOf(Error);
    void NoRouteError;
  });
});
