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

export class PersistentMap<V> extends Map<string, V> implements Persisted {
  sink: ChangeSink = noSink;

  constructor(readonly collection: string) {
    super();
  }

  override set(key: string, value: V): this {
    super.set(key, value);
    this.sink?.changed(this.collection, key);
    return this;
  }

  override delete(key: string): boolean {
    const had = super.delete(key);
    if (had) this.sink.removed(this.collection, key);
    return had;
  }

  override clear(): void {
    for (const key of [...this.keys()]) this.delete(key);
  }

  /** Report a value that was changed in place. */
  touch(key: string): void {
    if (this.has(key)) this.sink.changed(this.collection, key);
  }

  applyRemote(key: string, value: unknown): void {
    if (value === undefined) super.delete(key);
    else super.set(key, value as V);
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

  static create<T>(collection: string, keyOf: (item: T) => string): PersistentList<T> {
    const list = new PersistentList<T>();
    list.collection = collection;
    list.keyOf = keyOf;
    return list;
  }

  override push(...items: T[]): number {
    const n = super.push(...items);
    for (const item of items) this.sink.changed(this.collection, this.keyOf(item));
    return n;
  }

  /** Remove every record matching `predicate`. */
  removeWhere(predicate: (item: T) => boolean): T[] {
    const removed: T[] = [];
    for (let i = this.length - 1; i >= 0; i--) if (predicate(this[i]!)) removed.unshift(...this.splice(i, 1));
    for (const item of removed) this.sink.removed(this.collection, this.keyOf(item));
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
    if (value === undefined) {
      if (i >= 0) this.splice(i, 1);
    } else if (i >= 0) this[i] = value as T;
    else super.push(value as T);
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
