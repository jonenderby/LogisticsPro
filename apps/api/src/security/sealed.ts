import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Credentials a business hands us (an ELD API key) are kept encrypted with
 * AES-256-GCM. The key comes from LP_DATA_KEY, or the session-signing secret
 * when that isn't set.
 */
function key(secret: Uint8Array, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), `logisticspro:${purpose}`, 32));
}

export function seal(secret: Uint8Array, purpose: string, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret, purpose), iv);
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function unseal(secret: Uint8Array, purpose: string, sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("Unreadable sealed value");
  const d = createDecipheriv("aes-256-gcm", key(secret, purpose), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
}
