import type { z } from "zod";
import { type TransactionType, fieldPaths } from "./transactions.js";

/**
 * Field maps let a partner receive (or send) its own payload shape:
 * `{ "shipment.bolNumber": "references.bol", "stops[].zip": "stops[].party.postalCode" }`
 * Keys are partner paths, values are canonical paths. One `[]` level is supported.
 */
export type FieldMap = Record<string, string>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  if (value === undefined) return;
  const keys = path.split(".");
  let cur = obj;
  keys.slice(0, -1).forEach((k) => {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  });
  cur[keys[keys.length - 1]!] = value;
}

function splitArray(path: string): [string, string] | undefined {
  const i = path.indexOf("[]");
  if (i < 0) return undefined;
  const rest = path.slice(i + 2).replace(/^\./, "");
  if (rest.includes("[]")) throw new Error(`field map path "${path}" nests arrays; only one [] level is supported`);
  return [path.slice(0, i), rest];
}

function moveValue(from: unknown, fromPath: string, to: Record<string, unknown>, toPath: string): void {
  const fa = splitArray(fromPath);
  const ta = splitArray(toPath);
  if (!fa && !ta) {
    setPath(to, toPath, structuredCloneSafe(getPath(from, fromPath)));
    return;
  }
  if (!fa || !ta) throw new Error(`field map "${toPath}" <- "${fromPath}": both sides need [] or neither`);
  const src = getPath(from, fa[0]);
  if (!Array.isArray(src)) return;
  let dest = getPath(to, ta[0]);
  if (!Array.isArray(dest)) {
    dest = src.map(() => ({}));
    setPath(to, ta[0], dest);
  }
  src.forEach((el, i) => {
    const arr = dest as unknown[];
    const v = fa[1] ? getPath(el, fa[1]) : el;
    if (v === undefined) return;
    if (!ta[1]) {
      arr[i] = structuredCloneSafe(v);
      return;
    }
    if (!isObj(arr[i])) arr[i] = {};
    setPath(arr[i] as Record<string, unknown>, ta[1], structuredCloneSafe(v));
  });
}

const structuredCloneSafe = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** canonical -> partner shape */
export function applyFieldMap(doc: unknown, map: FieldMap | undefined): unknown {
  if (!map || Object.keys(map).length === 0) return doc;
  const out: Record<string, unknown> = {};
  for (const [partnerPath, canonicalPath] of Object.entries(map)) moveValue(doc, canonicalPath, out, partnerPath);
  return out;
}

/** partner shape -> canonical */
export function reverseFieldMap(payload: unknown, map: FieldMap | undefined): unknown {
  if (!map || Object.keys(map).length === 0) return payload;
  const out: Record<string, unknown> = {};
  for (const [partnerPath, canonicalPath] of Object.entries(map)) moveValue(payload, partnerPath, out, canonicalPath);
  return out;
}

export interface FieldMapCoverage {
  missingRequired: string[];
  droppedOptional: string[];
}

/** A field map must carry every required canonical field, so no partner gets less than another. */
export function fieldMapCoverage(type: TransactionType, map: FieldMap | undefined): FieldMapCoverage {
  const { required, optional } = fieldPaths(type);
  if (!map || Object.keys(map).length === 0) return { missingRequired: [], droppedOptional: [] };
  const sources = Object.values(map);
  const covered = (p: string) => sources.some((s) => s === p || p.startsWith(`${s}.`) || p.startsWith(`${s}[]`));
  return { missingRequired: required.filter((p) => !covered(p)), droppedOptional: optional.filter((p) => !covered(p)) };
}

// ------------------------------------------------------------------ coercion
type AnyDef = { type: string; [k: string]: unknown };
const defOf = (s: z.ZodType): AnyDef => (s as unknown as { def: AnyDef }).def;

/**
 * Coerce loosely-typed input (XML text nodes, string numbers, single elements
 * where arrays are expected) into the shape a canonical schema expects.
 * Validation still happens afterwards; this only fixes representation.
 */
export function coerceToSchema(value: unknown, schema: z.ZodType): unknown {
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
    case "default":
    case "nullable":
      if (value === undefined || value === null || value === "") return undefined;
      return coerceToSchema(value, def.innerType as z.ZodType);
    case "object": {
      if (!isObj(value)) return value;
      const shape = (schema as unknown as { shape: Record<string, z.ZodType> }).shape;
      const out: Record<string, unknown> = {};
      for (const [k, s] of Object.entries(shape)) {
        const v = coerceToSchema(value[k], s);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    case "array": {
      if (value === undefined || value === "") return value === "" ? [] : undefined;
      const arr = Array.isArray(value) ? value : [value];
      return arr.map((x) => coerceToSchema(x, def.element as z.ZodType));
    }
    case "number":
      return typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)) ? Number(value) : value;
    case "boolean":
      return value === "true" ? true : value === "false" ? false : value;
    case "string":
    case "enum":
      return typeof value === "number" || typeof value === "boolean" ? String(value) : value;
    default:
      return value;
  }
}
