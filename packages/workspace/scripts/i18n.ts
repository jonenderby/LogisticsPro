/**
 * Translation tool.
 *
 *   npm run i18n                       what each language still needs
 *   npm run i18n -- missing fr         untranslated text for French, ready to paste
 *   npm run i18n -- new fr Français French fr-CA fr-FR
 *                                      start a language: code, its own name, English name,
 *                                      voice locale, turn-by-turn locale
 *
 * Text is found by reading the code for t("...") calls, so there is no list
 * of keys to keep up to date.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as domain from "@logisticspro/domain";
import { LANGUAGES, type Lang, type LanguageInfo } from "@logisticspro/domain";
import { buildWorkspace, resolveCapabilities } from "../src/index.js";
import { DICTIONARIES, hasTranslation } from "../src/i18n.js";

export const ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

/** Screens that must be fully translated before a language ships: what drivers use, and account setup. */
export const REQUIRED_FILES = [
  "apps/mobile/src/screens/auth/AuthFlow.tsx",
  "apps/mobile/src/ui/Hos.tsx",
  "apps/mobile/src/ui/DrivingLock.tsx",
  "apps/mobile/src/ui/Documents.tsx",
  "apps/mobile/src/screens/HoursScreen.tsx",
  "apps/mobile/src/screens/SignatureScreen.tsx",
  "apps/mobile/src/screens/TodayScreen.tsx",
  "apps/mobile/src/screens/NavigateScreen.tsx",
  "apps/mobile/src/screens/MoreScreens.tsx",
  "packages/workspace/src/feed.ts",
  "apps/api/src/services/notify.ts",
];

/** Text kept in lookup tables and passed to t() by variable, which reading t("...") calls can't see. */
export const TABLE_TEXT = [
  "Off duty", "Sleeper", "On duty", "Driving",
  "until your 30-minute break", "of your 11-hour driving limit", "of your 11-hour limit", "before your 14-hour window closes", "of your weekly cycle",
  "Take a 30-minute break before driving again.", "You have used your 11 hours of driving. Take 10 hours off.", "Your 14-hour window has closed. Take 10 hours off.", "You have used your weekly hours. 34 hours off restarts them.",
  "Dispatch", "Shipping", "Brokerage", "Billing", "Messages",
  "BOL", "POD", "Lumper", "Scale", "Other",
  "Bill of lading", "Proof of delivery", "Lumper receipt", "Scale ticket", "Rate confirmation", "Permit", "Invoice", "Document",
  "Arrived at pickup", "Loaded", "Handoff complete", "Arrived at relay", "Arrived at terminal", "Arrived at delivery", "Delivered",
  "north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest",
  "Allow camera access in Settings to scan paperwork.", "Couldn't read the photo", "Couldn't read the file",
  "Trucker", "Carrier", "3PL", "Business",
  "Drive loads, update status, navigate and invoice. Register your own company later to run it from the same app.",
  "Dispatch drivers, bid on loads, plan relays and teams, and invoice customers.",
  "Post and broker loads, award bids and connect carriers.",
  "Ship freight, tender to carriers and connect your ERP.",
  "Today", "Loads", "Track", "Navigate", "Board", "Money", "More",
];

/** Every string literal in the first argument of t(...), tr(...) or tx(...), ternaries included, comparisons skipped. */
export function keysIn(source: string): string[] {
  const out: string[] = [];
  const call = /\b(?:t|tr|tx)\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(source))) {
    let i = m.index + m[0].length;
    let depth = 0;
    let arg = "";
    for (; i < source.length; i++) {
      const ch = source[i]!;
      if (ch === '"' || ch === "'" || ch === "`") {
        const end = source.indexOf(ch, i + 1);
        arg += source.slice(i, end + 1);
        i = end;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) break;
        depth--;
      }
      if (ch === "," && depth === 0) break;
      arg += ch;
    }
    for (const lit of arg.matchAll(/(===\s*|!==\s*|includes\(\s*)?"((?:[^"\\]|\\.)*)"/g)) if (!lit[1]) out.push(JSON.parse(`"${lit[2]}"`));
  }
  return out;
}

/** Tab, menu and quick-action titles for every kind of person. */
function workspaceTitles(): string[] {
  const acct = (profileType: "TRUCKER" | "CARRIER" | "BUSINESS") => ({ id: "a", email: "a@x", name: "A", profileType, passwordHash: "", mfa: { enabled: true, recoveryCodeHashes: [] }, createdAt: "" });
  const org = (kinds: Array<"CARRIER" | "SHIPPER" | "BROKER_3PL">) => ({ id: "o", name: "O", kinds, distributionCenters: [], createdAt: "" });
  return [
    resolveCapabilities({ account: acct("TRUCKER"), memberships: [{ accountId: "a", orgId: "o", roles: ["DRIVER"] }], orgs: [org(["CARRIER"])] }),
    resolveCapabilities({ account: acct("TRUCKER"), memberships: [{ accountId: "a", orgId: "o", roles: ["OWNER", "DRIVER"] }], orgs: [org(["CARRIER"])] }),
    resolveCapabilities({ account: acct("CARRIER"), memberships: [{ accountId: "a", orgId: "o", roles: ["OWNER"] }], orgs: [org(["CARRIER"])] }),
    resolveCapabilities({ account: acct("BUSINESS"), memberships: [{ accountId: "a", orgId: "o", roles: ["OWNER"] }], orgs: [org(["SHIPPER", "BROKER_3PL"])] }),
    resolveCapabilities({ account: acct("TRUCKER"), memberships: [], orgs: [] }),
  ].flatMap((c) => {
    const w = buildWorkspace(c);
    return [...w.tabs.map((t) => t.title), ...w.more.map((x) => x.title), ...w.quickActions.map((q) => q.title), ...w.loadFilters.map((f) => f.title)];
  });
}

