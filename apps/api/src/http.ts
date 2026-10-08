import type { Account, EldProvider, Load, Message } from "@logisticspro/domain";
import { DomainError, carrierKeyOf, loadParties, newId } from "@logisticspro/domain";
import type { As2Identity, As2Transport, IntegrationEngine, SecretResolver } from "@logisticspro/integration";
import type { Geocoder, RoutingProvider, TrafficProvider } from "@logisticspro/navigation";
import { type Capability, type ResolvedCapabilities, resolveCapabilities } from "@logisticspro/workspace";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Config } from "./config.js";
import type { Tokens } from "./security/tokens.js";
import type { AlertEngine } from "./services/alerts.js";
import type { IntegrationHub } from "./services/hub.js";
import type { Notifier } from "./services/notify.js";
import type { PgPersistence } from "./persistence/postgres.js";
import type { PushSender } from "./services/push.js";
import type { FmcsaClient } from "./services/fmcsa.js";
import type { FileBytes } from "./services/files.js";
import type { EldClient, EldCredentials } from "./services/eldClients.js";
import { recordOutcome } from "./services/reliability.js";
import { rateConOnSave } from "./services/rateconfirmations.js";
import type { MemoryStore } from "./store.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface AppContext {
  cfg: Config;
  store: MemoryStore;
  tokens: Tokens;
  engine: IntegrationEngine;
  /** Resolves partner credential names (LP_SECRET_*); used to check they are set, never to show them. */
  secrets: SecretResolver;
  hub: IntegrationHub;
  routing: RoutingProvider;
  /** Live-traffic driving times for ETAs (HERE or TomTom), when configured. */
  traffic?: TrafficProvider;
  /** Address search; undefined when no geocoding server is configured. */
  geocoder?: Geocoder;
  /** The platform's AS2 station identity and the transport that sends from it. */
  as2: As2Identity;
  as2Transport: As2Transport;
  /** Phone push delivery (Expo), and the engine that decides what to alert. */
  push: PushSender;
  notifier: Notifier;
  alerts: AlertEngine;
  /** Postgres write-through and replication; absent when running in memory. */
  persistence?: PgPersistence;
  /** FMCSA registry lookups for carrier vetting; absent when not configured (nothing is enforced). */
  fmcsa?: FmcsaClient;
  /** Bytes of uploaded documents. */
  files: FileBytes;
  /** Opens a carrier's ELD account (Motive, Samsara or Geotab). */
  eldClient: (provider: EldProvider, creds: EldCredentials) => EldClient;
  now: () => Date;
}

declare module "fastify" {
  interface FastifyRequest {
    accountId?: string;
    /** The platform admin behind a session in a test account. */
    actorId?: string;
  }
}

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const res = schema.safeParse(data);
  if (!res.success) {
    throw new HttpError(400, "INVALID_REQUEST", "Request body is invalid", res.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return res.data;
}

export function authenticate(ctx: AppContext) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new HttpError(401, "UNAUTHENTICATED", "Sign in required");
    try {
      const claims = await ctx.tokens.verify(header.slice(7), "access");
      const account = ctx.store.accounts.get(claims.sub);
      if (!account) throw new Error("no account");
      if (claims.actor) {
        // Switched in by a platform admin: still an admin, and still a test account.
        const actor = ctx.store.accounts.get(claims.actor);
        if (!actor || !ctx.cfg.adminEmails.includes(actor.email.toLowerCase()) || !account.testAccountOf) throw new Error("no longer allowed");
        req.actorId = actor.id;
      }
      req.accountId = claims.sub;
    } catch {
      throw new HttpError(401, "UNAUTHENTICATED", "Session expired or invalid");
    }
  };
}

export function me(ctx: AppContext, req: FastifyRequest): Account {
  const a = req.accountId && ctx.store.accounts.get(req.accountId);
  if (!a) throw new HttpError(401, "UNAUTHENTICATED", "Sign in required");
  return a;
}

export function capsOf(ctx: AppContext, accountId: string): ResolvedCapabilities {
  const account = ctx.store.accounts.get(accountId)!;
  return resolveCapabilities({ account, memberships: ctx.store.membershipsOf(accountId), orgs: ctx.store.orgsOf(accountId) });
}

export function requireOrgCap(ctx: AppContext, accountId: string, orgId: string | undefined, cap: Capability): void {
  if (!orgId || !capsOf(ctx, accountId).byOrg.get(orgId)?.has(cap)) {
    throw new HttpError(403, "FORBIDDEN", `You need ${cap.toLowerCase().replace(/_/g, " ")} access for this organization`);
  }
}

export function hasOrgCap(ctx: AppContext, accountId: string, orgId: string | undefined, cap: Capability): boolean {
  return !!orgId && !!capsOf(ctx, accountId).byOrg.get(orgId)?.has(cap);
}

export function isDriverOn(load: Load, accountId: string): boolean {
  return load.legs.some((l) => l.driverAccountIds.includes(accountId));
}

export function canSeeLoad(ctx: AppContext, accountId: string, load: Load): boolean {
  if (isDriverOn(load, accountId)) return true;
  const orgIds = new Set(ctx.store.membershipsOf(accountId).map((m) => m.orgId));
  if (loadParties(load).some((o) => orgIds.has(o))) return true;
  return load.status === "POSTED" && capsOf(ctx, accountId).all.has("BID");
}

/** May this account act for the shipping side of the load (shipper or broker)? */
export function canShip(ctx: AppContext, accountId: string, load: Load): boolean {
  return hasOrgCap(ctx, accountId, load.shipperOrgId, "SHIP") || hasOrgCap(ctx, accountId, load.brokerOrgId, "BROKER");
}

export function getLoad(ctx: AppContext, accountId: string, id: string): Load {
  const load = ctx.store.loads.get(id);
  if (!load || !canSeeLoad(ctx, accountId, load)) throw new HttpError(404, "NOT_FOUND", "Load not found");
  return load;
}

/** Save a load and run what follows from the change. `actorAccountId` is who made it, when known. */
export function saveLoad(ctx: AppContext, load: Load, actorAccountId?: string): Load {
  const prior = ctx.store.loads.get(load.id);
  const key = carrierKeyOf(load);
  if (key !== (prior ? carrierKeyOf(prior) : undefined)) load = { ...load, carrierSince: key ? ctx.now().toISOString() : undefined };
  ctx.store.loads.set(load.id, load);
  ctx.notifier.loadSaved(prior, load);
  recordOutcome(ctx.store, load);
  rateConOnSave(ctx, prior, load, actorAccountId);
  return load;
}

/** Post to the load's thread, visible to every party on the load. */
export function postMessage(ctx: AppContext, load: Load, m: Pick<Message, "senderAccountId" | "kind" | "body"> & Partial<Pick<Message, "statusCode" | "senderOrgId">>): Message {
  const msg: Message = {
    id: newId("msg"),
    threadId: `load:${load.id}`,
    loadId: load.id,
    visibleToOrgIds: loadParties(load),
    createdAt: ctx.now().toISOString(),
    ...m,
  };
  ctx.store.messages.push(msg);
  return msg;
}

export function toHttpError(e: unknown): HttpError | undefined {
  if (e instanceof HttpError) return e;
  if (e instanceof DomainError) return new HttpError(e.status, e.code, e.message);
  return undefined;
}
