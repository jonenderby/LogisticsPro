import type { Permit } from "@logisticspro/domain";
import { describe, expect, it } from "vitest";
import {
  type GpsFix,
  LEGAL_TRUCK,
  OversizeNavigationSession,
  type Restriction,
  StandardNavigationSession,
  StaticProvider,
  ValhallaProvider,
  checkOversizeTrip,
  decodePolyline,
  destination,
  encodePolyline,
  isDaylightTravel,
  sunTimes,
} from "../src/index.js";

// A straight 8.5 km eastbound road along latitude 40.
const A = { lat: 40, lng: -75 };
const B = { lat: 40, lng: -74.9 };
const MID = { lat: 40, lng: -74.95 };
const DAY = "2026-10-06T16:00:00Z"; // about noon Eastern
const north = (p: { lat: number; lng: number }, m: number) => destination(p, 0, m);
const fix = (p: { lat: number; lng: number }, at = DAY, extra: Partial<GpsFix> = {}): GpsFix => ({ ...p, at, ...extra });

const permit = (over: Partial<Permit> = {}): Permit => ({
  state: "PA",
  permitNumber: "PA-OS-1",
  validFrom: "2026-10-01T00:00:00Z",
  validTo: "2026-10-31T00:00:00Z",
  route: [A, MID, B],
  daylightOnly: true,
  noWeekends: true,
  escortsRequired: 1,
  ...over,
});

const OVERSIZE = { heightIn: 170, widthIn: 168, lengthIn: 1200, grossWeightLb: 120_000, axles: 9 };

describe("standard navigation", () => {
  it("tracks progress, asks for a reroute after leaving the route and detects arrival", async () => {
    const route = await new StaticProvider().route([A, MID, B], LEGAL_TRUCK);
    const nav = new StandardNavigationSession(route);
    const s1 = nav.update(fix(destination(A, 90, 1000)));
    expect(s1.status).toBe("ON_ROUTE");
    expect(s1.alongM).toBeGreaterThan(950);
    expect(s1.alongM).toBeLessThan(1050);
    expect(s1.nextManeuver?.type).toBe("continue");

    const off = destination(A, 90, 2000);
    const e1 = nav.update(fix(north(off, 300))).events.map((e) => e.type);
    const e2 = nav.update(fix(north(off, 320))).events.map((e) => e.type);
    const e3 = nav.update(fix(north(off, 340))).events.map((e) => e.type);
    expect(e1).toContain("OFF_ROUTE");
    expect(e2).toEqual([]);
    expect(e3).toContain("REROUTE_REQUIRED");

    expect(nav.update(fix(destination(A, 90, 2500))).events.map((e) => e.type)).toContain("BACK_ON_ROUTE");
    const end = nav.update(fix(B));
    expect(end.status).toBe("ARRIVED");
    expect(end.remainingM).toBeLessThan(5);
  });

  it("widens tolerance when GPS accuracy is poor", async () => {
    const nav = new StandardNavigationSession(await new StaticProvider().route([A, B], LEGAL_TRUCK));
    expect(nav.update(fix(north(MID, 80), DAY, { accuracyM: 70 })).status).toBe("ON_ROUTE");
  });
});

describe("oversize strict navigation", () => {
  it("warns when drifting, logs a violation when leaving the corridor and never reroutes", () => {
    const nav = new OversizeNavigationSession([permit()], OVERSIZE, { corridorHalfWidthM: 30, escorts: 1 });
    const start = destination(A, 90, 1000);
    expect(nav.update(fix(start)).status).toBe("ON_ROUTE");

    const drift = nav.update(fix(north(destination(A, 90, 1200), 22)));
    expect(drift.status).toBe("DRIFTING");
    expect(drift.events[0]).toMatchObject({ type: "CORRIDOR_WARNING", halfWidthM: 30 });

    const out = nav.update(fix(north(destination(A, 90, 1400), 120), "2026-10-06T16:01:00Z"));
    expect(out.status).toBe("OFF_CORRIDOR");
    const v = out.events.find((e) => e.type === "CORRIDOR_VIOLATION");
    expect(v).toMatchObject({ notify: ["DISPATCH", "ESCORT"] });
    // Guidance points back south toward the permitted route, not to a new route.
    expect(out.guidance!.bearingDeg).toBeGreaterThan(90);
    expect(out.guidance!.bearingDeg).toBeLessThan(270);
    expect(out.events.map((e) => e.type)).not.toContain("REROUTE_REQUIRED");

    nav.update(fix(north(destination(A, 90, 1500), 200), "2026-10-06T16:02:00Z"));
    const back = nav.update(fix(destination(A, 90, 1600), "2026-10-06T16:03:30Z"));
    expect(back.events).toContainEqual({ type: "RETURNED_TO_CORRIDOR", outsideForS: 150 });
    expect(nav.violations).toHaveLength(1);
    expect(nav.violations[0]!.maxDeviationM).toBeGreaterThanOrEqual(199);
    expect(nav.violations[0]!.endedAt).toBe("2026-10-06T16:03:30Z");
  });

  it("does not count progress made off the corridor", () => {
    const nav = new OversizeNavigationSession([permit()], OVERSIZE);
    nav.update(fix(destination(A, 90, 1000)));
    const off = nav.update(fix(north(destination(A, 90, 6000), 400)));
    expect(off.alongM).toBeLessThan(1100);
  });

  it("detects driving the wrong way along the permit route", () => {
    const nav = new OversizeNavigationSession([permit()], OVERSIZE);
    nav.update(fix(destination(A, 90, 3000)));
    nav.update(fix(destination(A, 90, 2700)));
    expect(nav.update(fix(destination(A, 90, 2500))).events.map((e) => e.type)).toContain("WRONG_DIRECTION");
  });

  it("announces restrictions ahead and whether the load clears them", () => {
    const restrictions: Restriction[] = [
      { id: "br1", type: "LOW_CLEARANCE", at: north(MID, 5), limit: 168, description: "Overpass 14 ft 0 in" },
      { id: "far", type: "WEIGHT_LIMIT", at: north(MID, 5000), limit: 40_000, description: "Bridge off the corridor" },
    ];
    const nav = new OversizeNavigationSession([permit()], OVERSIZE, { restrictions, lookaheadM: 5000 });
    const ev = nav.update(fix(destination(A, 90, 1000))).events.find((e) => e.type === "RESTRICTION_AHEAD");
    expect(ev).toMatchObject({ restriction: { id: "br1" }, clears: false });
    expect(nav.update(fix(destination(A, 90, 1100))).events.filter((e) => e.type === "RESTRICTION_AHEAD")).toHaveLength(0);
  });

  it("flags travel outside the daylight window", () => {
    const nav = new OversizeNavigationSession([permit()], OVERSIZE);
    expect(nav.update(fix(destination(A, 90, 100), DAY)).events).toEqual([]);
    expect(nav.update(fix(destination(A, 90, 200), "2026-10-07T04:00:00Z")).events.map((e) => e.type)).toContain("TRAVEL_WINDOW_CLOSED");
  });
});

