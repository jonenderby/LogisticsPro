import { z } from "zod";

/**
 * Canonical transaction documents.
 *
 * Every integration method (API JSON, API XML, EDI X12) renders from and parses
 * back into these schemas. Because there is exactly one schema per transaction,
 * a partner on EDI and a partner on JSON are held to the same required fields.
 */

/** ISO-8601 UTC at minute precision, e.g. 2026-10-05T14:30:00Z (what X12 HHMM can carry). */
export const CanonicalTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/, "time must be UTC minute precision: YYYY-MM-DDTHH:MM:00Z");
export const CanonicalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export function toCanonicalTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) throw new Error(`invalid time: ${String(iso)}`);
  return `${d.toISOString().slice(0, 16)}:00Z`;
}
export function toCanonicalDate(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toISOString().slice(0, 10);
}

export const Party = z.object({
  name: z.string().min(1).max(60),
  line1: z.string().min(1).max(55),
  line2: z.string().max(55).optional(),
  city: z.string().min(2).max(30),
  state: z.string().min(2).max(3),
  postalCode: z.string().min(3).max(15),
  country: z.string().length(2),
  locationCode: z.string().max(80).optional(),
});
export type Party = z.infer<typeof Party>;

export const PaymentTerms = z.enum(["PREPAID", "COLLECT", "THIRD_PARTY"]);
export const Packaging = z.enum(["PLT", "CTN", "SKD", "DRM", "BDL", "PCS", "CRT"]);
export const Equipment = z.enum(["DRY_VAN", "REEFER", "FLATBED", "STEP_DECK", "LOWBOY", "CONTAINER", "POWER_ONLY"]);

export const TenderItem = z.object({
  description: z.string().min(1).max(80),
  pieces: z.number().int().positive(),
  packaging: Packaging,
  weightLb: z.number().int().positive(),
  freightClass: z.string().max(5).optional(),
  nmfc: z.string().max(16).optional(),
  hazmat: z
    .object({
      unNumber: z.string().regex(/^(UN|NA)\d{4}$/),
      hazardClass: z.string().max(4),
      packingGroup: z.enum(["I", "II", "III"]).optional(),
      emergencyPhone: z.string().min(7).max(20),
    })
    .optional(),
});

export const TenderStop = z.object({
  sequence: z.number().int().positive(),
  type: z.enum(["PICKUP", "DELIVERY"]),
  party: Party,
  windowStart: CanonicalTime,
  windowEnd: CanonicalTime,
  appointmentRef: z.string().max(30).optional(),
  contact: z.object({ name: z.string().min(1).max(60), phone: z.string().min(7).max(20) }).optional(),
});

// ---------------------------------------------------------------- 204
export const LoadTender = z.object({
  purpose: z.enum(["ORIGINAL", "CHANGE", "CANCEL"]),
  shipmentId: z.string().min(1).max(30),
  carrierScac: z.string().min(2).max(4),
  paymentTerms: PaymentTerms,
  equipmentType: Equipment,
  equipmentLengthFt: z.number().int().positive().optional(),
  service: z.enum(["STANDARD", "EXPEDITED", "TEAM_EXPEDITED"]).optional(),
  respondBy: CanonicalTime.optional(),
  references: z.object({
    bol: z.string().max(30).optional(),
    po: z.array(z.string().max(30)).optional(),
    shipperRef: z.string().max(30).optional(),
  }),
  billTo: Party,
  stops: z.array(TenderStop).min(2),
  items: z.array(TenderItem).min(1),
  totalWeightLb: z.number().int().positive(),
  totalPieces: z.number().int().positive(),
  rateUsd: z.number().nonnegative().optional(),
  oversize: z
    .object({
      lengthIn: z.number().int().positive(),
      widthIn: z.number().int().positive(),
      heightIn: z.number().int().positive(),
      grossWeightLb: z.number().int().positive(),
    })
    .optional(),
  notes: z.string().max(80).optional(),
});
export type LoadTender = z.infer<typeof LoadTender>;

// ---------------------------------------------------------------- 990
export const TenderResponse = z.object({
  shipmentId: z.string().min(1).max(30),
  carrierScac: z.string().min(2).max(4),
  decision: z.enum(["ACCEPT", "DECLINE"]),
  respondedOn: CanonicalDate,
  carrierReference: z.string().max(30).optional(),
  declineReason: z.string().max(30).optional(),
});
export type TenderResponse = z.infer<typeof TenderResponse>;

// ---------------------------------------------------------------- 214
/** Only partner-facing milestones are transmitted; relay swaps and dispatch stay internal. */
export const TransmittedStatus = z.enum([
  "ARRIVED_PICKUP",
  "LOADED",
  "IN_TRANSIT",
  "ARRIVED_TERMINAL",
  "DEPARTED_TERMINAL",
  "DELAYED",
  "ETA_UPDATE",
  "ARRIVED_DELIVERY",
  "DELIVERED",
]);
export type TransmittedStatus = z.infer<typeof TransmittedStatus>;

