/**
 * Collections the store keeps in memory and reports changes from, so a
 * persistence layer can write them through to a database and replicate them
 * between API servers. Reads are plain Map and Array reads.
 */
export interface ChangeSink {
  /** The value at `key` was created or changed. */
  changed(collection: string, key: string): void;
  /** The value at `key` was removed. */
  removed(collection: string, key: string): void;
  /** An item was appended to an append-only log. */
  appended(collection: string, key: string, item: unknown): void;
  /** Log items for `key` older than `before` were dropped. */
  pruned(collection: string, key: string, before: string): void;
}

export const noSink: ChangeSink = { changed() {}, removed() {}, appended() {}, pruned() {} };

export interface Persisted {
  readonly collection: string;
  sink: ChangeSink;
  /** Apply a change that came from the database, without reporting it back. */
  applyRemote(key: string, value: unknown): void;
}

/**
 * Secondary indexes: each index maps a term (an org id, a status) to the keys
 * whose value has that term, so lookups don't scan the whole collection.
 * Terms are re-read whenever a value is set, touched or replaced, so values
 * changed in place stay indexed correctly once they are saved.
 */
class Indexes<K> {
  private readonly defs = new Map<string, (value: never) => Array<string | undefined>>();
  private readonly terms = new Map<string, Map<K, string[]>>();
  private readonly postings = new Map<string, Map<string, Set<K>>>();

  define<V>(name: string, termsOf: (value: V) => Array<string | undefined>, entries: Iterable<[K, V]>): void {
    this.defs.set(name, termsOf as (value: never) => Array<string | undefined>);
    this.terms.set(name, new Map());
    this.postings.set(name, new Map());
    for (const [k, v] of entries) this.update(k, v);
  }

  update(key: K, value: unknown): void {
    for (const [name, termsOf] of this.defs) {
      const next = value === undefined ? [] : [...new Set(termsOf(value as never).filter((t): t is string => !!t))];
      const byKey = this.terms.get(name)!;
      const postings = this.postings.get(name)!;
      for (const t of byKey.get(key) ?? []) postings.get(t)?.delete(key);
      for (const t of next) {
        let set = postings.get(t);
        if (!set) postings.set(t, (set = new Set()));
        set.add(key);
      }
      if (next.length) byKey.set(key, next);
      else byKey.delete(key);
    }
  }

  keys(name: string, term: string): K[] {
    const postings = this.postings.get(name);
    if (!postings) throw new Error(`No index named ${name}`);
    return [...(postings.get(term) ?? [])];
  }
}

export class PersistentMap<V> extends Map<string, V> implements Persisted {
  sink: ChangeSink = noSink;
  private indexes?: Indexes<string>;

  constructor(readonly collection: string) {
    super();
  }

  /** Keep an index of values by the terms `termsOf` returns. */
  index(name: string, termsOf: (value: V) => Array<string | undefined>): this {
    (this.indexes ??= new Indexes()).define(name, termsOf, this.entries());
    return this;
  }

  /** Values whose index `name` has `term`. */
  where(name: string, term: string): V[] {
    return this.indexes!.keys(name, term).map((k) => super.get(k)!).filter((v) => v !== undefined);
  }

  override set(key: string, value: V): this {
    super.set(key, value);
    this.indexes?.update(key, value);
    this.sink?.changed(this.collection, key);
    return this;
  }

  override delete(key: string): boolean {
    const had = super.delete(key);
    this.indexes?.update(key, undefined);
    if (had) this.sink.removed(this.collection, key);
    return had;
  }

  override clear(): void {
    for (const key of [...this.keys()]) this.delete(key);
  }

  /** Report a value that was changed in place. */
  touch(key: string): void {
    if (!this.has(key)) return;
    this.indexes?.update(key, super.get(key));
    this.sink.changed(this.collection, key);
  }

  /** Drop a value from memory only; the database keeps it (archiving). */
  evict(key: string): void {
    super.delete(key);
    this.indexes?.update(key, undefined);
  }

  applyRemote(key: string, value: unknown): void {
    if (value === undefined) super.delete(key);
    else super.set(key, value as V);
    this.indexes?.update(key, value);
  }
}

/** An ordered list of keyed records (memberships, messages, transmissions). */
export class PersistentList<T> extends Array<T> implements Persisted {
  // Methods like filter and map return plain arrays.
  static override get [Symbol.species]() {
    return Array;
  }