const unique = (xs: string[]) => [...new Set(xs)];

/** The app shows code values as words: t(titleCase("DRY_VAN")) is "Dry Van". Every enum in the domain, as words. */
export function enumLabels(): string[] {
  const words = (code: string) => code.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return unique(
    (Object.values(domain) as unknown[])
      .filter((v): v is { options: string[] } => !!v && typeof v === "object" && Array.isArray((v as { options?: unknown }).options))
      .flatMap((e) => e.options.filter((o) => typeof o === "string" && /^[A-Z][A-Z0-9_]*$/.test(o) && /[A-Z]{2}/.test(o)).map(words)),
  );
}
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

/** Text that must be translated before a language ships. */
export const requiredKeys = () => unique([...REQUIRED_FILES.flatMap((f) => keysIn(read(f))), ...TABLE_TEXT, ...workspaceTitles(), "All"]);

/** All translatable text in the app and the server, required first. */
export function allKeys(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, name);
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(name)) files.push(rel);
    }
  };
  walk("apps/mobile/src");
  walk("apps/api/src");
  return unique([...requiredKeys(), ...files.flatMap((f) => keysIn(read(f))), ...enumLabels(), ...domain.RATE_CON_CHANGE_LABELS]);
}

export const missing = (lang: Lang, keys: string[]) => keys.filter((k) => !hasTranslation(lang, k));

function status() {
  const required = requiredKeys();
  const all = allKeys();
  for (const l of LANGUAGES as readonly LanguageInfo[]) {
    if (l.code === "en") continue;
    const req = missing(l.code as Lang, required);
    const rest = missing(l.code as Lang, all);
    console.log(`${l.englishName} (${l.code})${l.draft ? ", draft" : ""}: required ${required.length - req.length}/${required.length}, all text ${all.length - rest.length}/${all.length}`);
    for (const k of req.slice(0, 20)) console.log(`  missing: ${k}`);
    if (req.length > 20) console.log(`  …and ${req.length - 20} more required. Run: npm run i18n -- missing ${l.code}`);
  }
}

function printMissing(code: string) {
  if (!(code in DICTIONARIES)) throw new Error(`No dictionary for "${code}". Start one with: npm run i18n -- new ${code} …`);
  const required = new Set(requiredKeys());
  const keys = missing(code as Lang, allKeys());
  console.log(`// ${keys.filter((k) => required.has(k)).length} required, ${keys.filter((k) => !required.has(k)).length} more. Paste into packages/workspace/src/locales/${code}.ts and translate.`);
  for (const k of keys) console.log(`  ${JSON.stringify(k)}: "",${required.has(k) ? "" : " // optional"}`);
}

function create(code: string, name: string, englishName: string, speech: string, directions: string) {
  if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(code)) throw new Error(`"${code}" isn't a language code like fr or pt-BR`);
  if (!name || !englishName || !speech || !directions) throw new Error("Usage: npm run i18n -- new <code> <own name> <English name> <voice locale> <directions locale>");
  const ident = code.replace("-", "_");
  const file = `packages/workspace/src/locales/${code}.ts`;
  if (existsSync(join(ROOT, file))) throw new Error(`${file} already exists`);
  const body = allKeys().map((k) => `  ${JSON.stringify(k)}: "",`).join("\n");
  writeFileSync(join(ROOT, file), `import type { Dictionary } from "../i18n.js";\n\n/**\n * ${englishName}. Keys are the English text exactly as written in the code; {braces} are filled in at\n * runtime. An empty value shows the English until it's translated.\n */\nexport const ${ident}: Dictionary = {\n${body}\n};\n`);
  const edit = (f: string, marker: string, line: string) => {
    const s = read(f);
    if (!s.includes(marker)) throw new Error(`Marker "${marker}" not found in ${f}`);
    writeFileSync(join(ROOT, f), s.replace(marker, `${line}\n${marker.replace(/^\s*/, (w) => w)}`));
  };
  edit("packages/domain/src/languages.ts", "  // i18n:languages", `  { code: ${JSON.stringify(code)}, name: ${JSON.stringify(name)}, englishName: ${JSON.stringify(englishName)}, speech: ${JSON.stringify(speech)}, directions: ${JSON.stringify(directions)}, draft: true },`);
  edit("packages/workspace/src/i18n.ts", "// i18n:imports", `import { ${ident} } from "./locales/${code}.js";`);
  edit("packages/workspace/src/i18n.ts", "  // i18n:dictionaries", `  ${code.includes("-") ? JSON.stringify(code) : code}${code.includes("-") ? `: ${ident}` : ""},`);
  console.log(`Started ${englishName}:\n  ${relative(ROOT, join(ROOT, file))} has every text with an empty translation.\n  It's listed as a draft in packages/domain/src/languages.ts, so people can't pick it yet.\nTranslate, run "npm run i18n" until required text is complete, then remove "draft: true".`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Piping into head and the like closes stdout early; that's fine.
  process.stdout.on("error", (e: NodeJS.ErrnoException) => process.exit(e.code === "EPIPE" ? 0 : 1));
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (!cmd) status();
    else if (cmd === "missing") printMissing(args[0] ?? "");
    else if (cmd === "new") create(args[0] ?? "", args[1] ?? "", args[2] ?? "", args[3] ?? "", args[4] ?? "");
    else throw new Error(`Unknown command "${cmd}". Use: npm run i18n, npm run i18n -- missing <code>, npm run i18n -- new <code> …`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
