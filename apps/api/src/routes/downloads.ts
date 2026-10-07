import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type Lang, PICKABLE_LANGUAGES, translator } from "@logisticspro/workspace";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../http.js";

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

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The first language in Accept-Language that people can pick, else English. */
function pageLanguage(header: string | undefined): Lang {
  for (const part of (header ?? "").split(",")) {
    const code = part.split(";")[0]!.trim().toLowerCase().split("-")[0];
    const found = PICKABLE_LANGUAGES.find((l) => l.code === code);
    if (found) return found.code as Lang;
  }
  return "en";
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
    return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t("Get the Logistics Pro app"))}</title>
<style>
:root{--bg:#F8F9FF;--fg:#1A1C20;--muted:#5C6070;--accent:#1D5FD1;--on:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--fg:#E3E5EC;--muted:#A3A7B5;--accent:#AFC6FF;--on:#0B2A63}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:28rem;margin:0 auto;padding:2.5rem 1rem}
h1{font-size:1.5rem;margin:0 0 1.5rem}
.btn{display:block;text-align:center;background:var(--accent);color:var(--on);text-decoration:none;font-weight:600;padding:.9rem 1rem;border-radius:999px;margin-top:1rem}
.note{color:var(--muted);font-size:.875rem;margin:.5rem 0 0}
a.web{color:var(--accent)}
</style></head>
<body><main>
<h1>${esc(t("Get the Logistics Pro app"))}</h1>
${body}
<p class="note" style="margin-top:2rem"><a class="web" href="/">${esc(t("Or use Logistics Pro in your browser"))}</a></p>
</main></body></html>`;
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
