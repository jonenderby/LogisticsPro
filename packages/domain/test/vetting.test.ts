import { describe, expect, it } from "vitest";
import { type FmcsaRecord, namesMatch, vetCarrier } from "../src/index.js";

const NOW = "2026-10-05T12:00:00Z";
const record = (over: Partial<FmcsaRecord> = {}): FmcsaRecord => ({
  dotNumber: "1234567",
  mcNumbers: ["654321"],
  legalName: "BLUE LINE TRUCKING LLC",
  phone: "(901) 555-0100",
  email: "dispatch@bluelinetrucking.com",
  address: { street: "100 Commerce Dr", city: "Memphis", state: "TN", postalCode: "38103" },
  allowedToOperate: true,
  outOfService: false,
  authority: { common: "ACTIVE", contract: "NONE", broker: "NONE" },
  authoritySince: "2019-04-01",
  insurance: { liabilityOnFileUsd: 1_000_000, cargoOnFileUsd: 100_000 },
  safetyRating: "SATISFACTORY",
  fetchedAt: NOW,
  ...over,
});
const org = { name: "Blue Line Trucking", dotNumber: "1234567", mcNumber: "MC-654321" };
const codes = (r: ReturnType<typeof vetCarrier>, result: string) => r.checks.filter((c) => c.result === result).map((c) => c.code);

describe("carrier vetting", () => {
  it("passes an established, insured carrier whose people match FMCSA", () => {
    const r = vetCarrier({ org, record: record(), contactEmails: ["owner@bluelinetrucking.com"], now: NOW });
    expect(r.verdict).toBe("PASS");
    expect(codes(r, "PASS")).toEqual(["ALLOWED_TO_OPERATE", "AUTHORITY", "MC_MATCH", "AUTHORITY_AGE", "LIABILITY", "SAFETY", "NAME_MATCH", "CONTACT_MATCH"]);
  });

  it("fails what must never haul", () => {
    expect(vetCarrier({ org: { name: "X" }, now: NOW })).toMatchObject({ verdict: "FAIL", checks: [{ code: "DOT_ON_FILE" }] });
    expect(vetCarrier({ org, now: NOW })).toMatchObject({ verdict: "FAIL", checks: [{ code: "FMCSA_FOUND" }] });
    expect(codes(vetCarrier({ org, record: record({ allowedToOperate: false, outOfService: true, outOfServiceDate: "2026-09-30" }), now: NOW }), "FAIL")).toEqual(["ALLOWED_TO_OPERATE", "OUT_OF_SERVICE"]);
    // A broker posing as a carrier is the start of double brokering.
    const broker = vetCarrier({ org, record: record({ authority: { common: "NONE", contract: "NONE", broker: "ACTIVE" } }), now: NOW });
    expect(broker.checks.find((c) => c.code === "AUTHORITY")).toMatchObject({ result: "FAIL", title: "Broker authority only" });
    expect(codes(vetCarrier({ org: { ...org, mcNumber: "999999" }, record: record(), now: NOW }), "FAIL")).toEqual(["MC_MATCH"]);
    expect(codes(vetCarrier({ org, record: record({ insurance: { liabilityOnFileUsd: 300_000 } }), now: NOW }), "FAIL")).toEqual(["LIABILITY"]);
    expect(codes(vetCarrier({ org, record: record({ safetyRating: "UNSATISFACTORY" }), now: NOW }), "FAIL")).toEqual(["SAFETY"]);
  });

  it("asks for review on fraud signals", () => {
    const young = vetCarrier({ org, record: record({ authoritySince: "2026-08-20" }), now: NOW });
    expect(young).toMatchObject({ verdict: "REVIEW" });
    expect(young.checks.find((c) => c.code === "AUTHORITY_AGE")?.title).toBe("Authority 46 days old");
    expect(vetCarrier({ org, record: record({ authoritySince: "2026-08-20" }), policy: { minAuthorityDays: 30, minLiabilityUsd: 750_000, minCargoUsd: 100_000, allowConditional: false }, now: NOW }).verdict).toBe("PASS");

    // Someone signed up with a webmail address for a carrier whose FMCSA email is its own domain.
    const impostor = vetCarrier({ org, record: record(), contactEmails: ["bluelinetrucking.dispatch@gmail.com"], now: NOW });
    expect(impostor.checks.find((c) => c.code === "CONTACT_MATCH")).toMatchObject({ result: "REVIEW" });
    expect(impostor.checks.find((c) => c.code === "CONTACT_MATCH")?.detail).toContain("di••••••@bluelinetrucking.com");
    expect(impostor.checks.find((c) => c.code === "CONTACT_MATCH")?.detail).toContain("(901) 555-0100");

    // The FMCSA phone and email were changed last month: the classic hijack.
    const hijacked = vetCarrier({ org, record: record({ phone: "(305) 555-0199", email: "bluelinetrucking@outlook.com" }), history: [record({ fetchedAt: "2026-09-10T00:00:00Z" })], now: NOW });
    expect(hijacked.checks.find((c) => c.code === "RECENT_CHANGES")).toMatchObject({ result: "REVIEW", title: "FMCSA phone, email changed recently" });
    expect(vetCarrier({ org, record: record({ phone: "(305) 555-0199" }), history: [record({ fetchedAt: "2026-03-01T00:00:00Z" })], now: NOW }).checks.some((c) => c.code === "RECENT_CHANGES")).toBe(false);

    expect(codes(vetCarrier({ org: { ...org, name: "Speedy Freight Co" }, record: record(), now: NOW }), "REVIEW")).toEqual(["NAME_MATCH"]);
    expect(codes(vetCarrier({ org, record: record({ safetyRating: "CONDITIONAL" }), now: NOW }), "REVIEW")).toEqual(["SAFETY"]);
    expect(codes(vetCarrier({ org, record: record({ insurance: {} }), now: NOW }), "REVIEW")).toEqual(["LIABILITY"]);
    expect(codes(vetCarrier({ org, record: record(), otherOrgsWithDot: 1, now: NOW }), "REVIEW")).toEqual(["DUPLICATE_DOT"]);
  });

  it("matches company names loosely", () => {
    expect(namesMatch("Blue Line Trucking", "BLUE LINE TRUCKING LLC")).toBe(true);
    expect(namesMatch("J&R Transport Inc.", "J AND R TRANSPORT INC")).toBe(true);
    expect(namesMatch("Blue Line", "Red Line Logistics")).toBe(false);
  });
});
