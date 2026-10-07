import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

describe("phone app downloads", () => {
  it("offers the Android build from this server, and picks up a new one without a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lp-downloads-"));
    const h = await harness({ config: { downloadsDir: dir, publicUrl: "https://lp.example.com" } });
    const page = (lang?: string) => h.app.inject({ method: "GET", url: "/download", headers: lang ? { "accept-language": lang } : {} });

    let res = await page();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("No phone app has been built on this server yet.");
    expect((await h.app.inject({ method: "GET", url: "/download/logistics-pro.apk" })).statusCode).toBe(404);

    await writeFile(join(dir, "logistics-pro.apk"), Buffer.alloc(3 * 1_048_576, 1));
    await writeFile(join(dir, "build.json"), JSON.stringify({ version: "1.0.0 (29632)", builtAt: "2026-10-07T01:00:00Z" }));
    res = await page();
    expect(res.body).toContain('href="/download/logistics-pro.apk"');
    expect(res.body).toContain("Version 1.0.0 (29632)");
    expect(res.body).toContain("3 MB");
    expect(res.body).not.toContain("Install on iPhone");

    const apk = await h.app.inject({ method: "GET", url: "/download/logistics-pro.apk" });
    expect(apk.statusCode).toBe(200);
    expect(apk.headers["content-type"]).toBe("application/vnd.android.package-archive");
    expect(apk.rawPayload.length).toBe(3 * 1_048_576);

    // Spanish for phones set to Spanish.
    expect((await page("es-US,es;q=0.9,en;q=0.8")).body).toContain("Descargar para Android");
    expect((await page("fr-FR,en;q=0.5")).body).toContain("Download for Android");
  });

  it("installs an iPhone ad hoc build over the air through a manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lp-downloads-"));
    const h = await harness({ config: { downloadsDir: dir, publicUrl: "https://lp.example.com" } });
    expect((await h.app.inject({ method: "GET", url: "/download/manifest.plist" })).statusCode).toBe(404);

    await writeFile(join(dir, "logistics-pro.ipa"), "ipa");
    const page = await h.app.inject({ method: "GET", url: "/download" });
    expect(page.body).toContain(`itms-services://?action=download-manifest&amp;url=${encodeURIComponent("https://lp.example.com/download/manifest.plist")}`);
    const manifest = await h.app.inject({ method: "GET", url: "/download/manifest.plist" });
    expect(manifest.body).toContain("<string>https://lp.example.com/download/logistics-pro.ipa</string>");
    expect(manifest.body).toContain("<string>com.logisticspro.app</string>");
  });

  it("isn't there unless the server has a downloads folder", async () => {
    const h = await harness();
    expect((await h.app.inject({ method: "GET", url: "/download" })).statusCode).toBe(404);
  });
});
