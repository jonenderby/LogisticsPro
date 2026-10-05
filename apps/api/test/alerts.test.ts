import { describe, expect, it } from "vitest";
import type { MemoryPushSender } from "../src/services/push.js";
import { HOU, NYC, api, harness, loadBody, signUp } from "./helpers.js";

// Loads deliver to Houston 2026-10-08 14:00-18:00Z. Chicago is UTC-5 then.
const nearHouston = (miles: number) => ({ lat: HOU.geo.lat + miles / 69.05, lng: HOU.geo.lng });
const PHONE = "ExponentPushToken[sam-phone]";

async function world() {
  let now = Date.parse("2026-10-08T14:00:00Z");
  const h = await harness({ now: () => new Date(now) });
  const at = (iso: string) => (now = Date.parse(iso));
  const push = h.ctx.push as MemoryPushSender;
  const S = api(h, await signUp(h, "BUSINESS", "Shipper Sam"));
  const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
  const F = api(h, await signUp(h, "CARRIER", "Dispatch Dee"));
  const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"], scac: "BIGF" })).org;
  const ana = await signUp(h, "TRUCKER", "Ana");
  await F.post(`/v1/orgs/${fleet.id}/members`, { email: ana.email, roles: ["DRIVER"] }, 201);
  const A = api(h, ana);
  const load = await S.post("/v1/loads", loadBody(acme.id), 201);
  await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
  await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
  await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [ana.accountId] });
  await A.post(`/v1/loads/${load.id}/status`, { code: "LOADED", at: "2026-10-06T14:00:00Z" });
  await A.post("/v1/me/location", { ...nearHouston(40), at: "2026-10-08T13:58:00Z" });
  const tick = () => h.ctx.alerts.tick();
  const status = async () => (await S.get("/v1/tracking/shipments")).shipments[0].eta.status;
  return { h, at, push, S, F, A, ana, load, tick, status };
}

