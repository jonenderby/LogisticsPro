import type { AppContext } from "../http.js";

/** One holder per key at a time, within this server. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async lock(key: string): Promise<() => Promise<void>> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}

const local = new WeakMap<AppContext, KeyedMutex>();

/**
 * Hold a record while changing it, so two requests (on any server) can't act
 * on the same load or invoice at once: two awards of one load, or a tender
 * accepted twice. With a database the lock spans every server.
 */
export function lockRecord(ctx: AppContext, key: string): Promise<() => Promise<void>> {
  if (ctx.persistence) return ctx.persistence.lock(key);
  let m = local.get(ctx);
  if (!m) local.set(ctx, (m = new KeyedMutex()));
  return m.lock(key);
}
