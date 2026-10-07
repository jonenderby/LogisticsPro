import { describe, expect, it } from "vitest";
import {
  DomainError,
  applyStatusEvent,
  assignLeg,
  awardBid,
  buildInvoice,
  estimateTransit,
  handoffLegs,
  linearFeet,
  loadMiles,
  placeBid,
  planConsolidation,
  planRelay,
  refineLoad,
  refinementLock,
  shipConfirm,
} from "../src/index.js";
import { HOUSTON_STORE, NASHVILLE_YARD, NEWARK_DC, NYC_WAREHOUSE, ltlLoad, makeLoad } from "./fixtures.js";

const at = (h: number) => new Date(Date.UTC(2026, 9, 6, h)).toISOString();

describe("load refinement lock", () => {
  it("lets the shipper refine until the driver reports pickup", () => {
    const load = makeLoad();
    const { load: refined, changed } = refineLoad(load, { notes: "Call 30 min out", references: { ...load.references, po: ["PO-1", "PO-2", "PO-3"] } });
    expect(changed).toEqual(["references", "notes"]);
    expect(refined.version).toBe(load.version + 1);

    const loaded = applyStatusEvent(refined, { code: "LOADED", at: at(14), source: "APP" });
    expect(loaded.status).toBe("IN_TRANSIT");
    expect(refinementLock(loaded).locked).toBe(true);
    expect(() => refineLoad(loaded, { notes: "too late" })).toThrow(/no longer be changed/);
  });

  it("locks on shipper ship-confirm even before the driver taps pickup", () => {
    const confirmed = shipConfirm(makeLoad(), at(12));
    expect(refinementLock(confirmed)).toEqual({ locked: true, reason: `Shipper confirmed shipment at ${at(12)}` });
    expect(() => refineLoad(confirmed, { notes: "x" })).toThrow(DomainError);
  });

  it("drops dispatch legs that referenced removed stops", () => {
    const relayed = planRelay(makeLoad(), [{ address: NASHVILLE_YARD }]);
    expect(relayed.legs).toHaveLength(2);
    const withoutRelay = refineLoad(relayed, { stops: relayed.stops.filter((s) => s.type !== "RELAY") }).load;
    expect(withoutRelay.legs).toHaveLength(0);
  });
});

describe("status events", () => {
  it("walks a load from booked to delivered", () => {
    let load = makeLoad();
    for (const [code, h] of [["DISPATCHED", 10], ["ARRIVED_PICKUP", 13], ["LOADED", 14], ["IN_TRANSIT", 20], ["ARRIVED_DELIVERY", 50], ["DELIVERED", 52]] as const) {
      load = applyStatusEvent(load, { code, at: at(h), source: "APP" });
    }
    expect(load.status).toBe("DELIVERED");
    expect(load.pickedUpAt).toBe(at(14));
    expect(load.deliveredAt).toBe(at(52));
    expect(load.events).toHaveLength(6);
  });

  it("rejects status updates on loads that are not booked", () => {
    expect(() => applyStatusEvent(makeLoad({ status: "POSTED" }), { code: "LOADED", at: at(1), source: "APP" })).toThrow(/booked load/);
  });
});

describe("relays and teams", () => {
  it("breaks New York -> Houston into relay legs with a driver change", () => {
    const load = planRelay(makeLoad(), [{ address: NASHVILLE_YARD }]);
    expect(load.stops.map((s) => s.type)).toEqual(["PICKUP", "RELAY", "DELIVERY"]);
    expect(load.legs.map((l) => l.sequence)).toEqual([1, 2]);
    const [leg1, leg2] = load.legs;
    const assigned = assignLeg(assignLeg(load, leg1!.id, { driverAccountIds: ["drv_a"] }), leg2!.id, { driverAccountIds: ["drv_b"] });
    expect(assigned.legs.map((l) => l.driverAccountIds)).toEqual([["drv_a"], ["drv_b"]]);

    let moving = applyStatusEvent(assigned, { code: "LOADED", at: at(14), source: "APP" });
    expect(moving.legs[0]!.status).toBe("IN_PROGRESS");
    moving = applyStatusEvent(moving, { code: "RELAY_HANDOFF", legId: leg1!.id, at: at(30), source: "APP" });
    expect(moving.legs.map((l) => l.status)).toEqual(["COMPLETED", "IN_PROGRESS"]);
  });

  it("keeps multi-stop drops on one truck: legs only break at relays and cross-docks", () => {
    const load = makeLoad();
    const extraDrop = { ...load.stops[1]!, id: "stop_mid", sequence: 2, address: NASHVILLE_YARD, type: "DELIVERY" as const };
    const stops = [load.stops[0]!, extraDrop, { ...load.stops[1]!, sequence: 3 }];
    expect(handoffLegs(stops)).toHaveLength(1);
  });

  it("requires a two-driver team on team-expedited loads", () => {
    const load = planRelay(makeLoad({ service: "TEAM_EXPEDITED" }), [{ address: NASHVILLE_YARD }]);
    expect(() => assignLeg(load, load.legs[0]!.id, { driverAccountIds: ["drv_a"] })).toThrow(/two-driver team/);
    expect(assignLeg(load, load.legs[0]!.id, { driverAccountIds: ["drv_a", "drv_b"] }).legs[0]!.driverAccountIds).toHaveLength(2);
  });

  it("estimates a team much faster than a solo driver on a long haul", () => {
    const miles = loadMiles(makeLoad());
    expect(miles).toBeGreaterThan(1500);
    expect(miles).toBeLessThan(1900);
    const solo = estimateTransit(miles);
    const team = estimateTransit(miles, { team: true });
    expect(solo.totalHours).toBeGreaterThan(team.totalHours + 15);
    expect(estimateTransit(400).totalHours).toBe(8);
    expect(estimateTransit(500).restBreaks).toBe(1);
  });
});

