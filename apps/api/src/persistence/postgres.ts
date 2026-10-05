import { randomUUID } from "node:crypto";
import pg from "pg";
import type { MemoryStore } from "../store.js";
import type { AppendLog, ChangeSink, Persisted } from "./collections.js";

const CHANNEL = "lp_changes";
const JOB_LOCK = 727_274;
const LOAD_NUMBER_BLOCK = 50;
const FIRST_LOAD_NUMBER = 100_001;
const FLUSH_DELAY_MS = 20;
const LOG_KEEP_MS = 9 * 86_400_000;
/** NOTIFY payloads must stay under 8,000 bytes. */
const MAX_PAYLOAD = 7_500;

const SCHEMA = `
create table if not exists lp_docs (
  collection text not null,
  key text not null,
  doc jsonb not null,
  seq bigserial,
  updated_at timestamptz not null default now(),
  primary key (collection, key)
);
create index if not exists lp_docs_order on lp_docs (collection, seq);
create table if not exists lp_log (
  id bigserial primary key,
  collection text not null,
  key text not null,
  at timestamptz not null,
  item jsonb not null
);
create index if not exists lp_log_key_at on lp_log (collection, key, at);
create sequence if not exists lp_load_number_block minvalue 0 start 0;
`;

interface Change {
  /** Instance that made the change; others apply it. */
  i: string;
  /** Documents changed or removed: [collection, key]. */
  d?: Array<[string, string]>;
  /** Log items appended: [collection, key, item]. */
  a?: Array<[string, string, unknown]>;
  /** Log items pruned: [collection, key, before]. */
  p?: Array<[string, string, string]>;
}

type Logger = { info(msg: string): void; error(msg: string, e?: unknown): void };

/**
 * Keeps the in-memory store durable in Postgres and in step across API
 * servers.
 *
 * - Every change the store reports is written in a batch; a request does not
 *   get its response until its changes are committed.
 * - After each commit, other servers are told which records changed
 *   (LISTEN/NOTIFY) and re-read them, so every server serves the same data.
 * - On start, everything is loaded from the database.
 * - One server at a time holds the job lock and runs background jobs.
 * - Load numbers come from blocks reserved in the database, so two servers
 *   never hand out the same number.
 *
 * Concurrent writes to the same record from two servers resolve to the last
 * commit, and every server converges on it.
 */
export class PgPersistence implements ChangeSink {
  readonly instanceId = randomUUID();
  private dirty = new Map<string, Set<string>>();
  private appends: Array<[string, string, { at: string }]> = [];
  private prunes: Array<[string, string, string]> = [];
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();
  private applying: Promise<void> = Promise.resolve();
  private listener?: pg.PoolClient;
  private lockClient?: pg.PoolClient;
  private leader = false;
  private leaderTimer?: ReturnType<typeof setInterval>;
  private numbers: number[] = [];
  private refilling?: Promise<void>;
  private closed = false;

  private constructor(
    private readonly pool: pg.Pool,
    private readonly store: MemoryStore,
    private readonly log: Logger,
  ) {}

  static async start(opts: { url: string; store: MemoryStore; log?: Logger }): Promise<PgPersistence> {
    const pool = new pg.Pool({ connectionString: opts.url, max: 10 });
    const p = new PgPersistence(pool, opts.store, opts.log ?? { info: () => undefined, error: (m, e) => console.error(m, e) });
    await pool.query(SCHEMA);
    await p.load();
    opts.store.attach(p);
    await p.listen();
    await p.refillNumbers(2);
    opts.store.useLoadNumbers(() => p.nextLoadNumber());
    await p.tryLead();
    p.leaderTimer = setInterval(() => void p.tryLead(), 15_000);
    p.leaderTimer.unref();
    return p;
  }

  // ------------------------------------------------------------- loading

  private async load() {
    const collections = this.store.collections();
    const docs = await this.pool.query<{ collection: string; key: string; doc: unknown }>("select collection, key, doc from lp_docs order by collection, seq");
    for (const row of docs.rows) collections.get(row.collection)?.applyRemote(row.key, row.doc);
    const since = new Date(Date.now() - LOG_KEEP_MS);
    const logs = await this.pool.query<{ collection: string; key: string; item: { at: string } }>("select collection, key, item from lp_log where at >= $1 order by at", [since]);
    for (const row of logs.rows) (collections.get(row.collection) as AppendLog<{ at: string }> | undefined)?.applyAppend(row.key, row.item);
    this.log.info(`Loaded ${docs.rowCount} records and ${logs.rowCount} log entries from Postgres`);
  }

  // ------------------------------------------------------------- writing

  changed(collection: string, key: string): void {
    this.mark(collection, key);
  }

