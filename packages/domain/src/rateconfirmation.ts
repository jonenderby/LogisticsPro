import { z } from "zod";
import { Address, Money, TimeWindow } from "./common.js";
import { type DetentionTerms } from "./detention.js";
import { type Load, totalPieces, totalWeightLb } from "./load.js";

/**
 * A rate confirmation: the agreement between the party tendering a load and
 * the carrier hauling it. Logistics Pro writes one when the carrier accepts
 * the tender, signed by both sides (the tender is the shipper's or broker's
 * signature, the acceptance is the carrier's). When the shipper changes the
 * load after that, a new version replaces it and waits for the carrier to
 * sign again.
 */

export const RateConParty = z.object({
  orgId: z.string().optional(),
  /** For a carrier reached through a partner profile instead of the platform. */
  partnerKey: z.string().optional(),
  name: z.string(),
  scac: z.string().optional(),
  mcNumber: z.string().optional(),
  dotNumber: z.string().optional(),
});
export type RateConParty = z.infer<typeof RateConParty>;

export const RateConSignature = z.object({
  side: z.enum(["TENDERING", "CARRIER"]),
  name: z.string(),
  accountId: z.string().optional(),
  at: z.string(),
  /** How the party signed: tendering, accepting in the app, an EDI 990 or API response, or signing a revised version. */
  method: z.enum(["TENDER", "ACCEPTANCE", "PARTNER_RESPONSE", "SIGNED"]),
});
export type RateConSignature = z.infer<typeof RateConSignature>;

export const PaymentTermsSummary = z.object({
  days: z.number().int().nonnegative(),
  quickPay: z.object({ days: z.number().int().nonnegative(), feePct: z.number().nonnegative() }).optional(),
});
export type PaymentTermsSummary = z.infer<typeof PaymentTermsSummary>;

export const RateConfirmation = z.object({
  id: z.string(),
  loadId: z.string(),
  loadNumber: z.string(),
  version: z.number().int().positive(),
  /** VOID: the carrier was released or the load cancelled. */
  status: z.enum(["SIGNED", "AWAITING_CARRIER", "SUPERSEDED", "VOID"]),
  tendering: RateConParty,
  carrier: RateConParty,
  stops: z.array(z.object({ sequence: z.number(), type: z.string(), address: Address, window: TimeWindow, appointmentRef: z.string().optional() })),
  equipment: z.string(),
  service: z.string(),
  teamRequired: z.boolean(),
  commodity: z.object({ description: z.string(), pieces: z.number(), weightLb: z.number(), hazmat: z.boolean() }),
  references: z.object({ bol: z.string().optional(), po: z.array(z.string()), pro: z.string().optional() }),
  rate: Money,
  accessorials: z.array(z.string()),
  detention: z.object({ freeHours: z.number(), ratePerHour: z.number() }),
  payment: PaymentTermsSummary,
  terms: z.array(z.string()),
  notes: z.string().optional(),
  /** SHA-256 of everything above: what both parties signed. */
  hash: z.string(),
  signatures: z.array(RateConSignature),
  /** What changed from the previous version. */
  changes: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type RateConfirmation = z.infer<typeof RateConfirmation>;

/** The standard clauses on every rate confirmation. */
export const STANDARD_TERMS = [
  "The carrier hauls this load with its own trucks and drivers. It may not broker, re-tender, co-broker or assign this load to anyone else.",
  "The carrier keeps location sharing on from dispatch to delivery through the Logistics Pro app or a connected ELD.",
  "Detention, layover and lumper charges need a timestamped record or receipt.",
  "Payment goes only to the remit-to on file in Logistics Pro. A change to the remit-to is confirmed with two-factor authentication and every customer is told.",
  "The carrier keeps auto liability and cargo insurance in force at least at the amounts filed with FMCSA.",
];

export interface RateConInput {
  id: string;
  version: number;
  tendering: RateConParty;
  carrier: RateConParty;
  detention: DetentionTerms;
  payment: PaymentTermsSummary;
  signatures: RateConSignature[];
  changes?: string[];
  status: RateConfirmation["status"];
  now: string;
}

/** The signed content of a rate confirmation (everything but the hash, signatures and status). */
export type RateConContent = Omit<RateConfirmation, "hash" | "signatures" | "status" | "id" | "createdAt" | "changes">;

export function rateConContent(load: Load, input: Pick<RateConInput, "version" | "tendering" | "carrier" | "detention" | "payment">): RateConContent {
  const stops = [...load.stops].sort((a, b) => a.sequence - b.sequence);
  return {
    loadId: load.id,
    loadNumber: load.loadNumber,
    version: input.version,
    tendering: input.tendering,
    carrier: input.carrier,
    stops: stops.map((s) => ({ sequence: s.sequence, type: s.type, address: s.address, window: s.window, appointmentRef: s.appointmentRef })),
    equipment: `${load.equipment.type.charAt(0)}${load.equipment.type.slice(1).toLowerCase().replace(/_/g, " ")} ${load.equipment.lengthFt}'${load.equipment.tempMinF !== undefined ? `, ${load.equipment.tempMinF}–${load.equipment.tempMaxF ?? load.equipment.tempMinF}°F` : ""}`,
    service: load.service,
    teamRequired: load.teamRequired,
    commodity: {
      description: [...new Set(load.items.map((i) => i.description))].join(", "),
      pieces: totalPieces(load),
      weightLb: totalWeightLb(load),
      hazmat: load.items.some((i) => !!i.hazmat),
    },
    references: { bol: load.references.bol, po: load.references.po, pro: load.references.pro },
    rate: load.rate ?? { amount: 0, currency: "USD" },
    accessorials: load.accessorials,
    detention: { freeHours: input.detention.freeHours, ratePerHour: input.detention.ratePerHour },
    payment: input.payment,
    terms: STANDARD_TERMS,
    notes: load.notes,
  };
}

/** Stable JSON (sorted keys) so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const LABELS: Array<[keyof RateConContent, string]> = [
  ["stops", "Stops or appointment times"],
  ["equipment", "Equipment"],
  ["service", "Service"],
  ["teamRequired", "Team requirement"],
  ["commodity", "Freight"],
  ["references", "References"],
  ["rate", "Rate"],
  ["accessorials", "Accessorials"],
  ["detention", "Detention terms"],
  ["payment", "Payment terms"],
  ["notes", "Notes"],
];

/** What a new version changes from the last one, in words. Empty when nothing the carrier agreed to has changed. */
export function rateConChanges(prev: RateConContent, next: RateConContent): string[] {
  return LABELS.filter(([k]) => canonicalJson(prev[k]) !== canonicalJson(next[k])).map(([, label]) => label);
}

/** Days between issue and due for a payment-terms string such as "NET30" or "QUICKPAY2". */
export function termsDays(terms: string): number {
  const m = /(\d+)/.exec(terms);
  return m ? Number(m[1]) : 30;
}
