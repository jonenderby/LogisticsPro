import { describe, expect, it } from "vitest";
import { NYC, api, harness, loadBody, signUp } from "./helpers.js";

describe("driver settlement", () => {
  it("pays each driver for a week's loads by their pay rule, once", async () => {
    let now = Date.parse("2026-10-06T12:00:00Z");
    const h = await harness({ now: () => new Date(now) });
    const S = api(h, await signUp(h, "BUSINESS", "Shipper Sue"));
    const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
    const owner = await signUp(h, "CARRIER", "Owner Ollie");
    const F = api(h, owner);
    const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"], scac: "BIGF" })).org;
    const ana = await signUp(h, "TRUCKER", "Ana");
    const ben = await signUp(h, "TRUCKER", "Ben");
    for (const d of [ana, ben]) await F.post(`/v1/orgs/${fleet.id}/members`, { email: d.email, roles: ["DRIVER"] }, 201);
    const A = api(h, ana);

    const deliver = async (driverIds: string[]) => {
      const load = await S.post("/v1/loads", loadBody(acme.id), 201);
      await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
      await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
      await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: driverIds });
      for (const code of ["LOADED", "DELIVERED"]) await F.post(`/v1/loads/${load.id}/status`, { code });
      return load;
    };
    const solo = await deliver([ana.accountId]);
    const team = await deliver([ana.accountId, ben.accountId]);

    // Ana is paid 25% of linehaul; Ben has no rule yet. Drivers can't set rules.
    await A.put(`/v1/orgs/${fleet.id}/drivers/${ana.accountId}/pay`, { kind: "PERCENT", rate: 25 }, 403);
    await F.put(`/v1/orgs/${fleet.id}/drivers/${ana.accountId}/pay`, { kind: "PERCENT", rate: 125 }, 400);
    await F.put(`/v1/orgs/${fleet.id}/drivers/${ana.accountId}/pay`, { kind: "PERCENT", rate: 25 });
    expect((await F.get(`/v1/orgs/${fleet.id}/driver-pay`)).map((d: { name: string; rule: { rate: number } | null }) => [d.name, d.rule?.rate ?? null])).toEqual([["Ana", 25], ["Ben", null]]);

    now = Date.parse("2026-10-12T12:00:00Z");
    const made = await F.post(`/v1/orgs/${fleet.id}/settlements`, { periodStart: "2026-10-05", periodEnd: "2026-10-11" }, 201);
    expect(made.driversWithoutPayRule).toEqual(["Ben"]);
    expect(made.created).toHaveLength(1);
    const st = made.created[0];
    // $5,200 × 25% for the solo load, half of that for the team load.
    expect(st.lines.map((l: { loadNumber: string; amount: number }) => [l.loadNumber, l.amount])).toEqual([[solo.loadNumber, 1300], [team.loadNumber, 650]]);
    expect(st.total).toBe(1950);
    // Drafts are the office's; the driver doesn't see them yet.
    expect(await A.get("/v1/me/settlements")).toEqual([]);
    await A.get(`/v1/settlements/${st.id}`, 404);

    // A fuel advance comes off; the same loads aren't paid twice.
    const adjusted = await F.post(`/v1/settlements/${st.id}/adjustments`, { description: "Fuel advance", amount: -200 }, 201);
    expect(adjusted.total).toBe(1750);
    expect((await F.post(`/v1/orgs/${fleet.id}/settlements`, { periodStart: "2026-10-05", periodEnd: "2026-10-11" }, 201)).created).toEqual([]);

    // Approved: the driver sees it and is told.
    await F.post(`/v1/settlements/${st.id}/paid`, {}, 409);
    await F.post(`/v1/settlements/${st.id}/approve`);
    await F.post(`/v1/settlements/${st.id}/adjustments`, { description: "Late", amount: 10 }, 409);
    expect((await A.get("/v1/me/settlements")).map((s: { total: number; status: string; carrierName: string }) => [s.total, s.status, s.carrierName])).toEqual([[1750, "APPROVED", "Big Fleet"]]);
    expect((await A.get("/v1/me/notifications")).items[0]).toMatchObject({ title: "Pay statement 2026-10-05 to 2026-10-11", body: "Big Fleet: $1,750.00 for 2 loads.", target: "SETTLEMENT", settlementId: st.id });
    const paid = await F.post(`/v1/settlements/${st.id}/paid`, { reference: "DD 4471" });
    expect(paid).toMatchObject({ status: "PAID", paidReference: "DD 4471" });

    // CSV for payroll.
    const csv = await h.app.inject({ method: "GET", url: `/v1/orgs/${fleet.id}/settlements.csv?periodStart=2026-10-05`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[0]).toBe("Driver,Period start,Period end,Load,Delivered,Lane,Basis,Amount");
    expect(csv.body).toContain("Ana,2026-10-05,2026-10-11,,,,Total,1750.00");

    // Ben's rule set later: his half of the team load is still owed.
    await F.put(`/v1/orgs/${fleet.id}/drivers/${ben.accountId}/pay`, { kind: "PER_LOAD", rate: 300 });
    const benSt = (await F.post(`/v1/orgs/${fleet.id}/settlements`, { periodStart: "2026-10-05", periodEnd: "2026-10-11" }, 201)).created;
    expect(benSt.map((s: { driverName: string; total: number }) => [s.driverName, s.total])).toEqual([["Ben", 150]]);
    await F.post(`/v1/settlements/${benSt[0].id}/discard`);
    expect((await F.get(`/v1/orgs/${fleet.id}/settlements`)).map((s: { driverName: string }) => s.driverName)).toEqual(["Ana"]);
  });
});
