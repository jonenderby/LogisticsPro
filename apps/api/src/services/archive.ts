import { type Invoice, type Load, isOpen } from "@logisticspro/domain";
import type { AppContext } from "../http.js";
import type { Persisted } from "../persistence/collections.js";

const DAY_MS = 86_400_000;
const FINISHED: Load["status"][] = ["DELIVERED", "INVOICED", "CANCELLED"];
/** Records keyed by load id that leave memory and come back with their load. */
const KEYED_BY_LOAD = ["rateConfirmations", "exceptions", "appointmentMisses", "origins", "routeEstimates", "arrivalSeen"] as const;
/** Records that carry a loadId and leave memory with their load. */
const WITH_LOAD = ["messages", "bids", "invoices"] as const;

/**
 * Keeps memory to what is in play. Finished loads nobody has touched for
 * `archiveAfterDays` (with their messages, bids, paid invoices and other
 * per-load records) and old integration transmissions leave memory. They stay
 * in Postgres: opening an archived load or invoice brings it back
 * (`restoreLoad`), and older loads are searchable (`archivedLoads`).
 *
 * Every server sweeps its own memory; the server running background jobs also
 * marks the records archived so servers that start later don't load them.
 * Without a database nothing is archived, since memory is all there is.
 */
export async function archiveColdData(ctx: AppContext): Promise<{ loads: number; transmissions: number }> {
  const p = ctx.persistence;
  const days = ctx.cfg.archiveAfterDays;
  if (!p || !(days > 0)) return { loads: 0, transmissions: 0 };
  const now = ctx.now().getTime();
  const cutoff = new Date(now - days * DAY_MS).toISOString();
  const txCutoff = new Date(now - Math.max(1, ctx.cfg.archiveTransmissionsAfterDays) * DAY_MS).toISOString();
  const { store } = ctx;

  await p.flush();
  const invoicesOf = (loadId: string): Invoice[] => store.invoices.where("load", loadId);
  // An unpaid invoice keeps its load in memory.
  const cold = store.loadsIn(...FINISHED).filter((l) => l.updatedAt < cutoff && !invoicesOf(l.id).some(isOpen));
  const coldIds = new Set(cold.map((l) => l.id));
  const oldTx = store.transmissions.filter((t) => t.createdAt < txCutoff);

  if (p.isLeader()) {
    const ids = [...coldIds];
    await p.markArchived("loads", ids);
    for (const c of KEYED_BY_LOAD) await p.markArchived(c, ids.filter((id) => (store.collections().get(c) as Map<string, unknown> | undefined)?.has(id)));
    await p.markArchived("messages", ids.flatMap((id) => store.messages.group(id).map((m) => m.id)));
    await p.markArchived("bids", ids.flatMap((id) => store.bids.where("load", id).map((b) => b.id)));
    await p.markArchived("invoices", ids.flatMap((id) => invoicesOf(id).map((i) => i.id)));
    await p.markArchived("transmissions", oldTx.map((t) => t.id));
  }

  // Leave out anything changed while the database was being updated; the next sweep gets it.
  const evicted = new Set<string>();
  for (const l of cold) {
    const current = store.loads.get(l.id);
    if (!current || current.updatedAt !== l.updatedAt || p.isDirty("loads", l.id)) continue;
    const related = [
      ...store.messages.group(l.id).map((m) => ["messages", m.id] as const),
      ...KEYED_BY_LOAD.map((c) => [c, l.id] as const),
      ...invoicesOf(l.id).map((i) => ["invoices", i.id] as const),
    ];
    if (related.some(([c, k]) => p.isDirty(c, k))) continue;
    store.loads.evict(l.id);
    for (const c of KEYED_BY_LOAD) (store.collections().get(c) as unknown as { evict(k: string): void }).evict(l.id);
    for (const i of invoicesOf(l.id)) store.invoices.evict(i.id);
    evicted.add(l.id);
  }
  store.messages.evictWhere((m) => !!m.loadId && evicted.has(m.loadId) && !p.isDirty("messages", m.id));
  for (const id of evicted) for (const b of store.bids.where("load", id)) if (!p.isDirty("bids", b.id)) store.bids.evict(b.id);
  const tx = store.transmissions.evictWhere((t) => t.createdAt < txCutoff && !p.isDirty("transmissions", t.id));
  return { loads: evicted.size, transmissions: tx.length };
}

/** Bring an archived load, and what belongs to it, back into memory. Returns whether it exists. */
export async function restoreLoad(ctx: AppContext, id: string): Promise<boolean> {
  const p = ctx.persistence;
  if (ctx.store.loads.has(id)) return true;
  if (!p) return false;
  const load = (await p.readDocs("loads", [id])).get(id);
  if (!load) return false;
  const related = await p.readArchivedByLoad([...WITH_LOAD], id);
  const keyed = await Promise.all(KEYED_BY_LOAD.map(async (c) => [c, (await p.readDocs(c, [id])).get(id)] as const));
  // Another request may have restored it meanwhile.
  if (ctx.store.loads.has(id)) return true;
  const collections = ctx.store.collections();
  const apply = (c: string, k: string, v: unknown) => {
    // Never overwrite something already in memory, which may be newer.
    const coll = collections.get(c) as (Persisted & { has?(k: string): boolean; byKey?(k: string): unknown }) | undefined;
    if (!coll || (coll.has ? coll.has(k) : coll.byKey?.(k) !== undefined)) return;
    coll.applyRemote(k, v);
  };
  for (const r of related) apply(r.collection, r.key, r.doc);
  for (const [c, v] of keyed) if (v !== undefined) apply(c, id, v);
  apply("loads", id, load);
  return true;
}

/** Bring an archived invoice back, with its load. */
export async function restoreInvoice(ctx: AppContext, id: string): Promise<boolean> {
  if (ctx.store.invoices.has(id)) return true;
  const inv = (await ctx.persistence?.readDocs("invoices", [id]))?.get(id) as Invoice | undefined;
  if (!inv) return false;
  await restoreLoad(ctx, inv.loadId);
  if (!ctx.store.invoices.has(id)) ctx.store.invoices.applyRemote(id, inv);
  return true;
}

/** Archived loads an account can see through its companies, newest first. */
export async function archivedLoadsFor(ctx: AppContext, accountId: string, opts: { before?: string; q?: string; limit?: number }): Promise<Load[]> {
  if (!ctx.persistence) return [];
  const orgs = ctx.store.membershipsOf(accountId).map((m) => m.orgId);
  return ctx.persistence.archivedLoads<Load>(orgs, { ...opts, limit: Math.min(opts.limit ?? 50, 200) });
}
