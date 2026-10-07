import { XMLParser } from "fast-xml-parser";

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function singular(key: string): string {
  if (key.endsWith("ies")) return `${key.slice(0, -3)}y`;
  if (key.endsWith("s") && key.length > 1) return key.slice(0, -1);
  return `${key}Item`;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function node(name: string, value: unknown, indent: string): string {
  if (!NAME.test(name)) throw new Error(`invalid XML element name "${name}"`);
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    const child = singular(name);
    const inner = value.map((v) => node(child, v, `${indent}  `)).join("");
    return inner ? `${indent}<${name}>\n${inner}${indent}</${name}>\n` : `${indent}<${name}/>\n`;
  }
  if (typeof value === "object") {
    const inner = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => node(k, v, `${indent}  `))
      .join("");
    return `${indent}<${name}>\n${inner}${indent}</${name}>\n`;
  }
  return `${indent}<${name}>${escape(String(value))}</${name}>\n`;
}

export function toXml(root: string, value: unknown): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${node(root, value, "")}`;
}

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true, processEntities: true });

/** Parse XML into plain objects, unwrapping `<stops><stop/>...</stops>` into arrays. */
export function fromXml(xml: string): { root: string; value: unknown } {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const roots = Object.keys(parsed).filter((k) => k !== "?xml");
  if (roots.length !== 1) throw new Error("XML document must have exactly one root element");
  const root = roots[0]!;
  return { root, value: unwrap(root, parsed[root]) };
}

function unwrap(name: string, v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => unwrap(name, x));
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj);
  const child = singular(name);
  if (keys.length === 1 && keys[0] === child) {
    const inner = obj[child];
    return (Array.isArray(inner) ? inner : [inner]).map((x) => unwrap(child, x));
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = unwrap(k, obj[k]);
  return out;
}
