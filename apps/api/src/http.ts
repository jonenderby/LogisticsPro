import type { Account, Load, Message } from "@logisticspro/domain";
import { DomainError, loadParties, newId } from "@logisticspro/domain";
import type { IntegrationEngine } from "@logisticspro/integration";
import type { RoutingProvider } from "@logisticspro/navigation";
import { type Capability, type ResolvedCapabilities, resolveCapabilities } from "@logisticspro/workspace";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Config } from "./config.js";
import type { Tokens } from "./security/tokens.js";
import type { IntegrationHub } from "./services/hub.js";
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
  hub: IntegrationHub;
  routing: RoutingProvider;
  now: () => Date;
}

declare module "fastify" {
  interface FastifyRequest {
    accountId?: string;
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
      if (!ctx.store.accounts.has(claims.sub)) throw new Error("no account");
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

export function getLoad(ctx: AppContext, accountId: string, id: string): Load {
  const load = ctx.store.loads.get(id);
  if (!load || !canSeeLoad(ctx, accountId, load)) throw new HttpError(404, "NOT_FOUND", "Load not found");
  return load;
}

export function saveLoad(ctx: AppContext, load: Load): Load {
  ctx.store.loads.set(load.id, load);
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
