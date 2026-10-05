import { type EldProvider, matchEldDrivers } from "@logisticspro/domain";
import { type AppContext, HttpError } from "../http.js";
import { seal, unseal } from "../security/sealed.js";
import type { EldConnection } from "../store.js";
import { type EldClient, type EldCredentials, EldError } from "./eldClients.js";
import { acceptLocation } from "./location.js";

const PURPOSE = "eld-credentials";
/** How often each ELD is polled by the background job. */
export const ELD_SYNC_MS = 5 * 60_000;

const dataKey = (ctx: AppContext) => ctx.cfg.dataKey ?? ctx.cfg.jwtSecret;

export function clientFor(ctx: AppContext, conn: EldConnection): EldClient {
  const creds = JSON.parse(unseal(dataKey(ctx), PURPOSE, conn.sealedCredentials)) as EldCredentials;
  return ctx.eldClient(conn.provider, creds);
}

/** The carrier's drivers on Logistics Pro, for matching. */
function members(ctx: AppContext, orgId: string) {
  return ctx.store.memberships
    .filter((m) => m.orgId === orgId && m.roles.includes("DRIVER"))
    .map((m) => ctx.store.accounts.get(m.accountId))
    .filter((a): a is NonNullable<typeof a> => !!a)
    .map((a) => ({ accountId: a.id, name: a.name, email: a.email, cdlNumber: a.driver?.cdlNumber }));
}

/** Point each linked driver's hours at the ELD; unlink drivers no longer matched. */
function relink(ctx: AppContext, conn: EldConnection) {
  for (const [accountId, link] of [...ctx.store.eldDrivers]) {
    if (link.orgId === conn.orgId && !conn.drivers.some((d) => d.accountId === accountId)) ctx.store.eldDrivers.delete(accountId);
  }
  for (const d of conn.drivers) {
    if (!d.accountId) continue;
    const prior = ctx.store.eldDrivers.get(d.accountId);
    if (prior?.externalDriverId === d.externalId && prior.orgId === conn.orgId) continue;
    ctx.store.eldDrivers.set(d.accountId, { accountId: d.accountId, orgId: conn.orgId, provider: conn.provider, externalDriverId: d.externalId });
  }
}

/** Check the credentials by listing drivers, then save the connection and match drivers. */
export async function connectEld(ctx: AppContext, orgId: string, accountId: string, provider: EldProvider, creds: EldCredentials): Promise<EldConnection> {
  const client = ctx.eldClient(provider, creds);
  let drivers;
  try {
    drivers = await client.drivers();
  } catch (e) {
    throw new HttpError(400, "ELD_CONNECT_FAILED", `Couldn't connect to ${provider[0]}${provider.slice(1).toLowerCase()}: ${e instanceof EldError ? e.message : "the service didn't answer"}`);
  }
  const prior = ctx.store.eldConnections.get(orgId);
  const manual = new Map((prior?.drivers ?? []).filter((d) => d.match === "MANUAL" && d.accountId).map((d) => [d.externalId, d.accountId!]));
  const auto = matchEldDrivers(drivers, members(ctx, orgId).filter((m) => ![...manual.values()].includes(m.accountId)));
  const conn: EldConnection = {
    orgId,
    provider,
    sealedCredentials: seal(dataKey(ctx), PURPOSE, JSON.stringify(creds)),
    label: "apiKey" in creds ? `Key ending ${creds.apiKey.slice(-4)}` : `${creds.database} as ${creds.userName}`,
    connectedAt: ctx.now().toISOString(),
    connectedByAccountId: accountId,
    drivers: drivers.map((d) => (manual.has(d.externalId) ? { ...d, accountId: manual.get(d.externalId), match: "MANUAL" as const } : auto.has(d.externalId) ? { ...d, accountId: auto.get(d.externalId), match: "AUTO" as const } : d)),
    vehicles: 0,
  };
  ctx.store.eldConnections.set(orgId, conn);
  relink(ctx, conn);
  return conn;
}

