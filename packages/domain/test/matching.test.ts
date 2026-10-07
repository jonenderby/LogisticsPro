import { describe, expect, it } from "vitest";
import { matchLoad, rankMatches } from "../src/index.js";
import { NASHVILLE_YARD, makeLoad } from "./fixtures.js";

const MEMPHIS = { lat: 35.15, lng: -90.05 };
const NOW = "2026-10-06T07:00:00Z";
// Nashville pickup 13:00-15:00 Oct 6, Houston delivery 14:00-18:00 Oct 8, about 790 road miles.
const short = makeLoad({ id: "short", stops: [{ ...makeLoad().stops[0]!, address: NASHVILLE_YARD }, makeLoad().stops[1]!], rate: { amount: 2600, currency: "USD" } });
// New York to Houston, about 1,670 road miles in the same windows.
const long = makeLoad({ id: "long", rate: { amount: 5200, currency: "USD" } });

describe("load matching", () => {
  it("takes a load the driver can reach and deliver within the rules", () => {
    const m = matchLoad(short, { now: NOW, from: MEMPHIS })!;
    expect(m).toMatchObject({ feasible: true, deadheadMiles: 234, loadedMiles: 792 });
    expect(m.ratePerMile).toBeCloseTo(2600 / (234 + 792), 1);
    expect(m.pickupAt).toBe("2026-10-06T13:00:00.000Z");
    expect(m.reasons).toEqual(["Includes a 10-hour rest on the way"]);
  });

  it("rules out a pickup the driver cannot reach on the hours left", () => {
    const tired = { drivingLeftMin: 60, windowLeftMin: 120, breakLeftMin: 60, cycleLeftMin: 3000 };
    const m = matchLoad(short, { now: NOW, from: MEMPHIS, hos: tired })!;
    expect(m.feasible).toBe(false);
    expect(m.reasons[0]).toBe("Can't reach the pickup before its window closes with the rest you need on the way");
  });

  it("knows a solo driver cannot make a long run that a team can", () => {
    const solo = matchLoad(long, { now: NOW, from: long.stops[0]!.address.geo! })!;
    expect(solo.feasible).toBe(false);
    expect(solo.reasons[0]).toMatch(/^Would deliver \d+ h( \d+ min)? after the window closes$/);
    expect(matchLoad(long, { now: NOW, from: long.stops[0]!.address.geo!, team: true })!.feasible).toBe(true);
    expect(matchLoad({ ...short, teamRequired: true }, { now: NOW, from: MEMPHIS })!.reasons).toContain("Needs a team");
  });

  it("ranks loads the driver can take first, then by pay per mile", () => {
    const a = matchLoad(short, { now: NOW, from: MEMPHIS })!;
    const b = matchLoad(long, { now: NOW, from: MEMPHIS })!;
    expect(rankMatches([b, a]).map((m) => m.loadId)).toEqual(["short", "long"]);
  });
});
