import { describe, expect, it } from "vitest";
import type { MemoryPushSender } from "../src/services/push.js";
import { NYC, api, harness, loadBody, signUp } from "./helpers.js";

const DEE_PHONE = "ExponentPushToken[dee]";
const SAM_PHONE = "ExponentPushToken[sam]";
const ANA_PHONE = "ExponentPushToken[ana]";

async function world() {
  const h = await harness({ now: () => new Date("2026-10-05T15:00:00Z") });
  const push = h.ctx.push as MemoryPushSender;
  const S = api(h, await signUp(h, "BUSINESS", "Shipper Sam"));
  const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
  const F = api(h, await signUp(h, "CARRIER", "Dispatch Dee"));
  const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"], scac: "BIGF" })).org;
  const ana = await signUp(h, "TRUCKER", "Ana");
  await F.post(`/v1/orgs/${fleet.id}/members`, { email: ana.email, roles: ["DRIVER"] }, 201);
  const A = api(h, ana);
  await F.post("/v1/me/push-tokens", { token: DEE_PHONE, platform: "ios", timeZone: "America/Chicago" }, 201);
  await S.post("/v1/me/push-tokens", { token: SAM_PHONE, platform: "android", timeZone: "America/New_York" }, 201);
  await A.post("/v1/me/push-tokens", { token: ANA_PHONE, platform: "android" }, 201);
  const flush = async () => {
    await h.ctx.notifier.flush();
    const out = [...push.sent];
    push.sent.length = 0;
    return out;
  };
  return { h, push, S, acme, F, fleet, ana, A, flush };
}

describe("tender notifications", () => {
  it("tell the carrier's dispatch about a new tender, in their time zone, and the shipper about the answer", async () => {
    const { S, acme, F, fleet, flush } = await world();
    const load = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
    // Pickup 2026-10-06 13:00Z is 8:00 AM in Chicago.
    expect(await flush()).toEqual([
      { to: DEE_PHONE, title: `New tender ${load.loadNumber}`, body: "Acme Foods: Bronx, NY to Houston, TX, pickup Tue, Oct 6, 8:00 AM, $5,200. Accept or decline.", data: expect.objectContaining({ kind: "TENDER", open: "LOAD", loadId: load.id }) },
    ]);
    await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT", pro: "PRO-9" });
    expect(await flush()).toEqual([{ to: SAM_PHONE, title: `Tender accepted: ${load.loadNumber}`, body: "Big Fleet booked Bronx, NY to Houston, TX, PRO PRO-9.", data: expect.objectContaining({ open: "LOAD" }) }]);

    const second = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${second.id}/tender`, { carrierOrgId: fleet.id });
    await flush();
    await F.post(`/v1/loads/${second.id}/tender-response`, { decision: "DECLINE", reason: "No capacity" });
    expect((await flush()).map((m) => [m.to, m.title])).toEqual([[SAM_PHONE, `Tender declined: ${second.loadNumber}`]]);
  });

  it("covers awarded bids and tenders arriving by API or EDI", async () => {
    const { h, S, acme, F, fleet, flush } = await world();
    const posted = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${posted.id}/post`, {});
    const bid = await F.post(`/v1/loads/${posted.id}/bids`, { carrierOrgId: fleet.id, amount: { amount: 4900, currency: "USD" } }, 201);
    await flush();
    await S.post(`/v1/loads/${posted.id}/bids/${bid.id}/award`);
    expect((await flush()).map((m) => [m.to, m.title])).toEqual([[DEE_PHONE, `New tender ${posted.loadNumber}`]]);

    await F.put(`/v1/orgs/${fleet.id}/partners/megamart`, { name: "MegaMart", kind: "SHIPPER", channels: { LOAD_TENDER: { method: "API_JSON", endpoint: { url: "https://megamart.example/unused" } } } });
    const { inboundToken } = await F.post(`/v1/orgs/${fleet.id}/partners/megamart/inbound-token`);
    const party = (city: string, state: string) => ({ name: `${city} DC`, line1: "1 Main", city, state, postalCode: "75201", country: "US" });
    const tender = {
      purpose: "ORIGINAL", shipmentId: "MM-1", carrierScac: "BIGF", paymentTerms: "PREPAID", equipmentType: "DRY_VAN", references: { po: ["P"] }, billTo: party("Bentonville", "AR"),
      stops: [{ sequence: 1, type: "PICKUP", party: party("Dallas", "TX"), windowStart: "2026-10-06T13:00:00Z", windowEnd: "2026-10-06T15:00:00Z" }, { sequence: 2, type: "DELIVERY", party: party("Tulsa", "OK"), windowStart: "2026-10-07T13:00:00Z", windowEnd: "2026-10-07T15:00:00Z" }],
      items: [{ description: "Retail", pieces: 26, packaging: "PLT", weightLb: 22000 }], totalWeightLb: 22000, totalPieces: 26, rateUsd: 1450,
    };
    const res = await h.app.inject({ method: "POST", url: `/v1/inbound/${fleet.id}/megamart/load_tender`, payload: tender, headers: { "x-lp-inbound-token": inboundToken } });
    expect(res.statusCode, res.body).toBe(202);
    const sent = await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: DEE_PHONE, body: expect.stringMatching(/^MegaMart: Dallas, TX to Tulsa, OK, pickup Tue, Oct 6, 8:00 AM, \$1,450/) });
  });

  it("can be turned off", async () => {
    const { S, acme, F, fleet, flush } = await world();
    expect(await F.get("/v1/me/notification-settings")).toMatchObject({ tenders: true, messages: true, tendersApply: true, devices: 1, timeZone: "America/Chicago" });
    await F.put("/v1/me/notification-settings", { tenders: false });
    const load = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
    expect(await flush()).toEqual([]);
    expect((await F.get("/v1/me/notifications")).items).toEqual([]);
    await F.put("/v1/me/notification-settings", { timeZone: "Atlantis/Lost" }, 400);
  });
});

