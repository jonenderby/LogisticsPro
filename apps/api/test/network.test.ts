import { describe, expect, it } from "vitest";
import { api, harness, signUp } from "./helpers.js";

async function carrierWithCode(clock: { t: number }) {
  const h = await harness({ now: () => new Date(clock.t) });
  const owner = await signUp(h, "CARRIER", "Fleet Owner");
  const F = api(h, owner);
  const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"], scac: "BIGF" })).org;
  return { h, F, fleet };
}

describe("carrier networks and join codes", () => {
  it("lets a trucker request to join with a code and the carrier approve", async () => {
    const clock = { t: Date.parse("2026-10-05T12:00:00Z") };
    const { h, F, fleet } = await carrierWithCode(clock);
    const code = await F.get(`/v1/orgs/${fleet.id}/join-code`);
    expect(code.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(code.expiresAt).toBe("2026-10-12T12:00:00.000Z");
    expect((await F.get(`/v1/orgs/${fleet.id}/join-code`)).code).toBe(code.code); // stable until it expires

    const trucker = await signUp(h, "TRUCKER", "Terry Trucker");
    const T = api(h, trucker);
    // Not yet driving for anyone: Today says so first.
    expect((await T.get("/v1/me")).feed[0]).toMatchObject({ id: "onboard:carrier", cta: { action: "join-carrier" } });

    const req = await T.post("/v1/carriers/join", { code: code.code.toLowerCase().replace("-", " ") }, 201);
    expect(req).toMatchObject({ status: "PENDING", carrierName: "Big Fleet" });
    expect((await T.post("/v1/carriers/join", { code: code.code })).id).toBe(req.id); // no duplicates

    // A code alone grants nothing: still not a driver for the carrier.
    expect((await F.get(`/v1/orgs/${fleet.id}/drivers`)).map((d: { id: string }) => d.id)).not.toContain(trucker.accountId);
    expect((await F.get("/v1/me")).feed[0]).toMatchObject({ title: "Terry Trucker wants to drive for Big Fleet", cta: { action: "join-requests" } });

    const approved = await F.post(`/v1/orgs/${fleet.id}/join-requests/${req.id}/approve`);
    expect(approved.status).toBe("APPROVED");
    expect((await F.get(`/v1/orgs/${fleet.id}/drivers`)).map((d: { id: string }) => d.id)).toContain(trucker.accountId);
    const me = await T.get("/v1/me");
    expect(me.feed.find((i: { id: string }) => i.id === "onboard:carrier")).toBeUndefined();
    expect(me.orgs[0]).toMatchObject({ name: "Big Fleet", roles: ["DRIVER"] });
    await T.post("/v1/carriers/join", { code: code.code }, 409);
  });

  it("expires codes, rotates them on demand and limits guessing", async () => {
    const clock = { t: Date.parse("2026-10-05T12:00:00Z") };
    const { h, F, fleet } = await carrierWithCode(clock);
    const first = (await F.get(`/v1/orgs/${fleet.id}/join-code`)).code;
    const rotated = (await F.post(`/v1/orgs/${fleet.id}/join-code/rotate`)).code;
    expect(rotated).not.toBe(first);
    const T = api(h, await signUp(h, "TRUCKER", "Late Larry"));
    expect((await T.post("/v1/carriers/join", { code: first }, 404)).error.code).toBe("INVALID_CODE");

    clock.t += 8 * 86_400_000; // past the 7-day lifetime
    expect((await T.post("/v1/carriers/join", { code: rotated }, 404)).error.code).toBe("INVALID_CODE");
    const fresh = (await F.get(`/v1/orgs/${fleet.id}/join-code`)).code;
    expect(fresh).not.toBe(rotated);

    // 10 attempts per hour: one already used since the clock moved, nine more fail, the next is refused.
    for (let i = 0; i < 9; i++) await T.post("/v1/carriers/join", { code: "ZZZZ-ZZZZ" }, 404);
    expect((await T.post("/v1/carriers/join", { code: fresh }, 429)).error.code).toBe("TOO_MANY_ATTEMPTS");
  });

  it("supports declining, cancelling, leaving and removal, but never removes the owner", async () => {
    const clock = { t: Date.parse("2026-10-05T12:00:00Z") };
    const { h, F, fleet } = await carrierWithCode(clock);
    const code = (await F.get(`/v1/orgs/${fleet.id}/join-code`)).code;
    const a = await signUp(h, "TRUCKER", "Ann");
    const b = await signUp(h, "TRUCKER", "Ben");
    const A = api(h, a);
    const B = api(h, b);
    const ra = await A.post("/v1/carriers/join", { code }, 201);
    const rb = await B.post("/v1/carriers/join", { code }, 201);
    expect((await F.post(`/v1/orgs/${fleet.id}/join-requests/${ra.id}/decline`)).status).toBe("DECLINED");
    expect((await B.post(`/v1/join-requests/${rb.id}/cancel`)).status).toBe("CANCELLED");
    await F.post(`/v1/orgs/${fleet.id}/join-requests/${rb.id}/approve`, {}, 409);
    expect((await F.get(`/v1/orgs/${fleet.id}/join-requests?status=PENDING`))).toEqual([]);

    const rb2 = await B.post("/v1/carriers/join", { code }, 201);
    await F.post(`/v1/orgs/${fleet.id}/join-requests/${rb2.id}/approve`);
    await B.post(`/v1/orgs/${fleet.id}/leave`);
    expect((await F.get(`/v1/orgs/${fleet.id}/drivers`))).toEqual([]);

    const ra2 = await A.post("/v1/carriers/join", { code }, 201);
    await F.post(`/v1/orgs/${fleet.id}/join-requests/${ra2.id}/approve`);
    await F.post(`/v1/orgs/${fleet.id}/members/${a.accountId}/remove`);
    const owner = (await F.get(`/v1/orgs/${fleet.id}`)).members.find((m: { roles: string[] }) => m.roles.includes("OWNER")).account.id;
    expect((await F.post(`/v1/orgs/${fleet.id}/members/${owner}/remove`, {}, 409)).error.code).toBe("OWNER");
    // Other people can't see or rotate the code.
    await A.get(`/v1/orgs/${fleet.id}/join-code`, 403);
  });

  it("makes a self-employed trucker an owner-operator when they register their carrier", async () => {
    const h = await harness();
    const T = api(h, await signUp(h, "TRUCKER", "Sole Prop"));
    await T.post("/v1/orgs", { name: "Sole Prop Trucking", kinds: ["CARRIER"], scac: "SOLE" }, 201);
    const me = await T.get("/v1/me");
    expect(me.ownerOperator).toBe(true);
    expect(me.feed.find((i: { id: string }) => i.id === "onboard:carrier")).toBeUndefined();
  });
});
