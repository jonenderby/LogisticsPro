import type { Account, Membership, Organization } from "@logisticspro/domain";
import { planRelay } from "@logisticspro/domain";
import { describe, expect, it } from "vitest";
import { makeLoad, NASHVILLE_YARD } from "../../domain/test/fixtures.js";
import { buildFeed, buildWorkspace, nextDriverAction, resolveCapabilities } from "../src/index.js";

const org = (id: string, kinds: Organization["kinds"]): Organization => ({ id, name: id, kinds, distributionCenters: [], createdAt: "2026-01-01" });
const acct = (id: string, profileType: Account["profileType"], driver = false) => ({ id, profileType, driver: driver ? { endorsements: [], twicCard: false } : undefined });
const mem = (accountId: string, orgId: string, roles: Membership["roles"]): Membership => ({ accountId, orgId, roles });

const ownerOp = () =>
  resolveCapabilities({ account: acct("me", "TRUCKER", true), memberships: [mem("me", "org_mine", ["OWNER", "DRIVER"])], orgs: [org("org_mine", ["CARRIER"])] });

describe("capabilities and layout", () => {
  it("gives an owner-operator driving and carrier tools in one layout", () => {
    const caps = ownerOp();
    expect(caps.ownerOperator).toBe(true);
    for (const c of ["DRIVE", "DISPATCH", "BID", "MANAGE_FLEET", "INVOICE", "MANAGE_INTEGRATIONS"] as const) expect(caps.all.has(c)).toBe(true);
    const ws = buildWorkspace(caps);
    expect(ws.tabs.map((t) => t.id)).toEqual(["today", "loads", "navigate", "messages", "more"]);
    expect(ws.more.map((m) => m.id)).toEqual(expect.arrayContaining(["board", "money", "business", "integrations", "fleet", "alerts", "security"]));
    expect(ws.loadFilters.map((f) => f.id)).toEqual(["driving", "dispatch"]);
    expect(ws.quickActions.map((q) => q.id)).toEqual(["update-status", "add-document", "find-loads", "new-invoice"]);
  });

  it("keeps a company driver focused on driving and offers company registration", () => {
    const caps = resolveCapabilities({ account: acct("d", "TRUCKER", true), memberships: [mem("d", "org_c", ["DRIVER"])], orgs: [org("org_c", ["CARRIER"])] });
    expect(caps.all.has("DISPATCH")).toBe(false);
    const ws = buildWorkspace(caps);
    expect(ws.tabs.map((t) => t.id)).toEqual(["today", "loads", "navigate", "messages", "more"]);
    expect(ws.more.map((m) => m.id)).toEqual(["money", "reliability", "join-carrier", "register-company", "account", "security"]);
  });

  it("puts the load board up front for a broker", () => {
    const caps = resolveCapabilities({ account: acct("b", "BROKER_3PL"), memberships: [mem("b", "org_3pl", ["OWNER"])], orgs: [org("org_3pl", ["BROKER_3PL"])] });
    expect(buildWorkspace(caps).tabs.map((t) => [t.id, t.title])).toEqual([["today", "Today"], ["loads", "Loads"], ["track", "Tracking"], ["board", "Board"], ["more", "More"]]);
  });

  it("puts the fleet map up front for a dispatcher", () => {
    const caps = resolveCapabilities({ account: acct("x", "CARRIER"), memberships: [mem("x", "c", ["DISPATCHER"])], orgs: [org("c", ["CARRIER"])] });
    expect(buildWorkspace(caps).tabs.map((t) => [t.id, t.title]).slice(0, 3)).toEqual([["today", "Today"], ["loads", "Loads"], ["track", "Fleet"]]);
  });

  it("never shows more than five bottom tabs", () => {
    const caps = resolveCapabilities({
      account: acct("x", "CARRIER", true),
      memberships: [mem("x", "c", ["OWNER"]), mem("x", "s", ["OWNER"]), mem("x", "b", ["OWNER"])],
      orgs: [org("c", ["CARRIER"]), org("s", ["SHIPPER"]), org("b", ["BROKER_3PL"])],
    });
    expect(buildWorkspace(caps).tabs.length).toBeLessThanOrEqual(5);
  });

  it("asks a brand new business user to register a company", () => {
    const caps = resolveCapabilities({ account: acct("n", "BUSINESS"), memberships: [], orgs: [] });
    expect(caps.all.has("REGISTER_COMPANY")).toBe(true);
  });
});

