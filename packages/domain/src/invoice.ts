import { z } from "zod";
import { Address, DomainError, newId } from "./common.js";
import { InvoiceHistoryEntry, Payment, QuickPay, RemitTo } from "./payments.js";
import { type Load, finalDeliveryStop, pickupStop, totalPieces, totalWeightLb } from "./load.js";

export const ChargeCode = z.enum([
  "LINEHAUL",
  "FUEL_SURCHARGE",
  "DETENTION",
  "LAYOVER",
  "LUMPER",
  "STOP_OFF",
  "TARP",
  "TEAM",
  "ESCORT",
  "PERMIT",
  "LIFTGATE",
  "OTHER",
]);
export type ChargeCode = z.infer<typeof ChargeCode>;

export const InvoiceLine = z.object({
  code: ChargeCode,
  description: z.string(),
  quantity: z.number().positive().default(1),
  rate: z.number().nonnegative(),
  amount: z.number().nonnegative(),
});
export type InvoiceLine = z.infer<typeof InvoiceLine>;

export const InvoiceStatus = z.enum(["DRAFT", "SENT", "ACKNOWLEDGED", "APPROVED", "PARTIALLY_PAID", "PAID", "DISPUTED", "REJECTED"]);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

export const Invoice = z.object({
  id: z.string(),
  invoiceNumber: z.string(),
  loadId: z.string(),
  loadNumber: z.string(),
  carrierOrgId: z.string(),
  carrierScac: z.string().optional(),
  billTo: z.object({ orgId: z.string().optional(), partnerKey: z.string().optional(), address: Address }),
  shipper: Address,
  consignee: Address,
  references: z.object({ bol: z.string().optional(), po: z.array(z.string()).default([]), pro: z.string().optional() }),
  pickupDate: z.string(),
  deliveryDate: z.string(),
  weightLb: z.number().positive(),
  pieces: z.number().int().positive(),
  currency: z.string().length(3).default("USD"),
  lines: z.array(InvoiceLine).min(1),
  total: z.number().nonnegative(),
  terms: z.string().default("NET30"),
  issuedAt: z.string(),
  status: InvoiceStatus,
  createdByAccountId: z.string(),
  /** Days from the invoice date to due, from the payer's terms. */
  termsDays: z.number().int().optional(),
  /** Who gets the money: the carrier, or its factoring company. Fixed when the invoice is issued. */
  remitTo: RemitTo.optional(),
  quickPay: QuickPay.optional(),
  payments: z.array(Payment).optional(),
  history: z.array(InvoiceHistoryEntry).optional(),
  disputeReason: z.string().optional(),
  /** Load documents sent with the invoice (BOL, POD, receipts). */
  documentIds: z.array(z.string()).optional(),
});
export type Invoice = z.infer<typeof Invoice>;

export interface InvoiceInput {
  lines?: Array<Omit<InvoiceLine, "amount"> & { amount?: number }>;
  fuelSurchargePct?: number;
  invoiceNumber?: string;
  terms?: string;
  partnerKey?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Build a carrier invoice from a delivered load. Linehaul comes from the agreed rate. */
export function buildInvoice(load: Load, carrier: { orgId: string; scac?: string }, accountId: string, input: InvoiceInput = {}, now = new Date().toISOString()): Invoice {
  if (!load.deliveredAt) throw new DomainError("NOT_DELIVERED", "Invoice after delivery is reported", 409);
  if (load.status === "INVOICED") throw new DomainError("ALREADY_INVOICED", "Load is already invoiced", 409);
  const lines: InvoiceLine[] = (input.lines ?? []).map((l) => ({ ...l, quantity: l.quantity ?? 1, amount: round2(l.amount ?? l.rate * (l.quantity ?? 1)) }));
  if (!lines.some((l) => l.code === "LINEHAUL")) {
    if (!load.rate) throw new DomainError("NO_RATE", "Load has no agreed rate; supply a LINEHAUL line");
    lines.unshift({ code: "LINEHAUL", description: "Linehaul", quantity: 1, rate: load.rate.amount, amount: load.rate.amount });
  }
  if (input.fuelSurchargePct && !lines.some((l) => l.code === "FUEL_SURCHARGE")) {
    const linehaul = lines.filter((l) => l.code === "LINEHAUL").reduce((s, l) => s + l.amount, 0);
    const amt = round2((linehaul * input.fuelSurchargePct) / 100);
    lines.push({ code: "FUEL_SURCHARGE", description: `Fuel surcharge ${input.fuelSurchargePct}%`, quantity: 1, rate: amt, amount: amt });
  }
  const pu = pickupStop(load);
  const del = finalDeliveryStop(load);
  return {
    id: newId("inv"),
    invoiceNumber: input.invoiceNumber ?? `INV-${load.loadNumber}`,
    loadId: load.id,
    loadNumber: load.loadNumber,
    carrierOrgId: carrier.orgId,
    carrierScac: carrier.scac,
    billTo: { orgId: load.billTo.orgId, partnerKey: input.partnerKey, address: load.billTo.address },
    shipper: pu.address,
    consignee: del.address,
    references: { bol: load.references.bol, po: load.references.po, pro: load.references.pro },
    pickupDate: load.pickedUpAt ?? pu.window.start,
    deliveryDate: load.deliveredAt,
    weightLb: totalWeightLb(load),
    pieces: totalPieces(load),
    currency: load.rate?.currency ?? "USD",
    lines,
    total: round2(lines.reduce((s, l) => s + l.amount, 0)),
    terms: input.terms ?? "NET30",
    issuedAt: now,
    status: "DRAFT",
    createdByAccountId: accountId,
  };
}
