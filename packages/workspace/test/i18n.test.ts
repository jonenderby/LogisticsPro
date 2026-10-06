import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspace, hasSpanish, langOf, resolveCapabilities, translate } from "../src/index.js";

const ROOT = resolve(__dirname, "../../..");

/** Every string literal inside the first argument of t(...) or tr(...), ternaries included. */
function keysIn(source: string): string[] {
  const out: string[] = [];
  const call = /\b(?:t|tr)\(/g;
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
    // Literals compared against (=== "SHIFT", .includes("ESCORT")) are conditions, not text.
    for (const lit of arg.matchAll(/(===\s*|!==\s*|includes\(\s*)?"((?:[^"\\]|\\.)*)"/g)) if (!lit[1]) out.push(JSON.parse(`"${lit[2]}"`));
  }
  return out;
}

// The screens drivers use; each must be fully translated.
const DRIVER_FILES = [
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

// Labels kept in lookup tables and passed to t() by variable.
const TABLE_VALUES = [
  "Off duty", "Sleeper", "On duty", "Driving",
  "until your 30-minute break", "of your 11-hour driving limit", "of your 11-hour limit", "before your 14-hour window closes", "of your weekly cycle",
  "Take a 30-minute break before driving again.", "You have used your 11 hours of driving. Take 10 hours off.", "Your 14-hour window has closed. Take 10 hours off.", "You have used your weekly hours. 34 hours off restarts them.",
  "Dispatch", "Shipping", "Brokerage", "Billing", "Messages",
  "BOL", "POD", "Lumper", "Scale", "Other",
  "Bill of lading", "Proof of delivery", "Lumper receipt", "Scale ticket", "Rate confirmation", "Permit", "Invoice", "Document",
  "Arrived at pickup", "Loaded", "Handoff complete", "Arrived at relay", "Arrived at terminal", "Arrived at delivery", "Delivered",
  "north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest",
  "Allow camera access in Settings to scan paperwork.", "Couldn't read the photo", "Couldn't read the file",
  "Today", "Loads", "Track", "Navigate", "Board", "Money", "Business", "More", "Trucker", "Carrier",
];

describe("Spanish", () => {
  it("translates every string on the driver screens, the feed and driver pushes", () => {
    const keys = new Set([...DRIVER_FILES.flatMap((f) => keysIn(readFileSync(resolve(ROOT, f), "utf8"))), ...TABLE_VALUES]);
    expect(keys.size).toBeGreaterThan(150);
    expect([...keys].filter((k) => !hasSpanish(k))).toEqual([]);
  });

  it("translates the tabs and menus for every kind of person", () => {
    const acct = (profileType: "TRUCKER" | "CARRIER" | "BUSINESS") => ({ id: "a", email: "a@x", name: "A", profileType, passwordHash: "", mfa: { enabled: true, recoveryCodeHashes: [] }, createdAt: "" });
    const org = (kinds: Array<"CARRIER" | "SHIPPER" | "BROKER_3PL">) => ({ id: "o", name: "O", kinds, distributionCenters: [], createdAt: "" });
    const shapes = [
      resolveCapabilities({ account: acct("TRUCKER"), memberships: [{ accountId: "a", orgId: "o", roles: ["DRIVER"] }], orgs: [org(["CARRIER"])] }),
      resolveCapabilities({ account: acct("TRUCKER"), memberships: [{ accountId: "a", orgId: "o", roles: ["OWNER", "DRIVER"] }], orgs: [org(["CARRIER"])] }),
      resolveCapabilities({ account: acct("BUSINESS"), memberships: [{ accountId: "a", orgId: "o", roles: ["OWNER"] }], orgs: [org(["SHIPPER", "BROKER_3PL"])] }),
      resolveCapabilities({ account: acct("TRUCKER"), memberships: [], orgs: [] }),
    ];
    const titles = shapes.flatMap((c) => {
      const w = buildWorkspace(c);
      return [...w.tabs.map((t) => t.title), ...w.more.map((m) => m.title), ...w.quickActions.map((q) => q.title)];
    });
    expect([...new Set(titles)].filter((k) => !hasSpanish(k))).toEqual([]);
  });

  it("fills in values and falls back to English", () => {
    expect(translate("es", "Next load {n}", { n: "LP-1001" })).toBe("Siguiente carga LP-1001");
    expect(translate("en", "Next load {n}", { n: "LP-1001" })).toBe("Next load LP-1001");
    expect(translate("es", "Something new")).toBe("Something new");
    expect(langOf("es-MX")).toBe("es");
    expect(langOf("en-US")).toBe("en");
  });
});
