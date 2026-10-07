import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PgPersistence } from "../persistence/postgres.js";

/** Where uploaded documents' bytes are kept. Their details live in the store. */
export interface FileBytes {
  put(id: string, bytes: Buffer): Promise<void>;
  get(id: string): Promise<Buffer | undefined>;
}

export class MemoryFileBytes implements FileBytes {
  private readonly files = new Map<string, Buffer>();
  async put(id: string, bytes: Buffer) {
    this.files.set(id, bytes);
  }
  async get(id: string) {
    return this.files.get(id);
  }
}

/** One file per document in a directory (a single server, or a shared volume). */
export class DiskFileBytes implements FileBytes {
  constructor(private readonly dir: string) {}
  async put(id: string, bytes: Buffer) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, safe(id)), bytes, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
  }
  async get(id: string) {
    return readFile(join(this.dir, safe(id))).catch(() => undefined);
  }
}

/** In Postgres with everything else, so every API server can serve every file. */
export class PgFileBytes implements FileBytes {
  constructor(private readonly db: PgPersistence) {}
  put(id: string, bytes: Buffer) {
    return this.db.putFile(id, bytes);
  }
  get(id: string) {
    return this.db.getFile(id);
  }
}

const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "");

/** What an upload really is, from its first bytes; the declared type must agree. */
export function sniff(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" | "application/pdf" | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return undefined;
}

/**
 * Short-lived links to a file, so an image tag or a new browser tab can
 * show it without the session token.
 */
export function signFileUrl(secret: Uint8Array, id: string, now: Date, ttlSeconds = 3600): string {
  const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
  return `/v1/files/${id}?exp=${exp}&sig=${sig(secret, id, exp)}`;
}

export function verifyFileSig(secret: Uint8Array, id: string, exp: string | undefined, signature: string | undefined, now: Date): boolean {
  if (!exp || !signature || !/^\d+$/.test(exp) || Number(exp) * 1000 < now.getTime()) return false;
  const want = Buffer.from(sig(secret, id, Number(exp)));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}

function sig(secret: Uint8Array, id: string, exp: number): string {
  return createHmac("sha256", secret).update(`file:${id}:${exp}`).digest("base64url");
}