describe("integrated action feed", () => {
  it("mixes the truck I am driving with dispatch work for my company", () => {
    const caps = ownerOp();
    const driving = { ...makeLoad({ id: "l_drive", loadNumber: "LP-1", carrierOrgId: "org_mine", status: "AT_PICKUP" }) };
    driving.legs = [{ id: "leg1", sequence: 1, fromStopId: "stop_pu", toStopId: "stop_del", driverAccountIds: ["me"], status: "ASSIGNED" }];
    const toAssign = makeLoad({ id: "l_assign", loadNumber: "LP-2", carrierOrgId: "org_mine", status: "BOOKED", service: "TEAM_EXPEDITED" });
    const tendered = makeLoad({ id: "l_tender", loadNumber: "LP-3", carrierOrgId: "org_mine", status: "TENDERED" });
    const delivered = { ...makeLoad({ id: "l_done", loadNumber: "LP-4", carrierOrgId: "org_mine", status: "DELIVERED", deliveredAt: "2026-10-04T00:00:00Z" }), legs: [{ id: "x", sequence: 1, fromStopId: "stop_pu", toStopId: "stop_del", driverAccountIds: ["me"], status: "COMPLETED" as const }] };
    const board = makeLoad({ id: "l_board", loadNumber: "LP-9", status: "POSTED", carrierOrgId: undefined });

    const feed = buildFeed(caps, { accountId: "me", loads: [driving, toAssign, tendered, delivered], boardLoads: [board], unreadByLoad: { l_drive: 2 } });
    expect(feed.map((i) => [i.hat, i.title])).toEqual([
      ["DRIVING", "Current load LP-1"],
      ["DISPATCH", "Tender LP-3"],
      ["DISPATCH", "Assign a team for LP-2"],
      ["BILLING", "Invoice LP-4"],
      ["MESSAGES", "2 new messages on LP-1"],
      ["DISPATCH", "Open load LP-9"],
    ]);
    expect(feed[0]!.cta).toMatchObject({ label: "Loaded", statusCode: "LOADED" });
  });

  it("shows a shipper bids to review and the ship-confirm reminder", () => {
    const caps = resolveCapabilities({ account: acct("s", "BUSINESS"), memberships: [mem("s", "org_shipper", ["OWNER"])], orgs: [org("org_shipper", ["SHIPPER"])] });
    const posted = makeLoad({ id: "p", loadNumber: "LP-5", status: "POSTED", carrierOrgId: undefined });
    const booked = makeLoad({ id: "q", loadNumber: "LP-6", status: "BOOKED" });
    const feed = buildFeed(caps, {
      accountId: "s",
      loads: [posted, booked],
      bids: [{ id: "b1", loadId: "p", carrierOrgId: "c", bidderAccountId: "x", amount: { amount: 1, currency: "USD" }, plan: "SOLO", status: "OPEN", createdAt: "" }],
      now: "2026-10-06T00:00:00Z",
    });
    expect(feed.map((i) => i.title)).toEqual(["1 bid on LP-5", "Confirm shipment LP-6"]);
  });
});

describe("driver next action", () => {
  it("walks a relay driver through arrive and handoff", () => {
    const load = { ...planRelay(makeLoad(), [{ address: NASHVILLE_YARD }]), status: "IN_TRANSIT" as const };
    const leg1 = { ...load.legs[0]!, status: "IN_PROGRESS" as const };
    expect(nextDriverAction(load, leg1)?.code).toBe("ARRIVED_RELAY");
    const arrived = { ...load, events: [{ id: "e", code: "ARRIVED_RELAY" as const, at: "", legId: leg1.id, source: "APP" as const }] };
    expect(nextDriverAction(arrived, leg1)?.code).toBe("RELAY_HANDOFF");
    expect(nextDriverAction(load, { ...load.legs[1]!, status: "IN_PROGRESS" })?.code).toBe("ARRIVED_DELIVERY");
  });
});