describe("oversize pre-trip check", () => {
  it("passes a valid, daylight, weekday move", () => {
    const res = checkOversizeTrip({ permits: [permit()], truck: OVERSIZE, restrictions: [], departAt: DAY });
    expect(res.conflicts).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.escortsRequired).toBe(1);
  });

  it("reports expired permits, gaps between states, blocking restrictions, night and weekend departures", () => {
    const nj: Permit = { ...permit({ state: "NJ", permitNumber: "NJ-9", validTo: "2026-10-05T00:00:00Z", route: [destination(B, 90, 2000), destination(B, 90, 9000)] }) };
    const res = checkOversizeTrip({
      permits: [permit(), nj],
      truck: OVERSIZE,
      restrictions: [{ id: "b", type: "WEIGHT_LIMIT", at: MID, limit: 80_000, description: "Bridge posted 40 tons" }],
      departAt: "2026-10-11T03:00:00Z", // Saturday night Eastern
    });
    expect(res.conflicts.map((c) => c.kind).sort()).toEqual(["DAYLIGHT_ONLY", "NO_WEEKEND_TRAVEL", "PERMIT_GAP", "PERMIT_NOT_VALID", "RESTRICTION"]);
    expect(res.ok).toBe(false);
  });
});

describe("solar times", () => {
  it("matches published New York sunrise/sunset within a few minutes", () => {
    const s = sunTimes(new Date("2026-10-06T16:00:00Z"), { lat: 40.7128, lng: -74.006 })!;
    // NOAA: sunrise ~07:03 EDT (11:03Z), sunset ~18:29 EDT (22:29Z)
    expect(Math.abs(s.sunrise.getTime() - Date.parse("2026-10-06T11:03:00Z"))).toBeLessThan(6 * 60_000);
    expect(Math.abs(s.sunset.getTime() - Date.parse("2026-10-06T22:29:00Z"))).toBeLessThan(6 * 60_000);
    expect(isDaylightTravel(new Date("2026-10-06T10:40:00Z"), { lat: 40.7128, lng: -74.006 })).toBe(true);
    expect(isDaylightTravel(new Date("2026-10-06T10:20:00Z"), { lat: 40.7128, lng: -74.006 })).toBe(false);
  });
});

describe("polylines and providers", () => {
  it("decodes Google's reference polyline and round-trips precision 6", () => {
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ]);
    const pts = [A, MID, { lat: 40.123456, lng: -74.654321 }];
    expect(decodePolyline(encodePolyline(pts, 6), 6)).toEqual(pts);
  });

  it("sends the truck profile to Valhalla in metric units and maps the response", async () => {
    let sent: { url: string; body: Record<string, unknown> } | undefined;
    const shape = encodePolyline([A, MID, B], 6);
    const provider = new ValhallaProvider("https://valhalla.example.com/", {
      fetch: async (url, init) => {
        sent = { url, body: JSON.parse(init.body) };
        return {
          ok: true,
          status: 200,
          json: async () => ({ trip: { summary: { length: 8.5, time: 600 }, legs: [{ shape, maneuvers: [{ instruction: "Drive east.", begin_shape_index: 0, type: 1 }, { instruction: "Take exit 12.", begin_shape_index: 1, type: 20 }, { instruction: "Arrive.", begin_shape_index: 2, type: 4 }] }] } }),
        };
      },
    });
    const route = await provider.route([A, B], OVERSIZE);
    expect(sent!.url).toBe("https://valhalla.example.com/route");
    expect(sent!.body.costing).toBe("truck");
    expect((sent!.body.costing_options as { truck: Record<string, number> }).truck).toMatchObject({ height: 4.32, width: 4.27, weight: 54.43, axle_count: 9 });
    expect(route.distanceM).toBe(8500);
    expect(route.maneuvers.map((m) => m.type)).toEqual(["depart", "exit", "arrive"]);
    expect(route.geometry).toHaveLength(3);
  });
});