describe("arrival alerts", () => {
  it("pushes the moment a shipment becomes at risk, then late, only to people who asked", async () => {
    const { at, push, S, F, A, load, tick, status } = await world();
    await S.put("/v1/me/alert-preferences", { statuses: ["LATE", "AT_RISK"], instant: true, timeZone: "America/Chicago" });
    await S.post("/v1/me/push-tokens", { token: PHONE, platform: "ios" }, 201);
    // Dee only wants to know when something is late.
    await F.put("/v1/me/alert-preferences", { statuses: ["LATE"], instant: true, timeZone: "America/Chicago" });

    expect(await status()).toBe("ON_TIME");
    expect(await tick()).toEqual({ alerts: 0, summaries: 0 });

    // Ana's phone goes quiet: at risk.
    at("2026-10-08T16:30:00Z");
    expect(await status()).toBe("AT_RISK");
    expect(await tick()).toEqual({ alerts: 1, summaries: 0 });
    expect(push.sent).toEqual([{ to: PHONE, title: `${load.loadNumber} is at risk of arriving late`, body: expect.stringMatching(/^Bronx, NY to Houston, TX\. ETA Thu .* window Thu 9:00 AM to Thu 1:00 PM\./), data: expect.objectContaining({ loadId: load.id }) }]);
    expect(await tick()).toEqual({ alerts: 0, summaries: 0 });

    // Past the window: late. Both hear about it; Dee has no phone, so it waits in the inbox.
    at("2026-10-08T18:40:00Z");
    expect(await status()).toBe("LATE");
    expect(await tick()).toEqual({ alerts: 2, summaries: 0 });
    expect(push.sent.at(-1)!.title).toBe(`${load.loadNumber} will be late`);
    const inbox = await F.get("/v1/me/notifications");
    // Dee's inbox also holds the tender she received when the load was booked.
    expect(inbox).toMatchObject({ unread: 2, items: [{ kind: "ARRIVAL", status: "LATE", loadId: load.id, target: "LOAD" }, { kind: "TENDER" }] });
    await F.post("/v1/me/notifications/read", {});
    expect((await F.get("/v1/me/notifications")).unread).toBe(0);

    // The driver is never alerted about their own load.
    expect((await A.get("/v1/me/notifications")).items).toEqual([]);
    await A.put("/v1/me/alert-preferences", { statuses: ["LATE"], instant: true, timeZone: "UTC" }, 403);
  });

  it("only sends good news to people who asked for it, and not on first sight", async () => {
    const { at, push, S, A, load, tick } = await world();
    await S.put("/v1/me/alert-preferences", { statuses: ["ON_TIME", "EARLY"], instant: true, timeZone: "UTC" });
    await S.post("/v1/me/push-tokens", { token: PHONE, platform: "android" }, 201);
    await tick();
    expect(push.sent).toEqual([]);
    at("2026-10-08T16:30:00Z");
    await tick(); // at risk: Sam did not ask
    expect(push.sent).toEqual([]);
    // Ana's phone reports again: back on time.
    await A.post("/v1/me/location", { ...nearHouston(10), at: "2026-10-08T16:29:00Z" });
    await tick();
    expect(push.sent.map((m) => m.title)).toEqual([`${load.loadNumber} is on time`]);
  });

  it("does not repeat a flip-flop within four hours", async () => {
    const { h, at, push, S, A, load, tick, status } = await world();
    await S.put("/v1/me/alert-preferences", { statuses: ["AT_RISK"], instant: true, timeZone: "UTC" });
    await S.post("/v1/me/push-tokens", { token: PHONE, platform: "ios" }, 201);
    at("2026-10-08T16:20:00Z");
    await tick();
    expect(push.sent).toHaveLength(1);
    // Ana's phone checks in close to Houston: back on time.
    await A.post("/v1/me/location", { ...nearHouston(10), at: "2026-10-08T16:19:00Z" });
    await tick();
    expect(await status()).toBe("ON_TIME");
    // Then she reports a delay: at risk again, but Sam already heard that 1 minute ago.
    at("2026-10-08T16:21:00Z");
    await A.post(`/v1/loads/${load.id}/status`, { code: "DELAYED", reason: "TRAFFIC", at: "2026-10-08T16:21:00Z" });
    await tick();
    expect(await status()).toBe("AT_RISK");
    expect(h.ctx.store.arrivalSeen.get(load.id)).toBe("AT_RISK");
    expect(push.sent).toHaveLength(1);
  });

  it("sends a scheduled summary at the person's local times, once per slot", async () => {
    const { at, push, S, tick } = await world();
    await S.put("/v1/me/alert-preferences", { statuses: ["LATE", "AT_RISK"], instant: false, timeZone: "America/Chicago", schedule: { times: ["11:30", "07:00"], days: [1, 2, 3, 4, 5] } });
    await S.post("/v1/me/push-tokens", { token: PHONE, platform: "ios" }, 201);
    // 11:30 Chicago is 16:30Z; the shipment is at risk by then. Nothing was due at 07:00 (12:00Z): skipped when empty.
    at("2026-10-08T12:10:00Z");
    expect(await tick()).toEqual({ alerts: 0, summaries: 0 });
    at("2026-10-08T16:31:00Z");
    expect(await tick()).toEqual({ alerts: 0, summaries: 1 });
    expect(push.sent[0]).toMatchObject({ title: "Shipments: 1 at risk", body: expect.stringMatching(/^LP-\d+ at risk, ETA Thu/) });
    at("2026-10-08T16:40:00Z");
    expect(await tick()).toEqual({ alerts: 0, summaries: 0 });
    const prefs = await S.get("/v1/me/alert-preferences");
    expect(prefs).toMatchObject({ enabled: true, devices: 1, schedule: { times: ["07:00", "11:30"], skipWhenEmpty: true } });
  });

  it("validates settings and phones, forgets dead phones, and can send a test", async () => {
    const { h, push, S } = await world();
    expect(await S.get("/v1/me/alert-preferences")).toMatchObject({ enabled: false, eligible: true, statuses: ["LATE", "AT_RISK"] });
    await S.put("/v1/me/alert-preferences", { statuses: ["LATE"], instant: false, timeZone: "UTC" }, 400);
    await S.put("/v1/me/alert-preferences", { statuses: ["LATE"], instant: true, timeZone: "Nowhere/Land" }, 400);
    await S.post("/v1/me/push-tokens", { token: "not-a-token", platform: "ios" }, 400);
    await S.post("/v1/me/push-tokens", { token: PHONE, platform: "ios" }, 201);

    // The same phone signing in as someone else moves to them.
    const other = api(h, await signUp(h, "BUSINESS", "Other"));
    await other.post("/v1/me/push-tokens", { token: PHONE, platform: "ios" }, 201);
    expect(h.ctx.store.pushTokens.get((await S.get("/v1/me")).account.id)).toEqual([]);
    await S.post("/v1/me/push-tokens", { token: PHONE, platform: "ios" }, 201);

    expect(await S.post("/v1/me/alert-preferences/test")).toEqual({ devices: 1 });
    expect(push.sent.at(-1)).toMatchObject({ to: PHONE, title: "Arrival alerts are on" });
    push.dead.add(PHONE);
    await S.post("/v1/me/alert-preferences/test");
    expect((await S.get("/v1/me/alert-preferences")).devices).toBe(0);
    await S.post("/v1/me/push-tokens/remove", { token: PHONE });
  });
});
