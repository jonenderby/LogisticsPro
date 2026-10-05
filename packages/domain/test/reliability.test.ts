import { describe, expect, it } from "vitest";
import {
  type ShipmentOutcome,
  applyStatusEvent,
  assignLeg,
  carrierReliability,
  carrierWindows,
  driverReliability,
  planRelay,
  reliabilityByBusiness,
  shipmentOutcome,
} from "../src/index.js";
import { NASHVILLE_YARD, makeLoad } from "./fixtures.js";

let n = 0;
function outcome(over: Partial<ShipmentOutcome>): ShipmentOutcome {
  n++;
  return {
    loadId: `l${n}`,
    loadNumber: `LP-${n}`,
    deliveredAt: new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString(),
    carrierOrgId: "carrierB",
    businessOrgIds: ["companyA"],
    pickupDriverIds: ["d1"],
    deliveryDriverIds: ["d1"],
    driverIds: ["d1"],
    onTimePickup: true,
    onTimeDelivery: true,
    damageFree: true,
    exceptionTypes: [],
    ...over,
  };
}

describe("reliability windows", () => {
  it("scale carrier windows with the number of truckers", () => {
    expect(carrierWindows(10)).toEqual({ overall: 10_000, perBusiness: 1_000 });
    expect(carrierWindows(0)).toEqual({ overall: 1_000, perBusiness: 100 });
  });

  it("keeps a strong relationship strong even when another customer's is poor", () => {
    const outcomes = [
      ...Array.from({ length: 40 }, () => outcome({ businessOrgIds: ["companyA"] })),
      ...Array.from({ length: 40 }, (_, i) => outcome({ businessOrgIds: ["companyC"], onTimeDelivery: i % 2 === 0, damageFree: i % 4 !== 0 })),
    ];
    const withA = carrierReliability(outcomes, "carrierB", 1, "companyA");
    const withC = carrierReliability(outcomes, "carrierB", 1, "companyC");
    expect(withA.forBusiness).toMatchObject({ shipments: 40, onTimePickupPct: 100, onTimeDeliveryPct: 100, damageFreePct: 100, score: 100 });
    expect(withC.forBusiness).toMatchObject({ shipments: 40, onTimeDeliveryPct: 50, damageFreePct: 75 });
    expect(withA.overall.onTimeDeliveryPct).toBe(75);
    const breakdown = reliabilityByBusiness(outcomes, 100);
    expect(breakdown.map((b) => [b.businessOrgId, b.score])).toEqual([["companyA", 100], ["companyC", 75]]);
  });

  it("rolls the driver's business window over the last 100 shipments", () => {
    const outcomes = [
      ...Array.from({ length: 50 }, () => outcome({ businessOrgIds: ["companyA"], onTimeDelivery: false })), // older, late
      ...Array.from({ length: 100 }, () => outcome({ businessOrgIds: ["companyA"] })), // newer, on time
    ];
    const p = driverReliability(outcomes, "d1", "companyA");
    expect(p.forBusiness).toMatchObject({ shipments: 100, window: 100, onTimeDeliveryPct: 100 });
    expect(p.overall).toMatchObject({ shipments: 150, window: 1000 });
    expect(p.overall.onTimeDeliveryPct).toBeCloseTo(66.7, 1);
  });

  it("only charges a driver with the stops they were responsible for", () => {
    const relay = outcome({ pickupDriverIds: ["d1"], deliveryDriverIds: ["d2"], driverIds: ["d1", "d2"], onTimePickup: true, onTimeDelivery: false });
    expect(driverReliability([relay], "d1").overall).toMatchObject({ onTimePickupPct: 100, onTimeDeliveryPct: null });
    expect(driverReliability([relay], "d2").overall).toMatchObject({ onTimePickupPct: null, onTimeDeliveryPct: 0 });
  });
});

describe("shipment outcomes", () => {
  it("judges pickup by Loaded, delivery by arrival, and damage by exceptions", () => {
    let load = planRelay(makeLoad(), [{ address: NASHVILLE_YARD }]);
    load = assignLeg(load, load.legs[0]!.id, { driverAccountIds: ["d1"] });
    load = assignLeg(load, load.legs[1]!.id, { driverAccountIds: ["d2", "d3"] });
    load = applyStatusEvent(load, { code: "LOADED", at: "2026-10-06T15:10:00Z", source: "APP" }); // window ends 15:00, 15 min grace
    load = applyStatusEvent(load, { code: "ARRIVED_DELIVERY", at: "2026-10-08T19:00:00Z", source: "APP" }); // window ends 18:00
    load = applyStatusEvent(load, { code: "DELIVERED", at: "2026-10-08T19:30:00Z", source: "APP" });
    const o = shipmentOutcome(load, [{ id: "x", loadId: load.id, type: "DAMAGE", note: "Crushed pallet", reportedByAccountId: "s", at: "2026-10-08T20:00:00Z" }]);
    expect(o).toMatchObject({ onTimePickup: true, onTimeDelivery: false, damageFree: false, pickupDriverIds: ["d1"], deliveryDriverIds: ["d2", "d3"], businessOrgIds: ["org_shipper"] });
    expect(o.driverIds.sort()).toEqual(["d1", "d2", "d3"]);
  });
});
