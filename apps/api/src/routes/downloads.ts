import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { translator } from "@logisticspro/workspace";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../http.js";
import { esc, htmlPage, pageLanguage } from "./pages.js";

/**
 * The phone app, downloaded from this server: an Android APK built by
 * deploy/build-android.sh and, optionally, an iPhone ad hoc build. Files are
 * looked up on each request, so a new build is offered without a restart.
 */

export const APK = "logistics-pro.apk";
export const IPA = "logistics-pro.ipa";
/** Written next to the builds: { version, builtAt, bundleId }. */
const INFO = "build.json";

interface BuildInfo {
  version?: string;
  builtAt?: string;
  bundleId?: string;
}

export function downloadRoutes(app: FastifyInstance, ctx: AppContext) {
  const dir = ctx.cfg.downloadsDir;
  if (!dir) return;
  const root = resolve(dir);
  const file = (name: string) => {
    const path = resolve(root, name);
    return existsSync(path) ? { path, size: statSync(path).size, at: statSync(path).mtime } : undefined;
  };
  const info = (): BuildInfo => {
    try {
      return JSON.parse(readFileSync(resolve(root, INFO), "utf8")) as BuildInfo;
    } catch {
      return {};
    }
  };

  app.get("/download", async (req, reply) => {
    const lang = pageLanguage(req.headers["accept-language"]);
    const t = translator(lang);
    const apk = file(APK);
    const ipa = file(IPA);
    const build = info();
    const mb = (n: number) => `${(n / 1_048_576).toFixed(0)} MB`;
    const when = (d: Date) => d.toISOString().slice(0, 10);
    const manifest = `${ctx.cfg.publicUrl}/download/manifest.plist`;
    const rows = [
      apk &&
        `<a class="btn" href="/download/${APK}">${esc(t("Download for Android"))}</a><p class="note">${esc(t("Version {version}, built {date}, {size}.", { version: build.version ?? "1.0.0", date: when(apk.at), size: mb(apk.size) }))} ${esc(t("Android asks to allow installs from your browser the first time."))}</p>`,
      ipa &&
        `<a class="btn" href="itms-services://?action=download-manifest&amp;url=${encodeURIComponent(manifest)}">${esc(t("Install on iPhone"))}</a><p class="note">${esc(t("Only iPhones registered for this build can install it."))}</p>`,
    ].filter(Boolean);
    const body = rows.length ? rows.join("\n") : `<p>${esc(t("No phone app has been built on this server yet."))}</p>`;
    reply.header("content-type", "text/html; charset=utf-8").header("cache-control", "no-cache");
    return htmlPage(lang, t("Get the Logistics Pro app"), `${body}
<p class="note" style="margin-top:2rem"><a href="/">${esc(t("Or use Logistics Pro in your browser"))}</a></p>`);
  });

  const send = (name: string, type: string) => async (_req: unknown, reply: import("fastify").FastifyReply) => {
    const f = file(name);
    if (!f) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not built yet" } });
    return reply
      .header("content-type", type)
      .header("content-length", f.size)
      .header("content-disposition", `attachment; filename="${name}"`)
      .header("cache-control", "no-cache")
      .send(createReadStream(f.path));
  };
  app.get(`/download/${APK}`, send(APK, "application/vnd.android.package-archive"));
  app.get(`/download/${IPA}`, send(IPA, "application/octet-stream"));

  /** What iOS reads to install an ad hoc build over the air. */
  app.get("/download/manifest.plist", async (_req, reply) => {
    if (!file(IPA)) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not built yet" } });
    const build = info();
    reply.header("content-type", "application/xml").header("cache-control", "no-cache");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict>
<key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>${esc(`${ctx.cfg.publicUrl}/download/${IPA}`)}</string></dict></array>
<key>metadata</key><dict>
<key>bundle-identifier</key><string>${esc(build.bundleId ?? "com.logisticspro.app")}</string>
<key>bundle-version</key><string>${esc(build.version ?? "1.0.0")}</string>
<key>kind</key><string>software</string>
<key>title</key><string>Logistics Pro</string>
</dict></dict></array></dict></plist>`;
  });
}
