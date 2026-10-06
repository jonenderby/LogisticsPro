import { DEFAULT_LANG, LANGUAGES, type Lang, PICKABLE_LANGUAGES, languageInfo } from "@logisticspro/domain";
// i18n:imports (npm run i18n -- new adds lines here)
import { es } from "./locales/es.js";

/**
 * Translations. English is the source text and the default everywhere, so
 * code stays readable and anything not yet translated shows in English.
 * Values in braces are filled in: t("Next load {n}", { n: "LP-1001" }).
 *
 * Languages are listed in packages/domain/src/languages.ts; each one other
 * than English has a dictionary in ./locales/. `npm run i18n` shows what
 * each language still needs. See docs/LANGUAGES.md.
 */
export { DEFAULT_LANG, LANGUAGES, type Lang, PICKABLE_LANGUAGES, languageInfo };

/** English text to its translation. An empty string means not translated yet. */
export type Dictionary = Record<string, string>;

/** One dictionary per language other than English; a language without one won't compile. */
export const DICTIONARIES: Record<Exclude<Lang, "en">, Dictionary> = {
  es,
  // i18n:dictionaries
};

export type Params = Record<string, string | number | undefined>;
export type Translate = (text: string, params?: Params) => string;

const dictionaryFor = (lang?: Lang): Dictionary | undefined => (lang && lang !== "en" ? DICTIONARIES[lang] : undefined);

export function translate(lang: Lang | undefined, text: string, params?: Params): string {
  const base = dictionaryFor(lang)?.[text] || text;
  return params ? base.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] !== undefined ? String(params[k]) : m)) : base;
}

export const translator = (lang?: Lang): Translate => (text, params) => translate(lang, text, params);

/** Is this text translated into `lang`? English always is. */
export function hasTranslation(lang: Lang, text: string): boolean {
  if (lang === "en") return true;
  return !!dictionaryFor(lang)?.[text];
}
