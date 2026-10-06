import { describe, expect, it } from "vitest";
import { PersistentList, PersistentMap } from "../src/persistence/collections.js";
import { KeyedMutex } from "../src/services/locks.js";
import { api, harness, loadBody, NYC, signUp } from "./helpers.js";

describe("indexes", () => {
  it("follow values that are set, changed in place, replaced, removed and evicted", () => {
    const m = new PersistentMap<{ status: string; orgs: string[] }>("t").index("status", (v) => [v.status]).index("org", (v) => v.orgs);
    const a = { status: "OPEN", orgs: ["x", "y"] };
    m.set("a", a);
    m.set("b", { status: "OPEN", orgs: ["y"] });
    expect(m.where("status", "OPEN")).toHaveLength(2);
    expect(m.where("org", "y").length).toBe(2);
    a.status = "DONE";
    a.orgs = ["z"];
    m.touch("a");
    expect(m.where("status", "OPEN")).toEqual([{ status: "OPEN", orgs: ["y"] }]);
    expect(m.where("org", "x")).toEqual([]);
    expect(m.where("org", "z")).toEqual([a]);
    m.applyRemote("b", { status: "DONE", orgs: [] });
    expect(m.where("status", "DONE")).toHaveLength(2);
    m.evict("a");
    expect(m.where("org", "z")).toEqual([]);
    m.delete("b");
    expect(m.where("status", "DONE")).toEqual([]);
  });

  it("group list records", () => {
    const l = PersistentList.create<{ id: string; loadId?: string }>("m", (x) => x.id, (x) => x.loadId);
    l.push({ id: "1", loadId: "L1" }, { id: "2", loadId: "L2" }, { id: "3", loadId: "L1" }, { id: "4" });
    expect(l.group("L1").map((x) => x.id)).toEqual(["1", "3"]);
    l.applyRemote("3", undefined);
    l.applyRemote("5", { id: "5", loadId: "L1" });
    expect(l.group("L1").map((x) => x.id)).toEqual(["1", "5"]);
    l.evictWhere((x) => x.loadId === "L1");
    expect(l.group("L1")).toEqual([]);
    expect(l.map((x) => x.id)).toEqual(["2", "4"]);
  });

  it("keep the load list and Today in step with changes", async () => {
    const h = await harness();
    const sam = await signUp(h, "BUSINESS", "Shipper Index");
    const S = api(h, sam);
    const acme = (await S.post("/v1/orgs", { name: "Index Foods", kinds: ["SHIPPER"], address: NYC })).org;
    const owner = await signUp(h, "CARRIER", "Owner Index");
    const F = api(h, owner);
    const fleet = (await F.post("/v1/orgs", { name: "Index Fleet", kinds: ["CARRIER"], scac: "IDXF" })).org;
    const load = await S.post("/v1/loads", loadBody(acme.id), 201);
    expect((await F.get("/v1/loads")).map((l: { id: string }) => l.id)).not.toContain(load.id);
    await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
    // The carrier became a party when the load was tendered.
    expect((await F.get("/v1/loads")).map((l: { id: string }) => l.id)).toContain(load.id);
    await F.post(`/v1/loads/${load.id}/messages`, { body: "On it" }, 201);
    expect((await S.get("/v1/me")).feed.some((f: { loadId?: string; kind: string }) => f.loadId === load.id)).toBe(true);
  });
});

describe("record locks", () => {
  it("let one holder at a time per key", async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const release1 = await m.lock("load:1");
    const second = m.lock("load:1").then(async (release) => {
      order.push("second");
      await release();
    });
    const other = await m.lock("load:2");
    order.push("other key");
    await other();
    order.push("first done");
    await release1();
    await second;
    expect(order).toEqual(["other key", "first done", "second"]);
  });
});