describe("LTL consolidation through a distribution center", () => {
  const dallas1 = { ...HOUSTON_STORE, name: "Dallas A", postalCode: "75201", geo: { lat: 32.78, lng: -96.8 } };
  const dallas2 = { ...HOUSTON_STORE, name: "Dallas B", postalCode: "75207", geo: { lat: 32.79, lng: -96.82 } };

  it("combines loads to the same area onto shared trailers", () => {
    const loads = [ltlLoad("l1", "LP-1", dallas1, 9000, 8), ltlLoad("l2", "LP-2", dallas2, 7000, 6), ltlLoad("l3", "LP-3", HOUSTON_STORE, 5000, 4)];
    const plan = planConsolidation(loads, NEWARK_DC, "org_carrier");
    expect(plan.trailers).toHaveLength(2);
    const dallas = plan.trailers.find((t) => t.destinationZip3 === "752")!;
    expect(dallas.loadIds.sort()).toEqual(["l1", "l2"]);
    expect(dallas.weightLb).toBe(16000);
    expect(dallas.linearFt).toBe(28);
    for (const l of plan.loads) {
      expect(l.stops.map((s) => s.type)).toEqual(["PICKUP", "CROSS_DOCK", "DELIVERY"]);
      expect(l.legs).toHaveLength(2);
      expect(l.legs[1]!.trailerId).toBeDefined();
    }
  });

  it("splits a lane across trailers when weight runs out", () => {
    const loads = [ltlLoad("a", "A", dallas1, 30000, 10), ltlLoad("b", "B", dallas2, 20000, 10)];
    expect(planConsolidation(loads, NEWARK_DC, "org_carrier").trailers).toHaveLength(2);
  });

  it("refuses FTL loads and loads already picked up", () => {
    expect(() => planConsolidation([makeLoad(), ltlLoad("b", "B", dallas2, 1000, 1)], NEWARK_DC, "org_carrier")).toThrow(/FTL/);
    expect(() => planConsolidation([ltlLoad("a", "A", dallas1, 1000, 1), { ...ltlLoad("b", "B", dallas2, 1000, 1), pickedUpAt: at(1) }], NEWARK_DC, "org_carrier")).toThrow(/picked up/);
  });

  it("estimates linear feet for pallets", () => {
    expect(linearFeet(ltlLoad("a", "A", dallas1, 1000, 5))).toBe(12);
  });
});

describe("bidding", () => {
  const posted = () => makeLoad({ status: "POSTED", carrierOrgId: undefined, board: { postedByOrgId: "org_shipper", postedAt: at(0) } });

  it("awards one bid, rejects the rest and books the winning carrier", () => {
    const load = posted();
    const b1 = placeBid(load, { carrierOrgId: "org_c1", bidderAccountId: "a1", amount: { amount: 5100, currency: "USD" }, plan: "SOLO" });
    const b2 = placeBid(load, { carrierOrgId: "org_c2", bidderAccountId: "a2", amount: { amount: 4900, currency: "USD" }, plan: "RELAY" });
    const { load: won, bids } = awardBid(load, [b1, b2], b2.id);
    expect(won.status).toBe("TENDERED");
    expect(won.carrierOrgId).toBe("org_c2");
    expect(won.rate?.amount).toBe(4900);
    expect(bids.map((b) => b.status)).toEqual(["REJECTED", "AWARDED"]);
  });

  it("blocks solo bids on team loads and bids on your own load", () => {
    const team = { ...posted(), service: "TEAM_EXPEDITED" as const };
    expect(() => placeBid(team, { carrierOrgId: "org_c1", bidderAccountId: "a", amount: { amount: 1, currency: "USD" }, plan: "SOLO" })).toThrow(/team/);
    expect(() => placeBid(posted(), { carrierOrgId: "org_shipper", bidderAccountId: "a", amount: { amount: 1, currency: "USD" }, plan: "SOLO" })).toThrow(/own load/);
  });
});

describe("invoices", () => {
  it("builds linehaul, fuel and accessorial lines from a delivered load", () => {
    const load = { ...makeLoad(), status: "DELIVERED" as const, deliveredAt: at(52), pickedUpAt: at(14) };
    const inv = buildInvoice(load, { orgId: "org_carrier", scac: "ACME" }, "acct", { fuelSurchargePct: 12.5, lines: [{ code: "DETENTION", description: "Detention 2h", quantity: 2, rate: 75 }] });
    expect(inv.lines.map((l) => [l.code, l.amount])).toEqual([["LINEHAUL", 5200], ["DETENTION", 150], ["FUEL_SURCHARGE", 650]]);
    expect(inv.total).toBe(6000);
    expect(inv.shipper.city).toBe(NYC_WAREHOUSE.city);
  });

  it("will not invoice an undelivered load", () => {
    expect(() => buildInvoice(makeLoad(), { orgId: "o" }, "a")).toThrow(/after delivery/);
  });
});
