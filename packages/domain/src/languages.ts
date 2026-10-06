import { z } from "zod";

/**
 * Every language the app speaks. English is the default and the source
 * text; each other language has a dictionary in
 * packages/workspace/src/locales/. See docs/LANGUAGES.md to add one.
 */
export interface LanguageInfo {
  code: string;
  /** The language's name in itself, as people pick it ("Español"). */
  name: string;
  englishName: string;
  /** Voice for the spoken read-out in driving mode. */
  speech: string;
  /** Locale for turn-by-turn instructions from the routing server. */
  directions: string;
  /** Still being translated: hidden from the language pickers and not held to the completeness test. */
  draft?: boolean;
}

export const LANGUAGES = [
  { code: "en", name: "English", englishName: "English", speech: "en-US", directions: "en-US" },
  { code: "es", name: "Español", englishName: "Spanish", speech: "es-US", directions: "es-ES" },
  // i18n:languages (npm run i18n -- new adds lines here)
] as const satisfies readonly LanguageInfo[];

export type Lang = (typeof LANGUAGES)[number]["code"];
export const DEFAULT_LANG: Lang = "en";
export const Language = z.enum(LANGUAGES.map((l) => l.code) as [Lang, ...Lang[]]);

/** The languages people can pick (finished ones). */
export const PICKABLE_LANGUAGES: readonly LanguageInfo[] = LANGUAGES.filter((l: LanguageInfo) => !l.draft);

export const languageInfo = (code?: string): LanguageInfo => LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
