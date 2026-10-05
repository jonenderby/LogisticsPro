import type { FmcsaRecord } from "@logisticspro/domain";
import { describe, expect, it } from "vitest";
import { StaticFmcsa } from "../src/services/fmcsa.js";
import { recheckCarriers } from "../src/services/vetting.js";
import { NYC, api, harness, loadBody, signUp } from "./helpers.js";

const record = (dot: string, legalName: string, over: Partial<FmcsaRecord> = {}): FmcsaRecord => ({
  dotNumber: dot,
  mcNumbers: [],
  legalName,
  allowedToOperate: true,
  outOfService: false,
  authority: { common: "ACTIVE", contract: "NONE", broker: "NONE" },
  authoritySince: "2018-01-01",
  insurance: { liabilityOnFileUsd: 1_000_000 },
  safetyRating: "SATISFACTORY",
  fetchedAt: "2026-10-05T12:00:00Z",
  ...over,
});

describe("carrier vetting", () => {
  it("refuses carriers that fail, holds ones needing review until approved, and re-checks carriers on loads", async () => {
    let now = Date.parse("2026-10-05T12:00:00Z");
    const fmcsa = new StaticFmcsa(
      new Map([
        ["1111111", record("1111111", "GOOD HAUL LLC")],
        ["2222222", record("2222222", "SHADY BROKERAGE INC", { authority: { common: "NONE", contract: "NONE", broker: "ACTIVE" } })],
        ["3333333", record("3333333", "FRESH START TRUCKING", { authoritySince: "2026-09-01" })],
      ]),
    );
    const h = await harness({ now: () => new Date(now), fmcsa });
    const S = api(h, await signUp(h, "BUSINESS", "Shipper Sam"));
    const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
    const carrier = async (name: string, dotNumber?: string) => {
      const owner = api(h, await signUp(h, "CARRIER", `${name} Owner`));
      return { api: owner, org: (await owner.post("/v1/orgs", { name, kinds: ["CARRIER"], dotNumber })).org };
    };
    const good = await carrier("Good Haul", "1111111");
    const shady = await carrier("Shady Brokerage", "2222222");
    const fresh = await carrier("Fresh Start Trucking", "3333333");
    const nodot = await carrier("No Dot Inc");
    const newLoad = () => S.post("/v1/loads", loadBody(acme.id), 201);

    const ok = await newLoad();
    await S.post(`/v1/loads/${ok.id}/tender`, { carrierOrgId: good.org.id });
    expect((await S.get(`/v1/carriers/${good.org.id}/vetting`)).verdict).toBe("PASS");

    const l2 = await newLoad();
    await S.post(`/v1/loads/${l2.id}/tender`, { carrierOrgId: shady.org.id }, 409);
    await S.post(`/v1/loads/${l2.id}/tender`, { carrierOrgId: nodot.org.id }, 409);
    const shadyCheck = await S.get(`/v1/carriers/${shady.org.id}/vetting`);
    expect(shadyCheck).toMatchObject({ verdict: "FAIL", payerOrgId: acme.id, record: { legalName: "SHADY BROKERAGE INC" } });
    expect(shadyCheck.checks.find((c: { code: string }) => c.code === "AUTHORITY").title).toBe("Broker authority only");
    await S.post(`/v1/orgs/${acme.id}/carrier-approvals`, { carrierOrgId: shady.org.id, note: "Looks fine" }, 409);

    // Needs review: refused until someone at Acme approves it.
    await S.post(`/v1/loads/${l2.id}/tender`, { carrierOrgId: fresh.org.id }, 409);
    expect((await S.get(`/v1/carriers/${fresh.org.id}/vetting`)).checks.find((c: { code: string }) => c.code === "AUTHORITY_AGE")).toMatchObject({ result: "REVIEW", title: "Authority 34 days old" });
    await good.api.post(`/v1/orgs/${acme.id}/carrier-approvals`, { carrierOrgId: fresh.org.id, note: "Called them" }, 403);
    await S.post(`/v1/orgs/${acme.id}/carrier-approvals`, { carrierOrgId: fresh.org.id, note: "Called the FMCSA number, spoke to the owner" }, 201);
    expect((await S.get(`/v1/carriers/${fresh.org.id}/vetting`)).approval).toMatchObject({ approvedByName: "Shipper Sam", note: "Called the FMCSA number, spoke to the owner" });
    await S.post(`/v1/loads/${l2.id}/tender`, { carrierOrgId: fresh.org.id });

    // A shipper with a 30-day rule doesn't need to approve it.
    await S.put(`/v1/orgs/${acme.id}/vetting-policy`, { minAuthorityDays: 30, minLiabilityUsd: 750000, minCargoUsd: 100000, allowConditional: false });
    expect((await S.get(`/v1/carriers/${fresh.org.id}/vetting`)).verdict).toBe("PASS");

    // The carrier sees its own check; an unrelated carrier doesn't.
    expect((await good.api.get(`/v1/carriers/${good.org.id}/vetting`)).verdict).toBe("PASS");
    await shady.api.get(`/v1/carriers/${good.org.id}/vetting`, 403);

    // Bids show each bidder's check.
    const posted = await newLoad();
    await S.post(`/v1/loads/${posted.id}/post`, {});
    await shady.api.post(`/v1/loads/${posted.id}/bids`, { carrierOrgId: shady.org.id, amount: { amount: 4000, currency: "USD" }, plan: "SOLO" }, 201);
    const bids = await S.get(`/v1/loads/${posted.id}/bids`);
    expect(bids[0]).toMatchObject({ carrierName: "Shady Brokerage", vetting: { verdict: "FAIL", approved: false } });
    await S.post(`/v1/loads/${posted.id}/bids/${bids[0].id}/award`, {}, 409);

    // The carrier on a load is re-checked daily; going out of service tells the shipper once.
    await good.api.post(`/v1/loads/${ok.id}/tender-response`, { decision: "ACCEPT" });
    expect(await recheckCarriers(h.ctx)).toBe(0);
    fmcsa.records.set("1111111", record("1111111", "GOOD HAUL LLC", { outOfService: true, outOfServiceDate: "2026-10-06", fetchedAt: "2026-10-06T13:00:00Z" }));
    now += 25 * 3_600_000;
    expect(await recheckCarriers(h.ctx)).toBe(1);
    expect(await recheckCarriers(h.ctx)).toBe(0);
    expect((await S.get("/v1/me/notifications")).items[0]).toMatchObject({ kind: "VETTING", loadId: ok.id, title: `Carrier check failed: ${ok.loadNumber}` });
    expect((await S.get(`/v1/loads/${ok.id}/carrier-check`)).carrier).toMatchObject({ name: "Good Haul", verdict: "FAIL" });
  });

  it("flags a pickup made without the carrier's driver at the dock", async () => {
    const h = await harness({ now: () => new Date("2026-10-06T13:30:00Z") });
    const S = api(h, await signUp(h, "BUSINESS", "Shipper Sam"));
    const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
    const F = api(h, await signUp(h, "CARRIER", "Owner Olga"));
    const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"] })).org;
    const ana = await signUp(h, "TRUCKER", "Ana");
    await F.post(`/v1/orgs/${fleet.id}/members`, { email: ana.email, roles: ["DRIVER"] }, 201);
    const A = api(h, ana);
    const load = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
    await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
    await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [ana.accountId] });
    expect((await S.get(`/v1/loads/${load.id}/carrier-check`)).pickup.status).toBe("PENDING");
    expect((await S.get(`/v1/loads/${load.id}/carrier-check`)).carrier.verdict).toBe("NOT_CHECKED");
    await F.get(`/v1/loads/${load.id}/carrier-check`, 403);
    for (const code of ["ARRIVED_PICKUP", "LOADED"]) await A.post(`/v1/loads/${load.id}/status`, { code });
    expect((await S.get(`/v1/loads/${load.id}/carrier-check`)).pickup.status).toBe("UNVERIFIED");

    // With the driver's phone at the dock, it's verified.
    const load2 = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${load2.id}/tender`, { carrierOrgId: fleet.id });
    await F.post(`/v1/loads/${load2.id}/tender-response`, { decision: "ACCEPT" });
    await F.post(`/v1/loads/${load2.id}/legs/first/assign`, { driverAccountIds: [ana.accountId] });
    await A.post("/v1/me/location", { lat: NYC.geo.lat, lng: NYC.geo.lng, speedMps: 0 });
    expect((await S.get(`/v1/loads/${load2.id}/carrier-check`)).pickup.status).toBe("VERIFIED");
  });
});
