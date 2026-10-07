import { describe, expect, it } from "vitest";
import { driverShare, lastWeek, settlementCsv, settlementLine, settlementTotal } from "../src/index.js";
import { NASHVILLE_YARD, makeLoad } from "./fixtures.js";

const solo = makeLoad({ status: "DELIVERED", deliveredAt: "2026-10-08T16:00:00.000Z", legs: [{ id: "leg1", sequence: 1, fromStopId: "stop_pu", toStopId: "stop_del", driverAccountIds: ["ana"], status: "COMPLETED" }] });

// New York to Nashville with Ana and Ben as a team, then Nashville to Houston with Cal.
const relay = makeLoad({
  status: "DELIVERED",
  deliveredAt: "2026-10-09T16:00:00.000Z",
  stops: [
    solo.stops[0]!,
    { id: "stop_relay", sequence: 2, type: "RELAY", address: NASHVILLE_YARD, window: { start: "2026-10-07T13:00:00Z", end: "2026-10-07T15:00:00Z" } },
    { ...solo.stops[1]!, sequence: 3 },
  ],
  legs: [
    { id: "leg1", sequence: 1, fromStopId: "stop_pu", toStopId: "stop_relay", driverAccountIds: ["ana", "ben"], status: "COMPLETED" },
    { id: "leg2", sequence: 2, fromStopId: "stop_relay", toStopId: "stop_del", driverAccountIds: ["cal"], status: "COMPLETED" },
  ],
});

describe("driver settlement", () => {
  it("pays a solo driver the whole load", () => {
    expect(driverShare(solo, "ana").share).toBe(1);
    expect(settlementLine(solo, "ana", { kind: "PERCENT", rate: 25 })).toMatchObject({ amount: 1300, basis: "$5,200.00 × 25%", lane: "Bronx, NY to Houston, TX" });
    const perMile = settlementLine(solo, "ana", { kind: "PER_MILE", rate: 0.6 });
    expect(perMile.basis).toMatch(/^1,?\d{3} mi × \$0\.60$/);
    expect(perMile.amount).toBeCloseTo(driverShare(solo, "ana").miles * 0.6, 2);
    expect(settlementLine(solo, "ana", { kind: "PER_LOAD", rate: 400 }).amount).toBe(400);
  });

  it("splits relays by miles and teams in half", () => {
    const ana = driverShare(relay, "ana");
    const ben = driverShare(relay, "ben");
    const cal = driverShare(relay, "cal");
    expect(ana).toEqual(ben);
    expect(ana.share * 2 + cal.share).toBeCloseTo(1, 3);
    // Bronx to Nashville is shorter than Nashville to Houston.
    expect(cal.share).toBeGreaterThan(ana.share * 2 - 0.1);
    expect(settlementLine(relay, "ana", { kind: "PERCENT", rate: 25 }).basis).toBe(`$5,200.00 × 25% × ${Math.round(ana.share * 100)}% of the load`);
    expect(driverShare(relay, "nobody")).toEqual({ share: 0, miles: 0 });
  });

  it("totals lines and adjustments, and exports CSV", () => {
    const line = settlementLine(solo, "ana", { kind: "PERCENT", rate: 25 });
    const statement = {
      id: "st1", carrierOrgId: "c", driverAccountId: "ana", driverName: "Ana, Jr.", periodStart: "2026-10-05", periodEnd: "2026-10-11", lines: [line],
      adjustments: [{ id: "a1", description: "Fuel advance", amount: -200, byAccountId: "o", at: "x" }], total: 0, status: "DRAFT" as const, createdAt: "x",
    };
    expect(settlementTotal(statement)).toBe(1100);
    const csv = settlementCsv([{ ...statement, total: 1100 }]);
    expect(csv.split("\n")[1]).toBe('"Ana, Jr.",2026-10-05,2026-10-11,LP-1001,2026-10-08,"Bronx, NY to Houston, TX",$5,200.00 × 25%,1300.00'.replace("$5,200.00 × 25%", '"$5,200.00 × 25%"'));
    expect(csv).toContain("Fuel advance,-200.00");
    expect(csv.trimEnd().split("\n").at(-1)).toBe('"Ana, Jr.",2026-10-05,2026-10-11,,,,Total,1100.00');
  });

  it("finds last week's Monday to Sunday", () => {
    expect(lastWeek("2026-10-06")).toEqual({ start: "2026-09-28", end: "2026-10-04" });
    expect(lastWeek("2026-10-12")).toEqual({ start: "2026-10-05", end: "2026-10-11" });
  });
});
