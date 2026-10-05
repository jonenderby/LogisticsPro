import { describe, expect, it } from "vitest";
import { NYC, api, harness, loadBody, signUp } from "./helpers.js";

describe("rate confirmations", () => {
  it("is signed by both sides at acceptance, revised when the shipper changes the load, and voided on release", async () => {
    const h = await harness({ now: () => new Date("2026-10-05T15:00:00Z") });
    const sam = await signUp(h, "BUSINESS", "Shipper Sam");
    const S = api(h, sam);
    const acme = (await S.post("/v1/orgs", { name: "Acme <Foods>", kinds: ["SHIPPER"], address: NYC })).org;
    await S.put(`/v1/orgs/${acme.id}/payer-terms`, { termsDays: 21, quickPay: { days: 2, feePct: 2.5 } });
    const F = api(h, await signUp(h, "CARRIER", "Dispatch Dee"));
    const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"], scac: "BIGF", mcNumber: "123456", dotNumber: "7654321" })).org;
    await F.put(`/v1/orgs/${fleet.id}/detention`, { freeHours: 2, ratePerHour: 80 });
    const ana = await signUp(h, "TRUCKER", "Ana");
    await F.post(`/v1/orgs/${fleet.id}/members`, { email: ana.email, roles: ["DRIVER"] }, 201);
    const other = api(h, await signUp(h, "BUSINESS", "Nosy Ned"));

    const load = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
    expect((await S.get(`/v1/loads/${load.id}/rate-confirmation`)).current).toBeUndefined();
    await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT", pro: "BF-1" });

    const v1 = (await F.get(`/v1/loads/${load.id}/rate-confirmation`)).current;
    expect(v1).toMatchObject({
      version: 1,
      status: "SIGNED",
      loadNumber: load.loadNumber,
      tendering: { orgId: acme.id, name: "Acme <Foods>" },
      carrier: { orgId: fleet.id, name: "Big Fleet", mcNumber: "123456", dotNumber: "7654321" },
      rate: { amount: 5200, currency: "USD" },
      detention: { freeHours: 2, ratePerHour: 80 },
      payment: { days: 21, quickPay: { days: 2, feePct: 2.5 } },
      references: { bol: "BOL-1", po: ["PO-77"], pro: "BF-1" },
      commodity: { description: "Frozen food", pieces: 20, weightLb: 38000, hazmat: false },
    });
    expect(v1.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(v1.signatures.map((s: { side: string; name: string; method: string }) => [s.side, s.name, s.method])).toEqual([
      ["TENDERING", "Shipper Sam", "TENDER"],
      ["CARRIER", "Dispatch Dee", "ACCEPTANCE"],
    ]);
    await other.get(`/v1/loads/${load.id}/rate-confirmation`, 404);

    // Printable copy, with everything escaped.
    const html = await h.app.inject({ method: "GET", url: `/v1/loads/${load.id}/rate-confirmation?format=html`, headers: { authorization: `Bearer ${sam.token}` } });
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(html.body).toContain("Acme &lt;Foods&gt;");
    expect(html.body).not.toContain("Acme <Foods>");
    expect(html.body).toContain(v1.hash);
    expect(html.body).toContain("$5,200.00");

    // The carrier's own work (dispatching a driver) does not reopen the agreement.
    await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [ana.accountId] });
    expect((await F.get(`/v1/loads/${load.id}/rate-confirmation`)).versions).toHaveLength(1);

    // The shipper moves the delivery appointment: version 2 waits on the carrier.
    const stops = (await S.get(`/v1/loads/${load.id}`)).stops;
    stops[1].window = { start: "2026-10-08T16:00:00Z", end: "2026-10-08T20:00:00Z" };
    await S.patch(`/v1/loads/${load.id}`, { stops: stops.map((s: Record<string, unknown>) => ({ id: s.id, type: s.type, address: s.address, window: s.window, contact: s.contact })) });
    const after = await F.get(`/v1/loads/${load.id}/rate-confirmation`);
    expect(after.versions.map((v: { version: number; status: string }) => `${v.version}:${v.status}`)).toEqual(["1:SUPERSEDED", "2:AWAITING_CARRIER"]);
    expect(after.current.changes).toEqual(["Stops or appointment times"]);
    expect(after.current.hash).not.toBe(v1.hash);
    expect((await F.get("/v1/me")).feed).toEqual(expect.arrayContaining([expect.objectContaining({ id: `ratecon:${load.id}`, title: `Sign rate confirmation ${load.loadNumber} v2`, cta: { label: "Review and sign", action: "rate-con" } })]));
    await S.post(`/v1/loads/${load.id}/rate-confirmation/sign`, {}, 403);
    const signed = await F.post(`/v1/loads/${load.id}/rate-confirmation/sign`);
    expect(signed.status).toBe("SIGNED");
    expect(signed.signatures.map((s: { side: string; method: string }) => `${s.side}:${s.method}`)).toEqual(["TENDERING:SIGNED", "CARRIER:SIGNED"]);
    await F.post(`/v1/loads/${load.id}/rate-confirmation/sign`, {}, 409);
    expect((await F.get("/v1/me")).feed.some((i: { id: string }) => i.id.startsWith("ratecon:"))).toBe(false);
    const thread = await S.get(`/v1/loads/${load.id}/messages`);
    expect(thread.map((m: { body: string }) => m.body)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Rate confirmation v1 signed by both sides/),
      "Rate confirmation v2 needs the carrier's signature. Changed: Stops or appointment times.",
      "Carrier signed rate confirmation v2.",
    ]));

    // Releasing the carrier voids it.
    await S.post(`/v1/loads/${load.id}/release-carrier`);
    const voided = await S.get(`/v1/loads/${load.id}/rate-confirmation`);
    expect(voided.current.status).toBe("VOID");
  });
});