  removed(collection: string, key: string): void {
    this.mark(collection, key);
  }

  appended(collection: string, key: string, item: unknown): void {
    this.appends.push([collection, key, item as { at: string }]);
    this.schedule();
  }

  pruned(collection: string, key: string, before: string): void {
    this.prunes.push([collection, key, before]);
    this.schedule();
  }

  private mark(collection: string, key: string) {
    let keys = this.dirty.get(collection);
    if (!keys) this.dirty.set(collection, (keys = new Set()));
    keys.add(key);
    this.schedule();
  }

  private schedule() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => void this.flush().catch((e) => this.log.error("Postgres write failed", e)), FLUSH_DELAY_MS);
  }

  /** Write every pending change now. Resolves once committed; rejects if the database refused it. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const run = this.writing.catch(() => undefined).then(() => this.write());
    this.writing = run;
    return run;
  }

  private async write() {
    if (!this.dirty.size && !this.appends.length && !this.prunes.length) return;
    const dirty = this.dirty;
    const appends = this.appends;
    const prunes = this.prunes;
    this.dirty = new Map();
    this.appends = [];
    this.prunes = [];

    const collections = this.store.collections();
    const up: { c: string[]; k: string[]; d: string[] } = { c: [], k: [], d: [] };
    const del: { c: string[]; k: string[] } = { c: [], k: [] };
    for (const [c, keys] of dirty) {
      const coll = collections.get(c);
      for (const k of keys) {
        const value = coll ? currentValue(coll, k) : undefined;
        if (value === undefined) {
          del.c.push(c);
          del.k.push(k);
        } else {
          up.c.push(c);
          up.k.push(k);
          up.d.push(JSON.stringify(value));
        }
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (up.c.length) {
        await client.query(
          `insert into lp_docs (collection, key, doc)
           select * from unnest($1::text[], $2::text[], $3::jsonb[])
           on conflict (collection, key) do update set doc = excluded.doc, updated_at = now()`,
          [up.c, up.k, up.d],
        );
      }
      if (del.c.length) await client.query("delete from lp_docs where (collection, key) in (select * from unnest($1::text[], $2::text[]))", [del.c, del.k]);
      if (appends.length) {
        await client.query("insert into lp_log (collection, key, at, item) select * from unnest($1::text[], $2::text[], $3::timestamptz[], $4::jsonb[])", [
          appends.map((a) => a[0]),
          appends.map((a) => a[1]),
          appends.map((a) => a[2].at),
          appends.map((a) => JSON.stringify(a[2])),
        ]);
      }
      for (const [c, k, before] of prunes) await client.query("delete from lp_log where collection = $1 and key = $2 and at < $3", [c, k, before]);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      // Keep the changes for the next attempt.
      for (const [c, keys] of dirty) for (const k of keys) this.mark(c, k);
      this.appends.unshift(...appends);
      this.prunes.unshift(...prunes);
      throw e;
    } finally {
      client.release();
    }

    await this.announce({
      i: this.instanceId,
      d: [...up.c.map((c, n): [string, string] => [c, up.k[n]!]), ...del.c.map((c, n): [string, string] => [c, del.k[n]!])],
      a: appends,
      p: prunes,
    });
  }

  /** Tell other servers what changed, in payloads small enough for NOTIFY. */
  private async announce(change: Change) {
    const parts: Change[] = [];
    let cur: Change = { i: change.i, d: [], a: [], p: [] };
    const size = (c: Change) => JSON.stringify(c).length;
    const add = <K extends "d" | "a" | "p">(k: K, item: NonNullable<Change[K]>[number]) => {
      (cur[k] as unknown[]).push(item);
      if (size(cur) > MAX_PAYLOAD) {
        (cur[k] as unknown[]).pop();
        parts.push(cur);
        cur = { i: change.i, d: [], a: [], p: [] };
        (cur[k] as unknown[]).push(item);
      }
    };
    for (const d of change.d ?? []) add("d", d);
    for (const a of change.a ?? []) {
      // A log item too big to announce is re-read by key instead.
      if (JSON.stringify(a).length > MAX_PAYLOAD / 2) add("d", [a[0], `log:${a[1]}`]);
      else add("a", a);
    }
    for (const p of change.p ?? []) add("p", p);
    parts.push(cur);
    for (const part of parts) if (part.d?.length || part.a?.length || part.p?.length) await this.pool.query("select pg_notify($1, $2)", [CHANNEL, JSON.stringify(part)]);
  }

  // ------------------------------------------------------------- replication

  private async listen() {
    this.listener = await this.pool.connect();
    this.listener.on("notification", (n) => {
      if (n.channel !== CHANNEL || !n.payload) return;
      const change = JSON.parse(n.payload) as Change;
      if (change.i === this.instanceId) return;
      this.applying = this.applying.then(() => this.apply(change)).catch((e) => this.log.error("Applying a change from another server failed", e));
    });
    this.listener.on("error", (e) => this.log.error("Postgres listener connection failed", e));
    await this.listener.query(`listen ${CHANNEL}`);
  }

  private async apply(change: Change) {
    const collections = this.store.collections();
    const docs = (change.d ?? []).filter(([c, k]) => !k.startsWith("log:") && !this.dirty.get(c)?.has(k));
    if (docs.length) {
      const res = await this.pool.query<{ collection: string; key: string; doc: unknown }>(
        "select collection, key, doc from lp_docs where (collection, key) in (select * from unnest($1::text[], $2::text[]))",
        [docs.map((d) => d[0]), docs.map((d) => d[1])],
      );
      const found = new Map(res.rows.map((r) => [`${r.collection}\u0000${r.key}`, r.doc]));
      // A record changed locally since is not overwritten; this server's own write follows.
      for (const [c, k] of docs) if (!this.dirty.get(c)?.has(k)) collections.get(c)?.applyRemote(k, found.get(`${c}\u0000${k}`));
    }
    for (const [c, k] of (change.d ?? []).filter(([, k]) => k.startsWith("log:"))) {
      const key = k.slice(4);
      const rows = await this.pool.query<{ item: { at: string } }>("select item from lp_log where collection = $1 and key = $2 and at >= $3 order by at", [c, key, new Date(Date.now() - LOG_KEEP_MS)]);
      collections.get(c)?.applyRemote(key, rows.rows.map((r) => r.item));
    }
    for (const [c, k, item] of change.a ?? []) (collections.get(c) as AppendLog<{ at: string }> | undefined)?.applyAppend(k, item as { at: string });
    for (const [c, k, before] of change.p ?? []) (collections.get(c) as AppendLog<{ at: string }> | undefined)?.applyPrune(k, before);
  }

  /** Wait until changes announced so far by other servers are applied (tests). */
  settled(): Promise<void> {
    return this.applying;
  }

  // ------------------------------------------------------------- jobs

  /** Whether this server holds the job lock and should run background jobs. */
  isLeader(): boolean {
    return this.leader;
  }

  private async tryLead() {
    if (this.leader || this.closed) return;
    try {
      const client = await this.pool.connect();
      const { rows } = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [JOB_LOCK]);
      if (!rows[0]?.ok) {
        client.release();
        return;
      }
      this.lockClient = client;
      this.leader = true;
      // The lock lives as long as this connection; losing it hands jobs to another server.
      client.on("error", () => {
        this.leader = false;
        this.lockClient = undefined;
      });
      this.log.info("This server runs background jobs");
    } catch (e) {
      this.log.error("Could not check the job lock", e);
    }
  }

  // ------------------------------------------------------------- load numbers

  private nextLoadNumber(): number {
    const n = this.numbers.shift();
    if (this.numbers.length < LOAD_NUMBER_BLOCK / 2) void this.refillNumbers(1);
    if (n === undefined) throw new Error("No load numbers reserved yet; try again");
    return n;
  }

  private refillNumbers(blocks: number): Promise<void> {
    this.refilling ??= (async () => {
      try {
        for (let b = 0; b < blocks; b++) {
          const { rows } = await this.pool.query<{ block: string }>("select nextval('lp_load_number_block') as block");
          const start = FIRST_LOAD_NUMBER + Number(rows[0]!.block) * LOAD_NUMBER_BLOCK;
          for (let i = 0; i < LOAD_NUMBER_BLOCK; i++) this.numbers.push(start + i);
        }
      } finally {
        this.refilling = undefined;
      }
    })();
    return this.refilling;
  }

  // ------------------------------------------------------------- shutdown

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush().catch((e) => this.log.error("Final Postgres write failed", e));
    this.closed = true;
    if (this.leaderTimer) clearInterval(this.leaderTimer);
    await this.applying.catch(() => undefined);
    if (this.lockClient) {
      await this.lockClient.query("select pg_advisory_unlock($1)", [JOB_LOCK]).catch(() => undefined);
      this.lockClient.release();
    }
    this.leader = false;
    if (this.listener) {
      await this.listener.query(`unlisten ${CHANNEL}`).catch(() => undefined);
      this.listener.release();
    }
    await this.pool.end();
  }
}

function currentValue(coll: Persisted, key: string): unknown {
  const c = coll as unknown as { get?: (k: string) => unknown; byKey?: (k: string) => unknown };
  return c.byKey ? c.byKey(key) : c.get?.(key);
}
