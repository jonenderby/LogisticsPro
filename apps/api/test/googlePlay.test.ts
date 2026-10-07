import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PlayError, publishBundle } from "../src/services/googlePlay.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = { client_email: "lp-release@lp.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };

interface Call {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

/** A stand-in for Google's token endpoint and the Play Developer API. */
function fakeGoogle(opts: { draftApp?: boolean; fail?: { path: string; status: number; message: string } } = {}) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array }) => {
    calls.push({ url, ...init });
    const reply = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
    if (opts.fail && url.includes(opts.fail.path)) return reply(opts.fail.status, { error: { message: opts.fail.message } });
    if (url === "https://oauth2.googleapis.com/token") return reply(200, { access_token: "tok-1" });
    if (url.endsWith("/edits")) return reply(200, { id: "edit-9" });
    if (url.includes("/bundles?uploadType=media")) return reply(200, { versionCode: 29632001, sha256: "x" });
    if (url.includes("/tracks/")) {
      const status = JSON.parse(String(init.body)).releases[0].status;
      if (opts.draftApp && status !== "draft") return reply(400, { error: { message: "Only releases with status draft may be created on draft app." } });
      return reply(200, {});
    }
    if (url.endsWith(":commit")) return reply(200, { id: "edit-9" });
    return reply(404, { error: { message: "unexpected" } });
  };
  return { calls, fetch };
}

describe("Google Play uploads", () => {
  it("signs in as the service account, uploads the bundle and releases it to internal testing", async () => {
    const g = fakeGoogle();
    const bundle = new Uint8Array([1, 2, 3]);
    const result = await publishBundle({ account, packageName: "com.logisticspro.app", bundle, track: "internal", notes: "Driver pay statements", fetch: g.fetch, now: () => new Date("2026-10-07T01:00:00Z") });
    expect(result).toEqual({ versionCode: 29632001, track: "internal", status: "completed" });

    // The sign-in is a JWT signed with the account's key, for the Play publishing scope only.
    const assertion = new URLSearchParams(String(g.calls[0]!.body)).get("assertion")!;
    const [h, p, sig] = assertion.split(".");
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toMatchObject({ iss: account.client_email, scope: "https://www.googleapis.com/auth/androidpublisher", iat: 1791334800, exp: 1791338400 });

    const app = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.logisticspro.app";
    expect(g.calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${app}/edits`,
      `POST https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/com.logisticspro.app/edits/edit-9/bundles?uploadType=media`,
      `PUT ${app}/edits/edit-9/tracks/internal`,
      `POST ${app}/edits/edit-9:commit`,
    ]);
    expect(g.calls[2]!.body).toBe(bundle);
    expect(g.calls[2]!.headers).toMatchObject({ authorization: "Bearer tok-1", "content-type": "application/octet-stream" });
    expect(JSON.parse(String(g.calls[3]!.body))).toEqual({
      track: "internal",
      releases: [{ name: "29632001", versionCodes: ["29632001"], status: "completed", releaseNotes: [{ language: "en-US", text: "Driver pay statements" }] }],
    });
  });

  it("leaves a draft release while the app is still being set up in Play Console", async () => {
    const g = fakeGoogle({ draftApp: true });
    const result = await publishBundle({ account, packageName: "com.logisticspro.app", bundle: new Uint8Array([1]), track: "internal", fetch: g.fetch });
    expect(result.status).toBe("draft");
    expect(g.calls.at(-1)!.url).toMatch(/:commit$/);
  });

  it("says what to do when Play refuses", async () => {
    const run = (fail: { path: string; status: number; message: string }) => publishBundle({ account, packageName: "com.logisticspro.app", bundle: new Uint8Array([1]), track: "internal", fetch: fakeGoogle({ fail }).fetch });
    await expect(run({ path: "/edits", status: 404, message: "Package not found: com.logisticspro.app." })).rejects.toThrow(/Create it in Play Console and upload the first bundle there by hand/);
    await expect(run({ path: "/edits", status: 403, message: "The caller does not have permission" })).rejects.toThrow(/invite its email with Release permissions/);
    await expect(run({ path: "/bundles", status: 403, message: "APK specifies a version code that has already been used." })).rejects.toThrow(PlayError);
    await expect(run({ path: "/bundles", status: 400, message: "APK specifies a version code that has already been used." })).rejects.toThrow(/already has this build number/);
    await expect(run({ path: "/bundles", status: 400, message: "The Android App Bundle was signed with the wrong key." })).rejects.toThrow(/Use deploy\/android-keys from the first upload/);
    await expect(run({ path: "oauth2", status: 400, message: "invalid_grant" })).rejects.toThrow(/Google sign-in failed/);
  });
});
