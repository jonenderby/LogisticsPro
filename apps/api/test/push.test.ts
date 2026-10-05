import { describe, expect, it } from "vitest";
import { ExpoPushSender, type MemoryPushSender } from "../src/services/push.js";
import { api, harness, signUp } from "./helpers.js";

describe("Expo push sender", () => {
  it("reads tickets when sending and receipts later, in Expo's response shapes", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fake = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const json = url.endsWith("/send")
        ? { data: [{ status: "ok", id: "T1" }, { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }] }
        : { data: { T1: { status: "error", message: "uninstalled", details: { error: "DeviceNotRegistered" } } } };
      return new Response(JSON.stringify(json), { status: 200 });
    }) as unknown as typeof fetch;
    const sender = new ExpoPushSender("secret", "https://exp.example/send", fake, "https://exp.example/getReceipts");
    const results = await sender.send([
      { to: "ExponentPushToken[a]", title: "t", body: "b" },
      { to: "ExponentPushToken[b]", title: "t", body: "b" },
    ]);
    expect(results).toEqual([
      { token: "ExponentPushToken[a]", ok: true, ticketId: "T1" },
      { token: "ExponentPushToken[b]", ok: false, unregistered: true, error: "gone" },
    ]);
    expect(calls[0]!.body).toEqual([expect.objectContaining({ to: "ExponentPushToken[a]", channelId: "arrival", sound: "default" }), expect.anything()]);
    expect(await sender.receipts(["T1", "T2"])).toEqual({ T1: { ok: false, unregistered: true, error: "uninstalled" } });
    expect(calls[1]).toEqual({ url: "https://exp.example/getReceipts", body: { ids: ["T1", "T2"] } });
  });
});

describe("delivery receipts", () => {
  it("forget a phone whose receipt says the app is gone, after 15 minutes", async () => {
    let now = Date.parse("2026-10-05T15:00:00Z");
    const h = await harness({ now: () => new Date(now) });
    const push = h.ctx.push as MemoryPushSender;
    const S = api(h, await signUp(h, "BUSINESS", "Shipper Sam"));
    await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"] }, 201);
    await S.post("/v1/me/push-tokens", { token: "ExponentPushToken[old]", platform: "ios" }, 201);
    await S.post("/v1/me/push-tokens", { token: "ExponentPushToken[new]", platform: "ios" }, 201);
    push.goneLater.add("ExponentPushToken[old]");
    await S.post("/v1/me/alert-preferences/test");
    await h.ctx.notifier.flush();
    expect(h.ctx.store.pushTickets).toHaveLength(2);

    // Too soon: nothing checked yet.
    now += 10 * 60_000;
    expect(await h.ctx.notifier.checkReceipts()).toEqual({ checked: 0, forgotten: 0 });
    now += 6 * 60_000;
    expect(await h.ctx.notifier.checkReceipts()).toEqual({ checked: 2, forgotten: 1 });
    expect((await S.get("/v1/me/alert-preferences")).devices).toBe(1);
    expect(h.ctx.store.pushTickets).toEqual([]);
  });
});