export const ShipmentStatus = z.object({
  shipmentId: z.string().min(1).max(30),
  carrierScac: z.string().min(2).max(4),
  statusCode: TransmittedStatus,
  reason: z.enum(["NORMAL", "WEATHER", "TRAFFIC", "MECHANICAL", "SHIPPER_DELAY", "CONSIGNEE_DELAY", "OTHER"]),
  at: CanonicalTime,
  eta: CanonicalTime.optional(),
  location: z.object({
    city: z.string().max(30).optional(),
    state: z.string().max(3).optional(),
    country: z.string().length(2).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  }),
  references: z.object({
    pro: z.string().max(30).optional(),
    bol: z.string().max(30).optional(),
    po: z.array(z.string().max(30)).optional(),
  }),
  stopSequence: z.number().int().positive().optional(),
  equipmentNumber: z.string().max(10).optional(),
});
export type ShipmentStatus = z.infer<typeof ShipmentStatus>;

// ---------------------------------------------------------------- 210
export const ChargeCode = z.enum(["LINEHAUL", "FUEL_SURCHARGE", "DETENTION", "LAYOVER", "LUMPER", "STOP_OFF", "TARP", "TEAM", "ESCORT", "PERMIT", "LIFTGATE", "OTHER"]);

export const FreightInvoice = z.object({
  invoiceNumber: z.string().min(1).max(22),
  shipmentId: z.string().min(1).max(30),
  carrierScac: z.string().min(2).max(4),
  invoiceDate: CanonicalDate,
  paymentTerms: PaymentTerms,
  currency: z.string().length(3),
  totalAmount: z.number().nonnegative(),
  billTo: Party,
  shipper: Party,
  consignee: Party,
  references: z.object({
    bol: z.string().max(30).optional(),
    po: z.array(z.string().max(30)).optional(),
    pro: z.string().max(30).optional(),
  }),
  pickupDate: CanonicalDate,
  deliveryDate: CanonicalDate,
  weightLb: z.number().int().positive(),
  pieces: z.number().int().positive(),
  lines: z
    .array(
      z.object({
        code: ChargeCode,
        description: z.string().min(1).max(30),
        quantity: z.number().positive(),
        rate: z.number().nonnegative(),
        amount: z.number().nonnegative(),
      }),
    )
    .min(1),
});
export type FreightInvoice = z.infer<typeof FreightInvoice>;

// ---------------------------------------------------------------- 820
/** Remittance advice: a payment and the invoices it pays. */
export const PaymentAdvice = z.object({
  /** The payment's trace or check number. */
  paymentRef: z.string().min(1).max(30),
  paymentDate: CanonicalDate,
  method: z.enum(["ACH", "CHECK", "WIRE", "OTHER"]),
  currency: z.string().length(3),
  totalAmount: z.number().positive(),
  payerName: z.string().min(1).max(60),
  payeeName: z.string().min(1).max(60),
  payeeScac: z.string().min(2).max(4).optional(),
  invoices: z
    .array(
      z.object({
        invoiceNumber: z.string().min(1).max(30),
        amountPaid: z.number().nonnegative(),
        amountInvoiced: z.number().nonnegative().optional(),
        /** Taken off the invoice (a discount or a short pay). */
        adjustment: z.number().optional(),
      }),
    )
    .min(1),
});
export type PaymentAdvice = z.infer<typeof PaymentAdvice>;

// ---------------------------------------------------------------- API-only
export const RateQuoteRequest = z.object({
  quoteRef: z.string().min(1).max(30),
  originPostal: z.string().min(3),
  originCountry: z.string().length(2),
  destinationPostal: z.string().min(3),
  destinationCountry: z.string().length(2),
  pickupDate: CanonicalDate,
  items: z.array(
    z.object({
      pieces: z.number().int().positive(),
      packaging: Packaging,
      weightLb: z.number().int().positive(),
      freightClass: z.string().max(5),
      lengthIn: z.number().positive().optional(),
      widthIn: z.number().positive().optional(),
      heightIn: z.number().positive().optional(),
    }),
  ).min(1),
  accessorials: z.array(z.string()).optional(),
});
export type RateQuoteRequest = z.infer<typeof RateQuoteRequest>;

export const PickupRequest = z.object({
  pickupRef: z.string().min(1).max(30),
  shipmentId: z.string().min(1).max(30),
  pickupParty: Party,
  windowStart: CanonicalTime,
  windowEnd: CanonicalTime,
  contact: z.object({ name: z.string().min(1), phone: z.string().min(7) }),
  destinationPostal: z.string().min(3),
  totalWeightLb: z.number().int().positive(),
  totalPieces: z.number().int().positive(),
  hazmat: z.boolean(),
  notes: z.string().max(80).optional(),
});
export type PickupRequest = z.infer<typeof PickupRequest>;

