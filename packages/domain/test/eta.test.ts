import { describe, expect, it } from "vitest";
import { type Load, byUrgency, shipmentEta, summarizeEtas } from "../src/index.js";
import { HOUSTON_STORE, makeLoad } from "./fixtures.js";

// makeLoad: pickup Bronx 10-06 13:00-15:00Z, delivery Houston 10-08 14:00-18:00Z (~1,700 road miles).
const assigned = (over: Partial<Load> = {}): Load =>
  makeLoad({ legs: [{ id: "leg1", sequence: 1, fromStopId: "stop_pu", toStopId: "stop_del", driverAccountIds: ["d1"], status: "ASSIGNED" }], ...over });
const inTransit = (over: Partial<Load> = {}): Load =>
  assigned({ status: "IN_TRANSIT", pickedUpAt: "2026-10-06T14:00:00Z", legs: [{ id: "leg1", sequence: 1, fromStopId: "stop_pu", toStopId: "stop_del", driverAccountIds: ["d1"], status: "IN_PROGRESS" }], ...over });
// A point ~N miles north of the Houston store.
const near = (miles: number) => ({ lat: HOUSTON_STORE.geo!.lat + miles / 69.05, lng: HOUSTON_STORE.geo!.lng });

describe("shipment ETA and arrival status", () => {
  it("before pickup: a solo driver will be late on this lane, a team arrives early", () => {
    const solo = shipmentEta(assigned(), { now: "2026-10-06T10:00:00Z" });
    expect(solo.status).toBe("LATE");
    expect(solo.etaSource).toBe("COMPUTED");
    expect(solo.remainingMiles).toBeGreaterThan(1500);
    expect(solo.reasons[0]).toMatch(/after the delivery window closes/);
    const team = shipmentEta(assigned({ teamRequired: true }), { now: "2026-10-06T10:00:00Z" });
    expect(team.status).toBe("EARLY");
    expect(team.reasons[0]).toMatch(/before the window opens/);
  });

  it("in transit with a fresh position near the destination is on time", () => {
    const e = shipmentEta(inTransit(), { now: "2026-10-08T15:00:00Z", position: { geo: near(40), at: "2026-10-08T14:55:00Z" } });
    expect(e).toMatchObject({ status: "ON_TIME", etaSource: "COMPUTED", nextStop: { city: "Houston" }, position: { source: "DRIVER", stale: false } });
    expect(e.slackMinutes).toBeGreaterThan(60);
    expect(e.reasons).toEqual(["On track for the delivery window"]);
  });

  it("flags at risk when the truck goes quiet, slack gets thin, or a delay is reported", () => {
    const stale = shipmentEta(inTransit(), { now: "2026-10-08T15:00:00Z", position: { geo: near(40), at: "2026-10-08T11:30:00Z" } });
    expect(stale.status).toBe("AT_RISK");
    expect(stale.reasons).toContain("No location update for 4 h");

    const tight = shipmentEta(inTransit(), { now: "2026-10-08T15:00:00Z", position: { geo: near(100), at: "2026-10-08T14:59:00Z" } });
    expect(tight.status).toBe("AT_RISK");
    expect(tight.reasons[0]).toMatch(/of slack before the window closes/);

    const delayed = inTransit({ events: [{ id: "e", code: "DELAYED", at: "2026-10-08T12:00:00Z", note: "Reason: traffic", source: "APP" }] });
    expect(shipmentEta(delayed, { now: "2026-10-08T13:00:00Z", position: { geo: near(20), at: "2026-10-08T12:59:00Z" } }).reasons).toContain("Delay reported: Reason: traffic");
  });

  it("uses the carrier's reported ETA when it is recent", () => {
    const load = inTransit({ events: [{ id: "e", code: "ETA_UPDATE", at: "2026-10-08T12:00:00Z", eta: "2026-10-08T19:30:00Z", source: "EDI" }] });
    const e = shipmentEta(load, { now: "2026-10-08T13:00:00Z", position: { geo: near(20), at: "2026-10-08T12:50:00Z" } });
    expect(e).toMatchObject({ status: "LATE", etaSource: "CARRIER", eta: "2026-10-08T19:30:00Z", slackMinutes: -90 });
  });

  it("judges an actual arrival against the window", () => {
    const load = inTransit({ status: "AT_DELIVERY", events: [{ id: "a", code: "ARRIVED_DELIVERY", at: "2026-10-08T13:20:00Z", source: "APP" }] });
    expect(shipmentEta(load, { now: "2026-10-08T13:30:00Z" })).toMatchObject({ status: "EARLY", etaSource: "ARRIVED", reasons: ["Arrived before the delivery window opened"] });
  });

  it("is unknown without a location, and at risk when pickup is near with no driver", () => {
    expect(shipmentEta(inTransit(), { now: "2026-10-08T15:00:00Z" })).toMatchObject({ status: "UNKNOWN", reasons: ["No location reported since pickup"] });
    const unassigned = makeLoad({ teamRequired: true, legs: [] });
    const e = shipmentEta(unassigned, { now: "2026-10-06T08:00:00Z" });
    expect(e.status).toBe("AT_RISK");
    expect(e.reasons).toContain("No driver assigned and pickup is within 12 h");
  });

  it("summarizes and sorts most urgent first", () => {
    const etas = [
      shipmentEta(inTransit(), { now: "2026-10-08T15:00:00Z", position: { geo: near(40), at: "2026-10-08T14:55:00Z" } }),
      shipmentEta(assigned(), { now: "2026-10-06T10:00:00Z" }),
      shipmentEta(inTransit(), { now: "2026-10-08T15:00:00Z" }),
    ];
    expect(summarizeEtas(etas)).toEqual({ LATE: 1, AT_RISK: 0, ON_TIME: 1, EARLY: 0, UNKNOWN: 1 });
    expect([...etas].sort(byUrgency).map((e) => e.status)).toEqual(["LATE", "UNKNOWN", "ON_TIME"]);
  });
});