describe("message notifications", () => {
  it("reach everyone else on the load, open the thread, and clear when the thread is read", async () => {
    const { S, acme, F, fleet, ana, A, flush } = await world();
    const load = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
    await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
    await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [ana.accountId] });
    await flush();

    await S.post(`/v1/loads/${load.id}/messages`, { body: "Dock 4 please, the north gate is closed." }, 201);
    const sent = await flush();
    expect(sent.map((m) => m.to).sort()).toEqual([ANA_PHONE, DEE_PHONE].sort());
    expect(sent[0]).toMatchObject({ title: `Shipper Sam · ${load.loadNumber}`, body: "Dock 4 please, the north gate is closed.", data: expect.objectContaining({ kind: "MESSAGE", open: "THREAD", loadId: load.id, loadNumber: load.loadNumber }) });

    // Status updates are posted to the thread too, but they are not chat: no push.
    await A.post(`/v1/loads/${load.id}/status`, { code: "ARRIVED_PICKUP" });
    expect(await flush()).toEqual([]);

    // Ana mutes messages; Sam and Dee still hear her.
    await A.put("/v1/me/notification-settings", { messages: false });
    await A.post(`/v1/loads/${load.id}/messages`, { body: "Got it, 20 minutes out." }, 201);
    expect((await flush()).map((m) => m.to).sort()).toEqual([DEE_PHONE, SAM_PHONE].sort());
    await F.post(`/v1/loads/${load.id}/messages`, { body: "Thanks both." }, 201);
    expect((await flush()).map((m) => m.to)).toEqual([SAM_PHONE]);

    // Two messages plus the earlier "Tender accepted".
    expect((await S.get("/v1/me/notifications")).unread).toBe(3);
    await S.get(`/v1/loads/${load.id}/messages`);
    const after = await S.get("/v1/me/notifications");
    expect(after.unread).toBe(1);
    expect(after.items.filter((i: { read: boolean }) => !i.read).map((i: { kind: string }) => i.kind)).toEqual(["TENDER"]);
  });
});
