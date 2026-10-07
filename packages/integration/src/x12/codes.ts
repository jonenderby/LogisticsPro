import { X12ParseError } from "./core.js";

/**
 * Default code tables used by the Logistics Pro X12 4010 maps. Trading
 * partners publish their own implementation guides, so every table can be
 * overridden per partner profile (see PartnerProfile.edi.codeOverrides).
 */
export const DEFAULT_CODES = {
  payment: { PREPAID: "PP", COLLECT: "CC", THIRD_PARTY: "TP" },
  purpose: { ORIGINAL: "00", CANCEL: "01", CHANGE: "04" },
  /** N711 equipment description codes. */
  equipment: { DRY_VAN: "TV", REEFER: "RT", FLATBED: "FT", STEP_DECK: "SD", LOWBOY: "LB", CONTAINER: "CN", POWER_ONLY: "PO" },
  /** AT701 shipment status codes. */
  status: {
    ARRIVED_PICKUP: "X3",
    LOADED: "AF",
    IN_TRANSIT: "X6",
    ARRIVED_TERMINAL: "X4",
    DEPARTED_TERMINAL: "P1",
    DELAYED: "SD",
    ETA_UPDATE: "AG",
    ARRIVED_DELIVERY: "X1",
    DELIVERED: "D1",
  },
  /** AT702 status reason codes. */
  reason: { NORMAL: "NS", WEATHER: "AO", TRAFFIC: "AS", MECHANICAL: "AI", SHIPPER_DELAY: "AM", CONSIGNEE_DELAY: "AN", OTHER: "BG" },
  /** 210 L108 special charge codes. */
  charge: {
    LINEHAUL: "400",
    FUEL_SURCHARGE: "FUE",
    DETENTION: "DET",
    LAYOVER: "LAY",
    LUMPER: "LMP",
    STOP_OFF: "SOC",
    TARP: "TRP",
    TEAM: "TMS",
    ESCORT: "ESC",
    PERMIT: "PMT",
    LIFTGATE: "LFT",
    OTHER: "MSC",
  },
} as const;

export type CodeTables = { [K in keyof typeof DEFAULT_CODES]: Record<keyof (typeof DEFAULT_CODES)[K], string> };
export type CodeOverrides = { [K in keyof CodeTables]?: Partial<CodeTables[K]> };

export function resolveCodes(overrides: CodeOverrides = {}): CodeTables {
  const out = {} as Record<string, Record<string, string>>;
  for (const [table, defaults] of Object.entries(DEFAULT_CODES)) {
    const merged = { ...defaults, ...((overrides as Record<string, Record<string, string>>)[table] ?? {}) };
    const values = Object.values(merged);
    if (new Set(values).size !== values.length) throw new Error(`EDI code table "${table}" maps two values to the same code`);
    out[table] = merged;
  }
  return out as CodeTables;
}

export function encodeCode<T extends Record<string, string>>(table: T, key: keyof T, what: string): string {
  const v = table[key];
  if (!v) throw new Error(`no X12 ${what} code for ${String(key)}`);
  return v;
}

export function decodeCode<T extends Record<string, string>>(table: T, code: string, what: string): keyof T {
  const hit = Object.entries(table).find(([, v]) => v === code);
  if (!hit) throw new X12ParseError(`unknown ${what} code "${code}"`);
  return hit[0] as keyof T;
}
