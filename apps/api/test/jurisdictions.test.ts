import { describe, expect, it } from "vitest";
import { isIftaMember, jurisdictionAt, splitByJurisdiction } from "../src/services/jurisdictions.js";

describe("jurisdictions", () => {
  it("finds the state or province for a point", () => {
    expect(jurisdictionAt({ lat: 35.15, lng: -90.05 })?.code).toBe("TN"); // Memphis
    expect(jurisdictionAt({ lat: 35.1465, lng: -90.1845 })?.code).toBe("AR"); // West Memphis, across the river
    expect(jurisdictionAt({ lat: 43.65, lng: -79.38 })).toMatchObject({ code: "ON", country: "CA" }); // Toronto
    expect(jurisdictionAt({ lat: 40.78, lng: -73.97 })?.code).toBe("NY"); // Manhattan
    expect(jurisdictionAt({ lat: 38.9, lng: -77.03 })?.code).toBe("DC");
    expect(jurisdictionAt({ lat: 19.43, lng: -99.13 })).toBeUndefined(); // Mexico City
    expect(jurisdictionAt({ lat: 30, lng: -60 })).toBeUndefined(); // Atlantic
  });

  it("knows which places are IFTA members", () => {
    expect(isIftaMember({ code: "TX", country: "US", name: "Texas" })).toBe(true);
    expect(isIftaMember({ code: "QC", country: "CA", name: "Québec" })).toBe(true);
    expect(isIftaMember({ code: "DC", country: "US", name: "District of Columbia" })).toBe(false);
  });

  it("splits a stretch across a border where it crosses", () => {
    // South Kansas City: the state line is State Line Road, at about -94.608.
    const parts = splitByJurisdiction({ lat: 38.95, lng: -94.5 }, { lat: 38.95, lng: -94.7 }, 10);
    expect(parts.map((p) => p.code)).toEqual(["MO", "KS"]);
    // Within about 0.2 miles of the true crossing.
    expect(Math.abs(parts[0]!.miles - 10 * ((94.608 - 94.5) / 0.2))).toBeLessThan(0.2);
    expect(parts[0]!.miles + parts[1]!.miles).toBeCloseTo(10, 6);
  });
});
