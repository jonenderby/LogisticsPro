import { type Lang, PICKABLE_LANGUAGES } from "@logisticspro/workspace";

/** Small server-rendered pages (app download, privacy policy) that work without the website build. */

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The first language in Accept-Language that people can pick, else English. */
export function pageLanguage(header: string | undefined): Lang {
  for (const part of (header ?? "").split(",")) {
    const code = part.split(";")[0]!.trim().toLowerCase().split("-")[0];
    const found = PICKABLE_LANGUAGES.find((l) => l.code === code);
    if (found) return found.code as Lang;
  }
  return "en";
}

/** A page in the app's colors, light or dark with the phone. `body` is HTML; the title is escaped here. */
export function htmlPage(lang: Lang, title: string, body: string): string {
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#F8F9FF;--fg:#1A1C20;--muted:#5C6070;--accent:#1D5FD1;--on:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--fg:#E3E5EC;--muted:#A3A7B5;--accent:#AFC6FF;--on:#0B2A63}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:40rem;margin:0 auto;padding:2.5rem 1rem}
h1{font-size:1.5rem;margin:0 0 1.5rem}
h2{font-size:1.125rem;margin:1.75rem 0 .5rem}
a{color:var(--accent)}
.btn{display:block;max-width:28rem;text-align:center;background:var(--accent);color:var(--on);text-decoration:none;font-weight:600;padding:.9rem 1rem;border-radius:999px;margin-top:1rem}
.note{color:var(--muted);font-size:.875rem;margin:.5rem 0 0}
</style></head>
<body><main>
<h1>${esc(title)}</h1>
${body}
</main></body></html>`;
}
