import { describe, expect, it } from "vitest";
import { NYC, api, harness, loadBody, signUp } from "./helpers.js";

describe("reliability profiles", () => {
  it("scores the carrier and drivers per business and overall, from real shipments", async () => {
    const h = await harness();
    const A = api(h, await signUp(h, "BUSINESS", "Company A"));
    const companyA = (await A.post("/v1/orgs", { name: "Company A", kinds: ["SHIPPER"], address: NYC })).org;
    const C = api(h, await signUp(h, "BUSINESS", "Company C"));
    const companyC = (await C.post("/v1/orgs", { name: "Company C", kinds: ["SHIPPER"], address: NYC })).org;
    const owner = await signUp(h, "CARRIER", "Carrier B Owner");
    const F = api(h, owner);
    const fleet = (await F.post("/v1/orgs", { name: "Carrier B", kinds: ["CARRIER"], scac: "CARB" })).org;
    const drivers: Awaited<ReturnType<typeof signUp>>[] = [];
    for (const n of ["Dana", "Eli"]) {
      const d = await signUp(h, "TRUCKER", n);
      await F.post(`/v1/orgs/${fleet.id}/members`, { email: d.email, roles: ["DRIVER"] }, 201);
      drivers.push(d);
    }
    const D = api(h, drivers[0]!);

    const run = async (S: ReturnType<typeof api>, orgId: string, o: { lateDelivery?: boolean; damage?: boolean } = {}) => {
      const load = await S.post("/v1/loads", loadBody(orgId), 201);
      await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
      await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
      await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [drivers[0]!.accountId] });
      await S.post(`/v1/loads/${load.id}/exceptions`, { type: "DAMAGE", note: "too early" }, 409);
      await D.post(`/v1/loads/${load.id}/status`, { code: "ARRIVED_PICKUP", at: "2026-10-06T13:30:00Z" });
      await D.post(`/v1/loads/${load.id}/status`, { code: "LOADED", at: "2026-10-06T14:10:00Z" });
      await D.post(`/v1/loads/${load.id}/status`, { code: "ARRIVED_DELIVERY", at: o.lateDelivery ? "2026-10-08T20:00:00Z" : "2026-10-08T15:00:00Z" });
      await D.post(`/v1/loads/${load.id}/status`, { code: "DELIVERED", at: o.lateDelivery ? "2026-10-08T21:00:00Z" : "2026-10-08T16:00:00Z" });
      if (o.damage) await S.post(`/v1/loads/${load.id}/exceptions`, { type: "DAMAGE", note: "Two cases crushed", pieces: 2 }, 201);
      return load;
    };
    for (let i = 0; i < 4; i++) await run(A, companyA.id);
    await run(C, companyC.id, { lateDelivery: true });
    await run(C, companyC.id, { lateDelivery: true, damage: true });
    await run(C, companyC.id);
    await run(C, companyC.id);

    // The carrier sees everything, with windows scaled to its two truckers.
    const mine = await F.get(`/v1/reliability/carriers/${fleet.id}`);
    expect(mine).toMatchObject({ truckers: 2, windows: { overall: 2000, perBusiness: 200 }, overall: { shipments: 8, onTimePickupPct: 100, onTimeDeliveryPct: 75, damageFreePct: 87.5 } });
    expect(mine.byBusiness.map((b: { businessName: string; score: number }) => [b.businessName, b.score])).toEqual([["Company A", 100], ["Company C", 75]]);

    // Company A sees a perfect record with itself; it cannot look at C's relationship.
    const seenByA = await A.get(`/v1/reliability/carriers/${fleet.id}`);
    expect(seenByA.forBusiness).toMatchObject({ businessOrgId: companyA.id, shipments: 4, score: 100 });
    expect(seenByA.byBusiness).toBeUndefined();
    await A.get(`/v1/reliability/carriers/${fleet.id}?businessOrgId=${companyC.id}`, 403);
    const seenByC = await C.get(`/v1/reliability/carriers/${fleet.id}`);
    expect(seenByC.forBusiness).toMatchObject({ shipments: 4, onTimeDeliveryPct: 50, damageFreePct: 75 });

    // When A reviews bids, each bid carries the carrier's record overall and with A.
    const posted = await A.post("/v1/loads", loadBody(companyA.id), 201);
    await A.post(`/v1/loads/${posted.id}/post`, {});
    await F.post(`/v1/loads/${posted.id}/bids`, { carrierOrgId: fleet.id, amount: { amount: 5000, currency: "USD" } }, 201);
    const [bid] = await A.get(`/v1/loads/${posted.id}/bids`);
    expect(bid).toMatchObject({ carrierName: "Carrier B", reliability: { withYou: { score: 100 }, overall: { shipments: 8 }, truckers: 2 } });

    // Drivers: the driver sees their own; dispatch sees them per customer when picking who runs a load.
    const self = await D.get(`/v1/reliability/drivers/${drivers[0]!.accountId}?businessOrgId=${companyC.id}`);
    expect(self).toMatchObject({ windows: { overall: 1000, perBusiness: 100 }, overall: { shipments: 8 }, forBusiness: { shipments: 4, onTimeDeliveryPct: 50 } });
    const roster = await F.get(`/v1/orgs/${fleet.id}/drivers?businessOrgId=${companyA.id}`);
    expect(roster.find((d: { id: string }) => d.id === drivers[0]!.accountId).reliability.forBusiness).toMatchObject({ score: 100 });
    expect(roster.find((d: { id: string }) => d.id === drivers[1]!.accountId).reliability.overall.shipments).toBe(0);
    await A.get(`/v1/reliability/drivers/${drivers[0]!.accountId}`, 403);
    expect((await A.get(`/v1/loads/${posted.id}/exceptions`))).toEqual([]);
  });
});