  sink: ChangeSink = noSink;
  collection = "";
  keyOf: (item: T) => string = () => "";
  /** Records grouped by a term (messages by load), kept in insertion order. */
  private groupOf?: (item: T) => string | undefined;
  private groups = new Map<string, T[]>();

  static create<T>(collection: string, keyOf: (item: T) => string, groupOf?: (item: T) => string | undefined): PersistentList<T> {
    const list = new PersistentList<T>();
    list.collection = collection;
    list.keyOf = keyOf;
    list.groupOf = groupOf;
    return list;
  }

  /** Records in group `term`, oldest first. */
  group(term: string): T[] {
    if (!this.groupOf) throw new Error(`${this.collection} is not grouped`);
    return [...(this.groups.get(term) ?? [])];
  }

  private grouped(item: T, add: boolean) {
    const term = this.groupOf?.(item);
    if (term === undefined) return;
    const g = this.groups.get(term) ?? [];
    if (add) g.push(item);
    else {
      const i = g.indexOf(item);
      if (i >= 0) g.splice(i, 1);
    }
    if (g.length) this.groups.set(term, g);
    else this.groups.delete(term);
  }

  override push(...items: T[]): number {
    const n = super.push(...items);
    for (const item of items) {
      this.grouped(item, true);
      this.sink.changed(this.collection, this.keyOf(item));
    }
    return n;
  }

  /** Remove every record matching `predicate`. */
  removeWhere(predicate: (item: T) => boolean): T[] {
    const removed = this.take(predicate);
    for (const item of removed) this.sink.removed(this.collection, this.keyOf(item));
    return removed;
  }

  /** Drop matching records from memory only; the database keeps them (archiving). */
  evictWhere(predicate: (item: T) => boolean): T[] {
    return this.take(predicate);
  }

  private take(predicate: (item: T) => boolean): T[] {
    const removed: T[] = [];
    for (let i = this.length - 1; i >= 0; i--) if (predicate(this[i]!)) removed.unshift(...this.splice(i, 1));
    for (const item of removed) this.grouped(item, false);
    return removed;
  }

  /** Report a record that was changed in place. */
  touch(item: T): void {
    this.sink.changed(this.collection, this.keyOf(item));
  }

  byKey(key: string): T | undefined {
    return this.find((i) => this.keyOf(i) === key);
  }

  applyRemote(key: string, value: unknown): void {
    const i = this.findIndex((x) => this.keyOf(x) === key);
    if (i >= 0) this.grouped(this[i]!, false);
    if (value === undefined) {
      if (i >= 0) this.splice(i, 1);
      return;
    }
    if (i >= 0) this[i] = value as T;
    else super.push(value as T);
    this.grouped(value as T, true);
  }
}

/**
 * Append-only logs per key (a driver's location trail). Appends and prunes
 * are reported item by item, so a ping never rewrites the whole trail.
 */
export class AppendLog<T extends { at: string }> implements Persisted {
  sink: ChangeSink = noSink;
  private readonly logs = new Map<string, T[]>();

  constructor(readonly collection: string) {}

  get(key: string): T[] | undefined {
    return this.logs.get(key);
  }

  append(key: string, item: T): void {
    this.applyAppend(key, item);
    this.sink.appended(this.collection, key, item);
  }

  /** Drop items older than `before` (ISO time). */
  prune(key: string, before: string): void {
    const log = this.logs.get(key);
    if (!log?.length || log[0]!.at >= before) return;
    this.applyPrune(key, before);
    this.sink.pruned(this.collection, key, before);
  }

  applyAppend(key: string, item: T): void {
    const log = this.logs.get(key) ?? [];
    // Keep time order even if a replicated item arrives late.
    let i = log.length;
    while (i > 0 && log[i - 1]!.at > item.at) i--;
    log.splice(i, 0, item);
    this.logs.set(key, log);
  }

  applyPrune(key: string, before: string): void {
    const log = this.logs.get(key);
    if (log) this.logs.set(key, log.filter((x) => x.at >= before));
  }

  applyRemote(key: string, value: unknown): void {
    if (value === undefined) this.logs.delete(key);
    else this.logs.set(key, value as T[]);
  }

  keys(): IterableIterator<string> {
    return this.logs.keys();
  }
}
