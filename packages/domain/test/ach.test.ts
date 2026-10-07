import { describe, expect, it } from "vitest";
import { buildNachaFile, isValidRoutingNumber, nextBusinessDay, rmrAddenda } from "../src/index.js";

const originator = { companyName: "Acme Foods", companyId: "1123456789", bankRoutingNumber: "021000021", bankName: "JPMORGAN CHASE" };

describe("ACH", () => {
  it("checks routing numbers", () => {
    expect(isValidRoutingNumber("021000021")).toBe(true);
    expect(isValidRoutingNumber("011000015")).toBe(true);
    expect(isValidRoutingNumber("021000022")).toBe(false);
    expect(isValidRoutingNumber("21000021")).toBe(false);
  });

  it("writes a NACHA file of CCD credits with remittance addenda", () => {
    const f = buildNachaFile({
      originator,
      effectiveDate: "2026-10-08",
      createdAt: "2026-10-06T14:05:00.000Z",
      credits: [
        { name: "Blue Line Trucking", routingNumber: "121000248", accountNumber: "123456789", accountType: "CHECKING", amountCents: 520_000, id: "INV-1001", addenda: rmrAddenda("INV-1001", 5200) },
        { name: "Fast Factor LLC", routingNumber: "011000015", accountNumber: "9876", accountType: "SAVINGS", amountCents: 180_050, id: "INV-1002" },
      ],
    });
    const lines = f.text.trimEnd().split("\n");
    expect(lines.every((l) => l.length === 94)).toBe(true);
    expect(lines.length % 10).toBe(0);
    expect(lines[0]).toBe(`101 0210000211123456789${"261006"}${"1405"}A094101${"JPMORGAN CHASE".padEnd(23)}${"ACME FOODS".padEnd(23)}${" ".repeat(8)}`);
    expect(lines[1]!.slice(0, 4)).toBe("5220");
    expect(lines[1]!.slice(50, 53)).toBe("CCD");
    expect(lines[1]!.slice(69, 75)).toBe("261008");
    // Checking credit with addenda, then a savings credit without.
    expect(lines[2]).toBe(`622121000248${"123456789".padEnd(17)}0000520000${"INV-1001".padEnd(15)}${"BLUE LINE TRUCKING".padEnd(22)}  1021000020000001`);
    expect(lines[3]).toBe(`705RMR*IV*INV-1001**5200.00\\${" ".repeat(80 - 25)}00010000001`);
    expect(lines[4]!.slice(0, 3)).toBe("632");
    expect(lines[4]!.slice(29, 39)).toBe("0000180050");
    // Totals: 3 records, entry hash 12100024 + 01100001, $7,000.50 in credits.
    expect(lines[5]!.slice(0, 44)).toBe("8220" + "000003" + "0013200025" + "000000000000" + "000000700050");
    expect(lines[6]!.slice(0, 55)).toBe("9" + "000001" + "000001" + "00000003" + "0013200025" + "000000000000" + "000000700050");
    expect(lines.slice(7).every((l) => l === "9".repeat(94))).toBe(true);
    expect(f.traceNumbers).toEqual(["021000020000001", "021000020000002"]);
    expect(f.totalCents).toBe(700_050);
  });

  it("refuses bad input", () => {
    expect(() => buildNachaFile({ originator, effectiveDate: "2026-10-08", createdAt: "2026-10-06T14:05:00Z", credits: [] })).toThrow("No payments");
    expect(() => buildNachaFile({ originator, effectiveDate: "2026-10-08", createdAt: "2026-10-06T14:05:00Z", credits: [{ name: "X", routingNumber: "123456789", accountNumber: "1234", accountType: "CHECKING", amountCents: 100, id: "1" }] })).toThrow("routing");
  });

  it("moves weekend dates to Monday", () => {
    expect(nextBusinessDay("2026-10-10")).toBe("2026-10-12");
    expect(nextBusinessDay("2026-10-08")).toBe("2026-10-08");
  });
});
