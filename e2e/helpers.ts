import { type Page, expect } from "@playwright/test";
import { totp } from "../apps/api/src/security/totp";

export const BASE = `http://localhost:${process.env.E2E_PORT ?? 8099}`;
export const PASSWORD = "correct horse battery staple";
const run = Math.random().toString(36).slice(2, 8);
let n = 0;

export interface User {
  email: string;
  secret: string;
  token: string;
  id: string;
  name: string;
}

/** Each two-factor code works once; wait for a fresh one when this secret was just used. */
const lastStep = new Map<string, number>();
export async function freshCode(secret: string): Promise<string> {
  for (;;) {
    const step = Math.floor(Date.now() / 30_000);
    if ((lastStep.get(secret) ?? -1) < step) {
      lastStep.set(secret, step);
      return totp(secret);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function call<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

/** The platform admin's email (LP_ADMIN_EMAILS in playwright.config.ts). */
export const ADMIN_EMAIL = "e2e-admin@example.com";

export async function user(name: string, profileType: "TRUCKER" | "CARRIER" | "BROKER_3PL" | "BUSINESS", fixedEmail?: string): Promise<User> {
  const email = fixedEmail ?? `${name.toLowerCase().replace(/\W+/g, ".")}.${run}.${++n}@example.com`;
  const r = await call("POST", "/v1/auth/register", { email, password: PASSWORD, name, profileType });
  const a = await call("POST", "/v1/auth/mfa/activate", { token: r.enrollToken, code: await freshCode(r.totpSecret) });
  return { email, secret: r.totpSecret, token: a.accessToken, id: a.account.id, name };
}

export async function signIn(page: Page, u: User) {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Email").fill(u.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Password").press("Enter");
  await page.getByLabel("Code").fill(await freshCode(u.secret));
  await page.getByLabel("Code").press("Enter");
  await expect(page.getByText("Needs your attention")).toBeVisible();
}

export const visible = (page: Page, text: string | RegExp, exact = false) => page.getByText(text, { exact }).filter({ visible: true });

const H = 3_600_000;
export const inHours = (h: number) => new Date(Date.now() + h * H).toISOString();
export const addr = (city: string, state: string, lat: number, lng: number) => ({ name: `${city} DC`, line1: "100 Commerce Dr", city, state, postalCode: "38103", country: "US", geo: { lat, lng } });

/** A shipper, and a carrier with one driver. */
export async function world() {
  const shipper = await user("Sam Shipper", "BUSINESS");
  const acme = (await call("POST", "/v1/orgs", { name: `Acme Foods ${run}${++n}`, kinds: ["SHIPPER"] }, shipper.token)).org;
  const owner = await user("Fran Fleet", "CARRIER");
  // SCACs are unique across the platform, so each test carrier gets its own.
  const scac = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
  const fleet = (await call("POST", "/v1/orgs", { name: `Blue Line ${run}${++n}`, kinds: ["CARRIER"], scac }, owner.token)).org;
  const driver = await user("Ana Alvarez", "TRUCKER");
  await call("POST", `/v1/orgs/${fleet.id}/members`, { email: driver.email, roles: ["DRIVER"] }, owner.token);
  return { shipper, acme, owner, fleet, driver };
}

/** A shipper's load from Jackson, MS to Memphis, TN. Windows are hours from now. */
export async function newLoad(w: Awaited<ReturnType<typeof world>>, pickup: [number, number], delivery: [number, number]): Promise<{ id: string; loadNumber: string }> {
  return call("POST", "/v1/loads", {
    shipperOrgId: w.acme.id,
    mode: "FTL",
    equipment: { type: "DRY_VAN", lengthFt: 53 },
    references: { bol: "BOL-1", po: ["PO-1"] },
    stops: [
      { type: "PICKUP", address: addr("Jackson", "MS", 32.3, -90.18), window: { start: inHours(pickup[0]), end: inHours(pickup[1]) } },
      { type: "DELIVERY", address: addr("Memphis", "TN", 35.15, -90.05), window: { start: inHours(delivery[0]), end: inHours(delivery[1]) } },
    ],
    items: [{ description: "Groceries", pieces: 22, packaging: "PLT", weightLb: 36000 }],
    rate: { amount: 1800, currency: "USD" },
  }, w.shipper.token);
}

/** A load from Jackson, MS to Memphis, TN, tendered, accepted and assigned to the world's driver. Windows are hours from now. */
export async function bookedLoad(w: Awaited<ReturnType<typeof world>>, pickup: [number, number] = [-6, -4], delivery: [number, number] = [2, 6]) {
  const load = await newLoad(w, pickup, delivery);
  await call("POST", `/v1/loads/${load.id}/tender`, { carrierOrgId: w.fleet.id }, w.shipper.token);
  await call("POST", `/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" }, w.owner.token);
  await call("POST", `/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [w.driver.id] }, w.owner.token);
  return load;
}

/** The driver's phone: fixes every 5 minutes north from Jackson at 50 mph from `from` to `to` minutes from now, then stopped for the last 15 minutes. */
export async function drove(driver: User, from: number, to: number) {
  const step = 50 / 12 / 69.05;
  let i = 0;
  for (let m = from; m <= to; m += 5, i++) await call("POST", "/v1/me/location", { lat: 32.3 + i * step, lng: -90.18, at: inHours(m / 60), speedMps: 22.35 }, driver.token);
  for (const m of [-15, -10, -5]) await call("POST", "/v1/me/location", { lat: 32.3 + (i - 1) * step, lng: -90.18, at: inHours(m / 60), speedMps: 0 }, driver.token);
}
