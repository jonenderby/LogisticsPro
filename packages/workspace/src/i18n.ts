import { ES } from "./i18n.es.js";

/**
 * Translations. English text is the key, so code stays readable and a
 * missing translation falls back to English rather than to a code. Values
 * in braces are filled in: t("Next load {n}", { n: "LP-1001" }).
 *
 * English is the default everywhere. People choose Spanish when they set
 * up their account, or later under More > Language.
 *
 * Spanish covers what drivers see first: the Today feed, load status
 * buttons, hours of service, driving mode, documents, the delivery
 * signature, navigation and the push notifications drivers get.
 */
export type Lang = "en" | "es";
export const LANGUAGES: Array<{ code: Lang; name: string }> = [
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
];

export type Params = Record<string, string | number | undefined>;
export type Translate = (text: string, params?: Params) => string;

export function translate(lang: Lang | undefined, text: string, params?: Params): string {
  const base = lang === "es" ? (ES[text] ?? text) : text;
  return params ? base.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] !== undefined ? String(params[k]) : m)) : base;
}

export const translator = (lang?: Lang): Translate => (text, params) => translate(lang, text, params);

/** Is there a Spanish version of this text? (For the completeness test.) */
export const hasSpanish = (text: string) => Object.prototype.hasOwnProperty.call(ES, text);