export function linkEldDriver(ctx: AppContext, orgId: string, externalId: string, accountId: string | null): EldConnection {
  const conn = ctx.store.eldConnections.get(orgId);
  if (!conn) throw new HttpError(404, "NOT_FOUND", "No ELD connected");
  if (!conn.drivers.some((d) => d.externalId === externalId)) throw new HttpError(404, "NOT_FOUND", "That ELD driver isn't in this account");
  if (accountId && !members(ctx, orgId).some((m) => m.accountId === accountId)) throw new HttpError(400, "NOT_A_DRIVER", "Not one of this company's drivers");
  const next: EldConnection = {
    ...conn,
    drivers: conn.drivers.map((d) => (d.externalId === externalId ? { ...d, accountId: accountId ?? undefined, match: accountId ? "MANUAL" : undefined } : accountId && d.accountId === accountId ? { ...d, accountId: undefined, match: undefined } : d)),
  };
  ctx.store.eldConnections.set(orgId, next);
  relink(ctx, next);
  return next;
}

export function disconnectEld(ctx: AppContext, orgId: string): void {
  const conn = ctx.store.eldConnections.get(orgId);
  if (!conn) return;
  ctx.store.eldConnections.delete(orgId);
  relink(ctx, { ...conn, drivers: [] });
}

/**
 * Pull each linked driver's hours clock and each truck's GPS. A truck's
 * position counts as its logged-in driver's, so it feeds tracking, ETAs,
 * stop times and fuel-tax miles like a phone does.
 */
export async function syncEld(ctx: AppContext, orgId: string): Promise<{ clocks: number; locations: number }> {
  const conn = ctx.store.eldConnections.get(orgId);
  if (!conn) throw new HttpError(404, "NOT_FOUND", "No ELD connected");
  const now = ctx.now();
  const byExternal = new Map(conn.drivers.filter((d) => d.accountId).map((d) => [d.externalId, d.accountId!]));
  let clocks = 0;
  let locations = 0;
  try {
    const client = clientFor(ctx, conn);
    const [cl, locs] = await Promise.all([client.clocks(), client.locations()]);
    for (const c of cl) {
      const accountId = byExternal.get(c.externalDriverId);
      const link = accountId ? ctx.store.eldDrivers.get(accountId) : undefined;
      if (!link) continue;
      ctx.store.eldDrivers.set(accountId!, { ...link, clock: c, syncedAt: now.toISOString() });
      clocks++;
    }
    for (const l of locs) {
      const accountId = l.externalDriverId ? byExternal.get(l.externalDriverId) : undefined;
      if (!accountId) continue;
      try {
        acceptLocation(ctx, accountId, { lat: l.lat, lng: l.lng, at: l.at, speedMps: l.speedMps, headingDeg: l.headingDeg }, now, "ELD");
        locations++;
      } catch {
        // A bad timestamp from the ELD skips that truck this round.
      }
    }
    ctx.store.eldConnections.set(orgId, { ...ctx.store.eldConnections.get(orgId)!, lastSyncAt: now.toISOString(), lastError: undefined, vehicles: locs.length });
  } catch (e) {
    ctx.store.eldConnections.set(orgId, { ...ctx.store.eldConnections.get(orgId)!, lastSyncAt: now.toISOString(), lastError: e instanceof EldError ? e.message : "The ELD service didn't answer" });
  }
  return { clocks, locations };
}

/** Job: sync every connected ELD that's due. */
export async function syncAllEld(ctx: AppContext): Promise<void> {
  const now = ctx.now().getTime();
  for (const conn of [...ctx.store.eldConnections.values()]) {
    if (conn.lastSyncAt && now - Date.parse(conn.lastSyncAt) < ELD_SYNC_MS) continue;
    await syncEld(ctx, conn.orgId);
  }
}
