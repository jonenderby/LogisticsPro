import { describe, expect, it } from "vitest";
import { HereTrafficProvider, LEGAL_TRUCK, NoRouteError, TomTomTrafficProvider } from "../src/index.js";

const A = { lat: 32.3, lng: -90.18 };
const B = { lat: 33.5, lng: -90.2 };
const C = { lat: 35.15, lng: -90.05 };
const reply = (body: unknown, ok = true) => async (url: string) => {
  urls.push(url);
  return { ok, status: ok ? 200 : 429, json: async () => body };
};
let urls: string[] = [];

describe("live traffic providers", () => {
  it("HERE: sums sections; traffic delay is duration over base duration", async () => {
    urls = [];
    const here = new HereTrafficProvider("k", reply({ routes: [{ sections: [{ summary: { duration: 3600, baseDuration: 3000, length: 80_000 } }, { summary: { duration: 1800, baseDuration: 1800, length: 40_000 } }] }] }));
    expect(await here.travelTime([A, B, C], LEGAL_TRUCK, "2026-10-08T08:00:00Z")).toEqual({ distanceM: 120_000, durationS: 5400, trafficDelayS: 600, source: "here" });
    const q = new URL(urls[0]!).searchParams;
    expect(q.get("transportMode")).toBe("truck");
    expect(q.get("origin")).toBe("32.300000,-90.180000");
    expect(q.getAll("via")).toEqual(["33.500000,-90.200000"]);
    expect(q.get("truck[grossWeight]")).toBe("36287");
    expect(q.get("truck[height]")).toBe("411");
    expect(q.get("departureTime")).toBe("2026-10-08T08:00:00Z");
  });

  it("TomTom: reads travel time and the traffic delay it reports", async () => {
    urls = [];
    const tt = new TomTomTrafficProvider("k", reply({ routes: [{ summary: { lengthInMeters: 300_000, travelTimeInSeconds: 12_000, trafficDelayInSeconds: 900 } }] }));
    expect(await tt.travelTime([A, C], LEGAL_TRUCK, "2026-10-08T08:00:00Z")).toEqual({ distanceM: 300_000, durationS: 12_000, trafficDelayS: 900, source: "tomtom" });
    expect(urls[0]).toContain("/32.300000,-90.180000:35.150000,-90.050000/json?");
    const q = new URL(urls[0]!).searchParams;
    expect(q.get("travelMode")).toBe("truck");
    expect(q.get("traffic")).toBe("true");
    expect(q.get("vehicleHeight")).toBe("4.11");
  });

  it("fails clearly", async () => {
    await expect(new HereTrafficProvider("k", reply({}, false)).travelTime([A, C], LEGAL_TRUCK, "2026-10-08T08:00:00Z")).rejects.toThrow("HERE routing failed (429)");
    await expect(new HereTrafficProvider("k", reply({ routes: [] })).travelTime([A, C], LEGAL_TRUCK, "2026-10-08T08:00:00Z")).rejects.toBeInstanceOf(NoRouteError);
    await expect(new TomTomTrafficProvider("k", reply({ routes: [] })).travelTime([A, C], LEGAL_TRUCK, "2026-10-08T08:00:00Z")).rejects.toBeInstanceOf(NoRouteError);
  });
});
