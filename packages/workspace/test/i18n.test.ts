import { describe, expect, it } from "vitest";
import { LANGUAGES, type Lang, type LanguageInfo } from "@logisticspro/domain";
import { DICTIONARIES, PICKABLE_LANGUAGES, translate } from "../src/index.js";
import { allKeys, missing, requiredKeys } from "../scripts/i18n.js";

const finished = (LANGUAGES as readonly LanguageInfo[]).filter((l) => l.code !== "en" && !l.draft);

describe("languages", () => {
  it.each(finished.map((l) => [l.englishName, l.code]))("%s has every driver and setup screen translated", (_name, code) => {
    const keys = requiredKeys();
    expect(keys.length).toBeGreaterThan(200);
    expect(missing(code as Lang, keys)).toEqual([]);
  });

  it("has a dictionary for every language, and only finished languages can be picked", () => {
    for (const l of LANGUAGES) if (l.code !== "en") expect(DICTIONARIES[l.code as Exclude<Lang, "en">]).toBeDefined();
    expect(PICKABLE_LANGUAGES.every((l) => !l.draft)).toBe(true);
    expect(PICKABLE_LANGUAGES[0]!.code).toBe("en");
  });

  it("finds text across the whole app", () => {
    const all = allKeys();
    expect(all).toEqual(expect.arrayContaining(["Insights", "Arrived at pickup", "Sign in"]));
    expect(all.length).toBeGreaterThan(requiredKeys().length);
  });

  it("fills in values and falls back to English", () => {
    expect(translate("es", "Next load {n}", { n: "LP-1001" })).toBe("Siguiente carga LP-1001");
    expect(translate("en", "Next load {n}", { n: "LP-1001" })).toBe("Next load LP-1001");
    expect(translate(undefined, "Next load {n}", { n: "LP-1001" })).toBe("Next load LP-1001");
    expect(translate("es", "Something new")).toBe("Something new");
  });
});