// ---------------------------------------------------------------- registry
export const TransactionType = z.enum(["LOAD_TENDER", "TENDER_RESPONSE", "SHIPMENT_STATUS", "FREIGHT_INVOICE", "PAYMENT_ADVICE", "RATE_QUOTE", "PICKUP_REQUEST"]);
export type TransactionType = z.infer<typeof TransactionType>;

export interface TransactionDefinition {
  type: TransactionType;
  title: string;
  schema: z.ZodType;
  /** X12 transaction set, when one exists. */
  x12?: { set: "204" | "990" | "214" | "210" | "820"; functionalId: "SM" | "GF" | "QM" | "IM" | "RA" };
}

export const TRANSACTIONS: Record<TransactionType, TransactionDefinition> = {
  LOAD_TENDER: { type: "LOAD_TENDER", title: "Motor carrier load tender", schema: LoadTender, x12: { set: "204", functionalId: "SM" } },
  TENDER_RESPONSE: { type: "TENDER_RESPONSE", title: "Response to a load tender", schema: TenderResponse, x12: { set: "990", functionalId: "GF" } },
  SHIPMENT_STATUS: { type: "SHIPMENT_STATUS", title: "Shipment status", schema: ShipmentStatus, x12: { set: "214", functionalId: "QM" } },
  FREIGHT_INVOICE: { type: "FREIGHT_INVOICE", title: "Freight invoice", schema: FreightInvoice, x12: { set: "210", functionalId: "IM" } },
  PAYMENT_ADVICE: { type: "PAYMENT_ADVICE", title: "Payment and remittance advice", schema: PaymentAdvice, x12: { set: "820", functionalId: "RA" } },
  RATE_QUOTE: { type: "RATE_QUOTE", title: "LTL rate quote request", schema: RateQuoteRequest },
  PICKUP_REQUEST: { type: "PICKUP_REQUEST", title: "Pickup request", schema: PickupRequest },
};

export type CanonicalDoc<T extends TransactionType> = T extends "LOAD_TENDER"
  ? LoadTender
  : T extends "TENDER_RESPONSE"
    ? TenderResponse
    : T extends "SHIPMENT_STATUS"
      ? ShipmentStatus
      : T extends "FREIGHT_INVOICE"
        ? FreightInvoice
        : T extends "PAYMENT_ADVICE"
          ? PaymentAdvice
        : T extends "RATE_QUOTE"
          ? RateQuoteRequest
          : PickupRequest;

export class ValidationError extends Error {
  constructor(
    public readonly transaction: TransactionType,
    public readonly issues: Array<{ path: string; message: string }>,
  ) {
    super(`${transaction} failed validation: ${issues.map((i) => `${i.path || "(root)"} ${i.message}`).join("; ")}`);
    this.name = "ValidationError";
  }
}

export function validateDoc<T extends TransactionType>(type: T, doc: unknown): CanonicalDoc<T> {
  const res = TRANSACTIONS[type].schema.safeParse(doc);
  if (!res.success) {
    throw new ValidationError(
      type,
      res.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return res.data as CanonicalDoc<T>;
}

// ---------------------------------------------------------------- schema introspection
type AnyDef = { type: string; [k: string]: unknown };
const defOf = (s: z.ZodType): AnyDef => (s as unknown as { def: AnyDef }).def;

/**
 * Leaf field paths of a transaction (arrays shown as `stops[].party.city`),
 * split into required and optional. A field nested under an optional parent is
 * listed as optional.
 */
export function fieldPaths(type: TransactionType): { required: string[]; optional: string[] } {
  const required: string[] = [];
  const optional: string[] = [];
  const walk = (schema: z.ZodType, path: string, parentOptional: boolean) => {
    const def = defOf(schema);
    if (def.type === "optional" || def.type === "default") {
      walk(def.innerType as z.ZodType, path, true);
      return;
    }
    if (def.type === "object") {
      const shape = (schema as unknown as { shape: Record<string, z.ZodType> }).shape;
      for (const [k, v] of Object.entries(shape)) walk(v, path ? `${path}.${k}` : k, parentOptional);
      return;
    }
    if (def.type === "array") {
      const el = def.element as z.ZodType;
      const elDef = defOf(el);
      if (elDef.type === "object") walk(el, `${path}[]`, parentOptional);
      else (parentOptional ? optional : required).push(`${path}[]`);
      return;
    }
    (parentOptional ? optional : required).push(path);
  };
  walk(TRANSACTIONS[type].schema, "", false);
  return { required, optional };
}
