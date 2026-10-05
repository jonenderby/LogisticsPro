import { describe, expect, it } from "vitest";
import { type DailyMiles, type FuelPurchase, iftaCsv, iftaReport, quarterDates, quarterOf } from "../src/index.js";

const fuel = (jurisdiction: string, gallons: number, date = "2026-10-10", vehicle = "Unit 12"): FuelPurchase => ({ id: `f${gallons}`, carrierOrgId: "c", vehicle, date, jurisdiction, gallons, enteredByAccountId: "a", createdAt: date });

describe("IFTA", () => {
  it("knows quarters", () => {
    expect(quarterOf("2026-10-05")).toBe("2026-Q4");
    expect(quarterDates("2026-Q1")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(quarterDates("2024-Q1").to).toBe("2024-03-31");
  });

  it("works out taxable gallons per jurisdiction at the fleet's MPG", () => {
    const days: DailyMiles[] = [
      { carrierOrgId: "c", vehicle: "Unit 12", vehicleLabel: "Unit 12", date: "2026-10-01", miles: { TN: 300.4, AR: 150 } },
      { carrierOrgId: "c", vehicle: "Unit 12", vehicleLabel: "Unit 12", date: "2026-10-02", miles: { AR: 100, TX: 450 } },
      // Next quarter: left out.
      { carrierOrgId: "c", vehicle: "Unit 12", vehicleLabel: "Unit 12", date: "2027-01-02", miles: { TX: 999 } },
    ];
    const r = iftaReport("2026-Q4", days, [fuel("TN", 100), fuel("TX", 66.67)], (code) => ({ member: code !== "DC", name: code }));
    expect(r).toMatchObject({ totalMiles: 1000, totalGallons: 166.67, mpg: 6 });
    expect(r.rows).toEqual([
      { jurisdiction: "AR", name: "AR", member: true, miles: 250, taxableGallons: 41.67, paidGallons: 0, netGallons: 41.67 },
      { jurisdiction: "TN", name: "TN", member: true, miles: 300, taxableGallons: 50, paidGallons: 100, netGallons: -50 },
      { jurisdiction: "TX", name: "TX", member: true, miles: 450, taxableGallons: 75, paidGallons: 66.67, netGallons: 8.33 },
    ]);
    expect(r.vehicles).toEqual([{ vehicle: "Unit 12", label: "Unit 12", miles: 1000, gallons: 166.67 }]);
    expect(iftaCsv(r).split("\n")[2]).toBe("AR,AR,yes,250,41.67,0,41.67");
  });

  it("leaves taxable gallons blank until fuel is entered", () => {
    const r = iftaReport("2026-Q4", [{ carrierOrgId: "c", vehicle: "v", vehicleLabel: "v", date: "2026-11-01", miles: { OK: 10 } }], []);
    expect(r.mpg).toBeUndefined();
    expect(r.rows[0]).toMatchObject({ miles: 10, taxableGallons: undefined, netGallons: undefined });
  });
});
