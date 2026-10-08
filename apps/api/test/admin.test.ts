import { describe, expect, it } from "vitest";
import { type Harness, api, harness, signUp } from "./helpers.js";

/** Calls with a raw access token, e.g. one from switching into a test account. */
const as = (h: Harness, token: string) => ({
  get: (url: string) => h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } }),
  post: (url: string, payload: unknown) => h.app.inject({ method: "POST", url, payload: payload as never, headers: { authorization: `Bearer ${token}` } }),
});

async function setup() {
  const h = await harness();
  const boss = await signUp(h, "BUSINESS", "Jonny Admin");
  h.ctx.cfg.adminEmails.push(boss.email);
  return { h, boss, admin: api(h, boss) };
}

describe("platform admin", () => {
  it("is only for the people who run the deployment", async () => {
    const { h } = await setup();
    const someone = await signUp(h, "CARRIER", "Someone");
    for (const url of ["/v1/admin/accounts", "/v1/admin/orgs"]) await api(h, someone).get(url, 403);
    await api(h, someone).post("/v1/admin/accounts", { name: "X", profileType: "TRUCKER" }, 403);
    await api(h, someone).post("/v1/admin/switch", { accountId: someone.accountId }, 403);
  });

  it("makes test accounts of every kind, with their companies, and a driver for a test carrier", async () => {
    const { admin } = await setup();
    const carrier = await admin.post("/v1/admin/accounts", { name: "Test Carrier", profileType: "CARRIER", company: { name: "Test Trucking", scac: "TSTT" } }, 201);
    expect(carrier.account).toMatchObject({ name: "Test Carrier", profileType: "CARRIER", test: true });
    expect(carrier.account.email).toMatch(/^test\.carrier\.[0-9a-f]{6}@test\.invalid$/);
    expect(carrier.org).toMatchObject({ name: "Test Trucking", kinds: ["CARRIER"], scac: "TSTT" });
    expect(carrier.account.orgs).toEqual([{ id: carrier.org.id, name: "Test Trucking", kinds: ["CARRIER"], roles: ["OWNER"] }]);
    expect(carrier.temporaryPassword).toBeUndefined();

    const driver = await admin.post("/v1/admin/accounts", { name: "Test Driver", profileType: "TRUCKER", driverFor: carrier.org.id }, 201);
    expect(driver.account.orgs).toEqual([{ id: carrier.org.id, name: "Test Trucking", kinds: ["CARRIER"], roles: ["DRIVER"] }]);
    expect(driver.account.driver.homeCarrierOrgId).toBe(carrier.org.id);

    const ownerOp = await admin.post("/v1/admin/accounts", { name: "Owner Op", profileType: "TRUCKER", company: { name: "Solo Hauling" } }, 201);
    expect(ownerOp.account.orgs[0].roles).toEqual(["OWNER", "DRIVER"]);
    const broker = await admin.post("/v1/admin/accounts", { name: "Test Broker", profileType: "BROKER_3PL", company: { name: "Test 3PL" } }, 201);
    expect(broker.org.kinds).toEqual(["BROKER_3PL"]);
    const shipper = await admin.post("/v1/admin/accounts", { name: "Test Shipper", profileType: "BUSINESS", company: { name: "Test Foods" } }, 201);
    expect(shipper.org.kinds).toEqual(["SHIPPER"]);

    const accounts = await admin.get("/v1/admin/accounts");
    expect(accounts.filter((a: { test: boolean }) => a.test)).toHaveLength(5);
    expect(accounts.find((a: { name: string }) => a.name === "Jonny Admin")).toMatchObject({ test: false, platformAdmin: true });
    const orgs = await admin.get("/v1/admin/orgs");
    expect(orgs.map((o: { name: string }) => o.name)).toEqual(["Solo Hauling", "Test 3PL", "Test Foods", "Test Trucking"]);
    expect(orgs.find((o: { name: string }) => o.name === "Test Trucking").members).toBe(2);
    // Nobody can sign in to a test account with a password.
    const login = await admin.post("/v1/auth/login", { email: driver.account.email, password: "anything at all here" }, 401);
    expect(login.error.code).toBe("BAD_CREDENTIALS");
  });

  it("switches into a test account to see the app as it, and back", async () => {
    const { h, boss, admin } = await setup();
    const carrier = await admin.post("/v1/admin/accounts", { name: "Test Carrier", profileType: "CARRIER", company: { name: "Test Trucking" } }, 201);
    const driver = await admin.post("/v1/admin/accounts", { name: "Test Driver", profileType: "TRUCKER", driverFor: carrier.org.id }, 201);

    const asDriver = await admin.post("/v1/admin/switch", { accountId: driver.account.id });
    const me = (await as(h, asDriver.accessToken).get("/v1/me")).json();
    expect(me.account.name).toBe("Test Driver");
    expect(me.actingAs).toEqual({ adminName: "Jonny Admin" });
    expect(me.platformAdmin).toBe(false);
    expect(me.capabilities).toContain("DRIVE");
    // The driver's own layout, not the admin's.
    const adminTabs = (await admin.get("/v1/me")).workspace.tabs.map((t: { id: string }) => t.id);
    expect(me.workspace.tabs.map((t: { id: string }) => t.id)).not.toEqual(adminTabs);
    expect((await admin.get("/v1/me")).actingAs).toBeUndefined();

    // From the driver, straight to the carrier, then back to the admin's own account.
    const asCarrier = (await as(h, asDriver.accessToken).post("/v1/admin/switch", { accountId: carrier.account.id })).json();
    expect((await as(h, asCarrier.accessToken).get("/v1/me")).json().account.name).toBe("Test Carrier");
    const back = (await as(h, asCarrier.accessToken).post("/v1/admin/switch", { accountId: boss.accountId })).json();
    const mine = (await as(h, back.accessToken).get("/v1/me")).json();
    expect(mine.account.name).toBe("Jonny Admin");
    expect(mine.actingAs).toBeUndefined();
    expect(mine.platformAdmin).toBe(true);
  });

  it("never switches into a real person's account, and stops working when the admin is removed", async () => {
    const { h, admin } = await setup();
    const customer = await signUp(h, "BUSINESS", "Real Customer");
    const refused = await admin.post("/v1/admin/switch", { accountId: customer.accountId }, 403);
    expect(refused.error.code).toBe("NOT_A_TEST_ACCOUNT");

    const t = await admin.post("/v1/admin/accounts", { name: "Test Shipper", profileType: "BUSINESS" }, 201);
    const s = await admin.post("/v1/admin/switch", { accountId: t.account.id });
    expect((await as(h, s.accessToken).get("/v1/me")).statusCode).toBe(200);
    h.ctx.cfg.adminEmails.length = 0;
    expect((await as(h, s.accessToken).get("/v1/me")).statusCode).toBe(401);
  });

  it("adds real people with a one-time password, and puts accounts in companies", async () => {
    const { h, admin } = await setup();
    const r = await admin.post("/v1/admin/accounts", { name: "Maria Dispatcher", profileType: "CARRIER", test: false, email: "Maria@Example.com" }, 201);
    expect(r.account).toMatchObject({ email: "maria@example.com", test: false });
    expect(r.temporaryPassword).toMatch(/^.{12}-Lp1$/);
    // She sets up her own two-factor on first sign-in.
    const login = await admin.post("/v1/auth/login", { email: "maria@example.com", password: r.temporaryPassword });
    expect(login.status).toBe("MFA_ENROLLMENT_REQUIRED");
    // And can't be switched into.
    await admin.post("/v1/admin/switch", { accountId: r.account.id }, 403);
    await admin.post("/v1/admin/accounts", { name: "Again", profileType: "CARRIER", test: false, email: "maria@example.com" }, 409);
    await admin.post("/v1/admin/accounts", { name: "No email", profileType: "CARRIER", test: false }, 400);

    const carrier = await admin.post("/v1/admin/accounts", { name: "Test Carrier", profileType: "CARRIER", company: { name: "Test Trucking" } }, 201);
    const added = await admin.post(`/v1/admin/orgs/${carrier.org.id}/members`, { accountId: r.account.id, roles: ["DISPATCHER"] }, 201);
    expect(added.orgs).toEqual([{ id: carrier.org.id, name: "Test Trucking", kinds: ["CARRIER"], roles: ["DISPATCHER"] }]);
    const again = await admin.post(`/v1/admin/orgs/${carrier.org.id}/members`, { accountId: r.account.id, roles: ["BILLING"] }, 201);
    expect(again.orgs[0].roles).toEqual(["DISPATCHER", "BILLING"]);
    expect(h.ctx.store.membershipsOf(r.account.id)).toHaveLength(1);
  });
});
