import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 16384;
const KEYLEN = 64;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEYLEN, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** scrypt$N$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || Number(n) !== N || !salt || !hash) return false;
  const key = await derive(password, Buffer.from(salt, "base64"));
  const expected = Buffer.from(hash, "base64");
  return expected.length === key.length && timingSafeEqual(expected, key);
}

export function passwordProblems(password: string, email: string): string[] {
  const issues: string[] = [];
  if (password.length < 12) issues.push("Use at least 12 characters");
  if (password.length > 256) issues.push("Use at most 256 characters");
  const local = email.split("@")[0]!.toLowerCase();
  if (local.length >= 4 && password.toLowerCase().includes(local)) issues.push("Do not include your email name");
  return issues;
}
