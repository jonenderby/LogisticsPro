import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { archiveColdData } from "../src/services/archive.js";
import { type Harness, NYC, TEST_NOW, api, harness, loadBody, signUp } from "./helpers.js";

/**
 * Runs against a real Postgres when LP_TEST_DATABASE_URL is set (CI sets it).
 * Every server in a test shares one database and one signing key, as a
 * production deployment would.
 */
const url = process.env.LP_TEST_DATABASE_URL;
const secret = new TextEncoder().encode("persistence-test-secret");
const servers: Harness[] = [];
const server = async (now?: () => Date) => {
  const h = await harness({ config: { databaseUrl: url, jwtSecret: secret }, ...(now ? { now } : {}) });
  servers.push(h);
  return h;
};
const sql = async (q: string, params: unknown[] = []) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(q, params)).rows;
  } finally {
    await c.end();
  }
};
const until = async (check: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Timed out waiting for replication");
};

describe.skipIf(!url)("Postgres persistence", () => {
  beforeAll(async () => {
    await sql("drop table if exists lp_docs, lp_log; drop sequence if exists lp_load_number_block");
  });
  afterAll(async () => {
    for (const h of servers) await h.app.close();
  });

  it("keeps everything across a restart, committed before each response", async () => {
    const a = await server();
    const sam = await signUp(a, "BUSINESS", "Shipper Sam");
    const S = api(a, sam);
    const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
    const dee = await signUp(a, "CARRIER", "Dispatch Dee");
    const F = api(a, dee);
    const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"], scac: "BIGF" })).org;
    const ana = await signUp(a, "TRUCKER", "Ana");
    await F.post(`/v1/orgs/${fleet.id}/members`, { email: ana.email, roles: ["DRIVER"] }, 201);
    const load = await S.post("/v1/loads", loadBody(acme.id), 201);
    // Committed before the response came back.
    expect(await sql("select key from lp_docs where collection = 'loads' and key = $1", [load.id])).toHaveLength(1);
    await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
    await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
    await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [ana.accountId] });
    const A = api(a, ana);
    await A.post("/v1/me/location", { lat: 33, lng: -90, speedMps: 20 });
    await A.post(`/v1/loads/${load.id}/messages`, { body: "Rolling" }, 201);
    // Changed in place, then reported: Dee reads her notifications.
    await F.post("/v1/me/notifications/read", {});
    await a.app.close();
    servers.splice(servers.indexOf(a), 1);

    // A new server process: same database, same signing key, so Sam's session still works.
    const b = await server();
    const S2 = api(b, sam);
    const back = await S2.get(`/v1/loads/${load.id}`);
    expect(back).toMatchObject({ status: "DISPATCHED", carrierOrgId: fleet.id, loadNumber: load.loadNumber });
    expect((await S2.get(`/v1/loads/${load.id}/messages`)).map((m: { body: string }) => m.body)).toContain("Rolling");
    expect(b.ctx.store.memberships.some((m) => m.accountId === ana.accountId && m.orgId === fleet.id)).toBe(true);
    expect(b.ctx.store.tracks.get(ana.accountId)).toHaveLength(1);
    expect(b.ctx.store.notifications.get(dee.accountId)!.every((n) => n.read)).toBe(true);
    expect((await api(b, dee).get("/v1/me/notifications")).unread).toBe(0);
    // Load numbers continue without reuse after a restart.
    const next = await S2.post("/v1/loads", loadBody(acme.id), 201);
    expect(next.loadNumber).not.toBe(load.loadNumber);
  });

  it("keeps two servers in step and runs jobs on only one", async () => {
    const a = await server();
    const b = await server();
    expect([a.ctx.persistence!.isLeader(), b.ctx.persistence!.isLeader()].filter(Boolean).length).toBeLessThanOrEqual(1);

    // Sign up on A, act on B with the same session.
    const sam = await signUp(a, "BUSINESS", "Shipper Two");
    const SA = api(a, sam);
    const SB = api(b, sam);
    const acme = (await SA.post("/v1/orgs", { name: "Two Foods", kinds: ["SHIPPER"], address: NYC })).org;
    await until(() => b.ctx.store.orgs.has(acme.id) && b.ctx.store.memberships.some((m) => m.orgId === acme.id));
    const onB = await SB.post("/v1/loads", loadBody(acme.id), 201);
    const onA = await SA.post("/v1/loads", loadBody(acme.id), 201);
    await until(() => a.ctx.store.loads.has(onB.id) && b.ctx.store.loads.has(onA.id));
    expect(onA.loadNumber).not.toBe(onB.loadNumber);

    // An edit on one server is what the other serves.
    await SB.patch(`/v1/loads/${onA.id}`, { notes: "Gate code 4411" });
    await until(() => a.ctx.store.loads.get(onA.id)?.notes === "Gate code 4411");
    expect((await SA.get(`/v1/loads/${onA.id}`)).notes).toBe("Gate code 4411");

    // Removing a member replicates as a removal.
    const F = api(a, await signUp(a, "CARRIER", "Owner Two"));
    const fleet = (await F.post("/v1/orgs", { name: "Two Fleet", kinds: ["CARRIER"], scac: "TWOF" })).org;
    const d = await signUp(a, "TRUCKER", "Dan");
    await F.post(`/v1/orgs/${fleet.id}/members`, { email: d.email, roles: ["DRIVER"] }, 201);
    await until(() => b.ctx.store.memberships.some((m) => m.accountId === d.accountId && m.orgId === fleet.id));
    await api(b, d).post(`/v1/orgs/${fleet.id}/leave`);
    await until(() => !a.ctx.store.memberships.some((m) => m.accountId === d.accountId && m.orgId === fleet.id));

    // Location trails replicate point by point.
    await api(a, d).post("/v1/me/location", { lat: 33, lng: -90, speedMps: 20 });
    await until(() => (b.ctx.store.tracks.get(d.accountId)?.length ?? 0) === 1);

    // A document uploaded through one server is served by the other.
    const pdf = Buffer.from("%PDF-1.4\nshared across servers\n");
    const doc = await SA.post(`/v1/loads/${onA.id}/documents/upload`, { kind: "BOL", name: "BOL", contentType: "application/pdf", data: pdf.toString("base64") }, 201);
    await until(() => b.ctx.store.files.has(doc.fileId));
    const res = await b.app.inject({ method: "GET", url: doc.viewUrl });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(pdf)).toBe(true);
  });
  it("lets only one of two servers award a load's bids", async () => {
    const a = await server();
    const b = await server();
    const sam = await signUp(a, "BUSINESS", "Shipper Race");
    const S = api(a, sam);
    const acme = (await S.post("/v1/orgs", { name: "Race Foods", kinds: ["SHIPPER"], address: NYC })).org;
    const carrier = async (name: string, scac: string) => {
      const owner = await signUp(a, "CARRIER", name);
      const C = api(a, owner);
      return { C, org: (await C.post("/v1/orgs", { name, kinds: ["CARRIER"], scac })).org };
    };
    const one = await carrier("Race One", "RCEA");
    const two = await carrier("Race Two", "RCEB");
    const load = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${load.id}/post`, {});
    const bid1 = await one.C.post(`/v1/loads/${load.id}/bids`, { carrierOrgId: one.org.id, amount: { amount: 5000, currency: "USD" }, plan: "SOLO" }, 201);
    const bid2 = await two.C.post(`/v1/loads/${load.id}/bids`, { carrierOrgId: two.org.id, amount: { amount: 4900, currency: "USD" }, plan: "SOLO" }, 201);
    await until(() => b.ctx.store.bids.has(bid1.id) && b.ctx.store.bids.has(bid2.id) && b.ctx.store.memberships.some((m) => m.accountId === sam.accountId));

    // Both servers see the load posted; the shipper's two clicks land on different servers.
    const [r1, r2] = await Promise.all([
      a.app.inject({ method: "POST", url: `/v1/loads/${load.id}/bids/${bid1.id}/award`, headers: { authorization: `Bearer ${sam.token}` }, payload: {} }),
      b.app.inject({ method: "POST", url: `/v1/loads/${load.id}/bids/${bid2.id}/award`, headers: { authorization: `Bearer ${sam.token}` }, payload: {} }),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
    const winner = r1.statusCode === 200 ? one.org.id : two.org.id;
    const [row] = await sql("select doc from lp_docs where collection = 'loads' and key = $1", [load.id]);
    expect(row.doc.carrierOrgId).toBe(winner);
    await until(() => a.ctx.store.loads.get(load.id)?.carrierOrgId === winner && b.ctx.store.loads.get(load.id)?.carrierOrgId === winner);
  });

  it("archives finished loads out of memory and brings them back when opened", async () => {
    // Only the server running background jobs marks records archived; make it this one.
    for (const h of servers.splice(0)) await h.app.close();
    let now = Date.parse(TEST_NOW);
    const a = await server(() => new Date(now));
    expect(a.ctx.persistence!.isLeader()).toBe(true);
    const sam = await signUp(a, "BUSINESS", "Shipper Old");
    const S = api(a, sam);
    const acme = (await S.post("/v1/orgs", { name: "Old Foods", kinds: ["SHIPPER"], address: NYC })).org;
    const owner = await signUp(a, "CARRIER", "Owner Old");
    const F = api(a, owner);
    const fleet = (await F.post("/v1/orgs", { name: "Old Fleet", kinds: ["CARRIER"], scac: "OLDF" })).org;
    const old = await S.post("/v1/loads", { ...loadBody(acme.id), references: { bol: "BOL-OLD", po: ["PO-ARCHIVE"] } }, 201);
    await S.post(`/v1/loads/${old.id}/tender`, { carrierOrgId: fleet.id });
    await F.post(`/v1/loads/${old.id}/tender-response`, { decision: "ACCEPT" });
    await F.post(`/v1/loads/${old.id}/messages`, { body: "Delivered, thanks" }, 201);
    for (const code of ["LOADED", "DELIVERED"]) await F.post(`/v1/loads/${old.id}/status`, { code });
    const fresh = await S.post("/v1/loads", loadBody(acme.id), 201);

    // Nothing is old enough yet.
    expect((await archiveColdData(a.ctx)).loads).toBe(0);
    now += 200 * 86_400_000;
    const swept = await archiveColdData(a.ctx);
    expect(swept.loads).toBe(1);
    expect(a.ctx.store.loads.has(old.id)).toBe(false);
    expect(a.ctx.store.messages.group(old.id)).toEqual([]);
    expect(a.ctx.store.loads.has(fresh.id)).toBe(true);
    expect(await sql("select archived from lp_docs where collection = 'loads' and key = $1", [old.id])).toEqual([{ archived: true }]);

    // Off the working lists, but found in history, by search too.
    expect((await S.get("/v1/loads")).map((l: { id: string }) => l.id)).not.toContain(old.id);
    expect((await S.get("/v1/loads/history")).loads.map((l: { id: string }) => l.id)).toEqual([old.id]);
    expect((await S.get("/v1/loads/history?q=PO-ARCHIVE")).loads).toHaveLength(1);
    expect((await S.get("/v1/loads/history?q=nothing-like-this")).loads).toHaveLength(0);
    // Only parties see it.
    const stranger = api(a, await signUp(a, "BUSINESS", "Stranger"));
    expect((await stranger.get("/v1/loads/history")).loads).toEqual([]);

    // A server started now doesn't load it.
    const b = await server(() => new Date(now));
    expect(b.ctx.store.loads.has(old.id)).toBe(false);
    expect(b.ctx.store.loads.has(fresh.id)).toBe(true);

    // Opening it brings it back, with its thread.
    expect((await api(b, sam).get(`/v1/loads/${old.id}`)).status).toBe("DELIVERED");
    expect((await api(b, sam).get(`/v1/loads/${old.id}/messages`)).map((m: { body: string }) => m.body)).toContain("Delivered, thanks");
    await stranger.get(`/v1/loads/${old.id}`, 404);

    // Changing it makes it live again.
    await api(b, sam).post(`/v1/loads/${old.id}/messages`, { body: "One more question" }, 201);
    expect(await sql("select archived from lp_docs where collection = 'messages' and doc->>'body' = 'One more question'")).toEqual([{ archived: false }]);
  });
});
