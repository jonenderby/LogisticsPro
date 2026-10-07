import { describe, expect, it } from "vitest";
import { DEFAULT_DETENTION, applyStatusEvent, detention, detentionLines, updateVisits } from "../src/index.js";
import { makeLoad } from "./fixtures.js";

// Pickup window 2026-10-06 13:00-15:00Z, delivery 2026-10-08 14:00-18:00Z.
const load = makeLoad();
const pu = load.stops[0]!;
const del = load.stops[1]!;
const at = (geo: { lat: number; lng: number }, iso: string, northMiles = 0) => ({ geo: { lat: geo.lat + northMiles / 69.05, lng: geo.lng }, at: iso });

describe("stop visits from the truck's location", () => {
  it("arrive within 800 m, leave beyond 1,600 m, ignoring jitter at the dock", () => {
    expect(updateVisits(load, at(pu.address.geo!, "2026-10-06T12:30:00Z", 2))).toBeUndefined();
    const arrived = updateVisits(load, at(pu.address.geo!, "2026-10-06T12:40:00Z", 0.2))!;
    expect(arrived.arrived?.id).toBe(pu.id);
    const there = { ...load, visits: arrived.visits };
    expect(updateVisits(there, at(pu.address.geo!, "2026-10-06T13:30:00Z", 0.6))).toBeUndefined(); // 970 m: still there
    const left = updateVisits(there, at(pu.address.geo!, "2026-10-06T16:10:00Z", 1.5))!;
    expect(left.departed?.id).toBe(pu.id);
    expect(left.visits[0]).toMatchObject({ arrivedAt: "2026-10-06T12:40:00Z", departedAt: "2026-10-06T16:10:00Z", source: "GEOFENCE" });
  });
});

describe("detention", () => {
  it("starts at the appointment for an early truck and bills after the free time, rounded up", () => {
    // Arrived 12:40, appointment 13:00, left 16:10: 3 h 10 min from the appointment, 1 h 10 min over 2 h free, billed 1 h 15 min.
    const l = { ...load, visits: [{ stopId: pu.id, arrivedAt: "2026-10-06T12:40:00Z", departedAt: "2026-10-06T16:10:00Z", source: "GEOFENCE" as const }] };
    const [p] = detention(l, DEFAULT_DETENTION, "2026-10-07T00:00:00Z");
    expect(p).toMatchObject({ clockStartAt: "2026-10-06T13:00:00.000Z", billableMinutes: 75, amount: 93.75, atStop: false });
    expect(detentionLines(detention(l, DEFAULT_DETENTION, "2026-10-07T00:00:00Z"), DEFAULT_DETENTION)).toEqual([{ code: "DETENTION", description: "Detention Bronx, NY", quantity: 1.25, rate: 75, amount: 93.75 }]);
  });

  it("does not apply to a truck that arrived after the appointment", () => {
    const l = { ...load, visits: [{ stopId: pu.id, arrivedAt: "2026-10-06T15:30:00Z", departedAt: "2026-10-06T20:00:00Z", source: "GEOFENCE" as const }] };
    expect(detention(l, DEFAULT_DETENTION, "2026-10-07T00:00:00Z")[0]).toMatchObject({ billableMinutes: 0, note: "Arrived after the appointment, so detention does not apply" });
  });

  it("uses the driver's taps where the location has none, and keeps counting while the truck is there", () => {
    let l = applyStatusEvent(load, { code: "ARRIVED_PICKUP", at: "2026-10-06T13:00:00Z", source: "APP" });
    expect(detention(l, { ...DEFAULT_DETENTION, ratePerHour: 60 }, "2026-10-06T16:00:00Z")[0]).toMatchObject({ source: "STATUS", atStop: true, billableMinutes: 60, amount: 60 });
    // Still at the stop: nothing goes on an invoice yet.
    expect(detentionLines(detention(l, DEFAULT_DETENTION, "2026-10-06T16:00:00Z"), DEFAULT_DETENTION)).toEqual([]);
    l = applyStatusEvent(l, { code: "LOADED", at: "2026-10-06T15:00:00Z", source: "APP" });
    expect(detention(l, DEFAULT_DETENTION, "2026-10-07T00:00:00Z")[0]).toMatchObject({ departedAt: "2026-10-06T15:00:00Z", billableMinutes: 0 });
    expect(detention(l, DEFAULT_DETENTION, "2026-10-07T00:00:00Z")[1]).toMatchObject({ stopId: del.id, billableMinutes: 0, arrivedAt: undefined });
  });
});
