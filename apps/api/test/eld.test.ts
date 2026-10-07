import type { EldClock, EldDriver, EldVehicleLocation } from "@logisticspro/domain";
import { describe, expect, it } from "vitest";
import { type EldClient, EldError } from "../src/services/eldClients.js";
import { syncAllEld } from "../src/services/eld.js";
import { NYC, api, harness, loadBody, signUp } from "./helpers.js";

class FakeEld implements EldClient {
  readonly provider = "SAMSARA" as const;
  drivers_: EldDriver[] = [];
  clocks_: EldClock[] = [];
  locations_: EldVehicleLocation[] = [];
  fail?: string;
  async drivers() {
    if (this.fail) throw new EldError(this.fail);
    return this.drivers_;
  }
  async clocks() {
    if (this.fail) throw new EldError(this.fail);
    return this.clocks_;
  }
  async locations() {
    return this.locations_;
  }
}

describe("ELD connections", () => {
  it("takes drivers' hours and trucks' GPS from the carrier's ELD", async () => {
    let now = Date.parse("2026-10-06T14:00:00Z");
    const eld = new FakeEld();
    const keys: string[] = [];
    const h = await harness({
      now: () => new Date(now),
      eldClient: (_p, creds) => {
        if ("apiKey" in creds) keys.push(creds.apiKey);
        return eld;
      },
    });
    const S = api(h, await signUp(h, "BUSINESS", "Shipper Sam"));
    const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
    const F = api(h, await signUp(h, "CARRIER", "Owner Olga"));
    const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"] })).org;
    const ana = await signUp(h, "TRUCKER", "Ana Alvarez");
    const ben = await signUp(h, "TRUCKER", "Ben Brown");
    for (const d of [ana, ben]) await F.post(`/v1/orgs/${fleet.id}/members`, { email: d.email, roles: ["DRIVER"] }, 201);
    const A = api(h, ana);

    // Wrong key: nothing saved.
    eld.fail = "The ELD account rejected the credentials";
    await F.put(`/v1/orgs/${fleet.id}/eld`, { provider: "SAMSARA", apiKey: "samsara_bad_key" }, 400);
    expect((await F.get(`/v1/orgs/${fleet.id}/eld`)).connected).toBe(false);
    eld.fail = undefined;

    // Drivers match by email, then by name; one stays unmatched.
    eld.drivers_ = [
      { externalId: "d1", name: "A. Alvarez", email: ana.email.toUpperCase() },
      { externalId: "d2", name: "Ben Brown" },
      { externalId: "d3", name: "Somebody Else" },
    ];
    eld.clocks_ = [{ externalDriverId: "d1", status: "DRIVING", driveLeftMin: 245, shiftLeftMin: 400, cycleLeftMin: 3000, breakLeftMin: 90, asOf: "2026-10-06T13:58:00Z" }];
    eld.locations_ = [{ externalVehicleId: "v1", name: "112", lat: 40.5, lng: -74.5, speedMps: 26, at: "2026-10-06T13:59:00Z", externalDriverId: "d1" }];
    await A.put(`/v1/orgs/${fleet.id}/eld`, { provider: "SAMSARA", apiKey: "samsara_live_abcd1234" }, 403);
    const conn = await F.put(`/v1/orgs/${fleet.id}/eld`, { provider: "SAMSARA", apiKey: "samsara_live_abcd1234" });
    expect(conn).toMatchObject({ connected: true, provider: "SAMSARA", label: "Key ending 1234", vehicles: 1 });
    expect(conn.drivers.map((d: { externalId: string; accountId?: string; match?: string }) => [d.externalId, d.accountId, d.match])).toEqual([["d1", ana.accountId, "AUTO"], ["d2", ben.accountId, "AUTO"], ["d3", undefined, undefined]]);
    expect(JSON.stringify(conn)).not.toContain("abcd1234\"");
    expect(conn.sealedCredentials).toBeUndefined();
    expect(h.ctx.store.eldConnections.get(fleet.id)!.sealedCredentials).not.toContain("samsara_live");
    expect(keys.at(-1)).toBe("samsara_live_abcd1234");

    // Ana's hours are the ELD's, and the app won't change her duty status.
    const hos = await A.get("/v1/me/hos");
    expect(hos).toMatchObject({ source: "ELD", eld: { provider: "SAMSARA" }, status: "DRIVING", drivingLeftMin: 245, windowLeftMin: 400, breakLeftMin: 90, availableMin: 90, limitedBy: "BREAK" });
    await A.post("/v1/me/duty-status", { status: "OFF_DUTY" }, 409);
    // Her truck's GPS is her position.
    expect(h.ctx.store.positions.get(ana.accountId)).toMatchObject({ geo: { lat: 40.5, lng: -74.5 }, source: "ELD" });

    // A load she's driving gets its ETA from the ELD clock and position.
    const load = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
    await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
    await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [ana.accountId] });
    for (const code of ["ARRIVED_PICKUP", "LOADED"]) await A.post(`/v1/loads/${load.id}/status`, { code });
    const tracking = await S.get(`/v1/loads/${load.id}/tracking`);
    expect(tracking.eta.position).toBeDefined();

    // Phone fixes for an ELD driver don't flip her duty status.
    await A.post("/v1/me/location", { lat: 40.6, lng: -74.4, speedMps: 0 });
    expect(h.ctx.store.dutyLogs.get(ana.accountId) ?? []).toEqual([]);

    // Manual links: Somebody Else is really Ben.
    const relinked = await F.put(`/v1/orgs/${fleet.id}/eld/drivers/d3`, { accountId: ben.accountId });
    expect(relinked.drivers.map((d: { externalId: string; accountId?: string; match?: string }) => [d.externalId, d.accountId, d.match])).toEqual([["d1", ana.accountId, "AUTO"], ["d2", undefined, undefined], ["d3", ben.accountId, "MANUAL"]]);
    expect(h.ctx.store.eldDrivers.get(ben.accountId)?.externalDriverId).toBe("d3");
    await F.put(`/v1/orgs/${fleet.id}/eld/drivers/d3`, { accountId: "acct_nobody" }, 400);

    // The job syncs every five minutes; an outage is recorded, not thrown.
    now += 6 * 60_000;
    eld.clocks_ = [{ ...eld.clocks_[0]!, driveLeftMin: 239, asOf: new Date(now).toISOString() }];
    await syncAllEld(h.ctx);
    expect((await A.get("/v1/me/hos")).drivingLeftMin).toBe(239);
    now += 6 * 60_000;
    eld.fail = "The ELD service answered 503";
    await syncAllEld(h.ctx);
    expect((await F.get(`/v1/orgs/${fleet.id}/eld`)).lastError).toBe("The ELD service answered 503");

    // A stale ELD clock gives way to the phone estimate.
    now += 20 * 60_000;
    expect((await A.get("/v1/me/hos")).source).toBe("PHONE");

    // Disconnecting hands hours back to the phone.
    await F.post(`/v1/orgs/${fleet.id}/eld/remove`, {});
    expect(h.ctx.store.eldDrivers.size).toBe(0);
    await A.post("/v1/me/duty-status", { status: "OFF_DUTY" });
  });
});
