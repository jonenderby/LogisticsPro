import { createSign } from "node:crypto";

/**
 * Upload an Android App Bundle to a Google Play testing track with the Play
 * Developer API, signed in as a service account. Used by
 * deploy/publish-play.sh; nothing here runs inside the API server.
 */

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

type FetchLike = (url: string, init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface PublishOptions {
  account: ServiceAccount;
  packageName: string;
  bundle: Uint8Array;
  /** internal, alpha (closed testing), beta (open testing) or production. */
  track: string;
  releaseName?: string;
  notes?: string;
  fetch?: FetchLike;
  now?: () => Date;
  base?: string;
}

export interface PublishResult {
  versionCode: number;
  track: string;
  /** "completed" when testers get it now; "draft" while the app is still being set up in Play Console. */
  status: "completed" | "draft";
}

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class PlayError extends Error {}

/** A signed JWT exchanged for an access token (OAuth 2.0 service account flow). */
export async function accessToken(account: ServiceAccount, fetchFn: FetchLike, now = new Date()): Promise<string> {
  const aud = account.token_uri ?? "https://oauth2.googleapis.com/token";
  const iat = Math.floor(now.getTime() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud, iat, exp: iat + 3600 }))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(account.private_key);
  const res = await fetchFn(aud, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(signature)}` }).toString(),
  });
  const body = await res.text();
  if (!res.ok) throw new PlayError(`Google sign-in failed (${res.status}): ${body.slice(0, 300)}`);
  return (JSON.parse(body) as { access_token: string }).access_token;
}

export async function publishBundle(o: PublishOptions): Promise<PublishResult> {
  const fetchFn = o.fetch ?? (fetch as unknown as FetchLike);
  const base = o.base ?? "https://androidpublisher.googleapis.com";
  const token = await accessToken(o.account, fetchFn, o.now?.());
  const app = `applications/${encodeURIComponent(o.packageName)}`;
  const call = async (method: string, path: string, body?: unknown, raw?: Uint8Array) => {
    const res = await fetchFn(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": raw ? "application/octet-stream" : "application/json" },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await res.text();
    if (!res.ok) throw new PlayError(explain(res.status, text, o.packageName));
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };

  // Every change happens inside an edit, which only takes effect when committed.
  const edit = (await call("POST", `/androidpublisher/v3/${app}/edits`, {})) as { id: string };
  const e = `/androidpublisher/v3/${app}/edits/${edit.id}`;
  const uploaded = (await call("POST", `/upload${e}/bundles?uploadType=media`, undefined, o.bundle)) as { versionCode: number };
  const release = (status: "completed" | "draft") => ({
    track: o.track,
    releases: [{ name: o.releaseName ?? String(uploaded.versionCode), versionCodes: [String(uploaded.versionCode)], status, ...(o.notes ? { releaseNotes: [{ language: "en-US", text: o.notes.slice(0, 500) }] } : {}) }],
  });
  let status: "completed" | "draft" = "completed";
  try {
    await call("PUT", `${e}/tracks/${o.track}`, release(status));
  } catch (err) {
    // Until the app's store setup is finished, Play only takes draft releases.
    if (!(err instanceof PlayError) || !/draft app/i.test(err.message)) throw err;
    status = "draft";
    await call("PUT", `${e}/tracks/${o.track}`, release(status));
  }
  await call("POST", `${e}:commit`);
  return { versionCode: uploaded.versionCode, track: o.track, status };
}

/** Google's errors, with what to do about the common ones. */
function explain(status: number, body: string, packageName: string): string {
  let message = body;
  try {
    message = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body;
  } catch {
    // not JSON
  }
  if (status === 404 && /package/i.test(message)) return `Google Play has no app ${packageName}. Create it in Play Console and upload the first bundle there by hand. ${message}`;
  if (status === 403) return `The service account can't release this app. In Play Console > Users and permissions, invite its email with Release permissions. ${message}`;
  if (/version code/i.test(message)) return `Google Play already has this build number. Run deploy/build-android.sh again for a new one. ${message}`;
  if (/upload key|signed with the wrong key|certificate/i.test(message)) return `The bundle is signed with a different key than Play expects. Use deploy/android-keys from the first upload. ${message}`;
  return `Google Play said (${status}): ${message}`;
}
