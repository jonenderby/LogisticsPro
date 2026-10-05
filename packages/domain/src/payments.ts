import { z } from "zod";
import { Address, DomainError, newId } from "./common.js";
import type { Invoice } from "./invoice.js";

/**
 * Getting paid: the payer's terms and quick-pay offer, the carrier's
 * factoring company, payments against an invoice, and aging.
 */

/** What a shipper or broker pays on: days after the invoice, and an optional quick-pay offer. */
export const PayerTerms = z.object({
  termsDays: z.number().int().min(0).max(120).default(30),
  quickPay: z.object({ days: z.number().int().min(0).max(30), feePct: z.number().min(0).max(10) }).optional(),
});
export type PayerTerms = z.infer<typeof PayerTerms>;
export const DEFAULT_PAYER_TERMS: PayerTerms = { termsDays: 30 };

/** A carrier's factoring company. Invoices are paid to it instead of the carrier. */
export const Factoring = z.object({
  company: z.string().min(1).max(120),
  email: z.string().email().max(254).optional(),
  address: Address.optional(),
  since: z.string(),
  setByAccountId: z.string(),
});
export type Factoring = z.infer<typeof Factoring>;

export const RemitTo = z.object({
  kind: z.enum(["CARRIER", "FACTOR"]),
  name: z.string(),
  email: z.string().optional(),
  address: Address.optional(),
});
export type RemitTo = z.infer<typeof RemitTo>;

export const PaymentMethod = z.enum(["ACH", "CHECK", "WIRE", "CARD", "OTHER"]);
export const Payment = z.object({
  id: z.string(),
  amount: z.number().positive(),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: PaymentMethod,
  reference: z.string().max(60).optional(),
  recordedByAccountId: z.string(),
  recordedAt: z.string(),
});
export type Payment = z.infer<typeof Payment>;

export const QuickPay = z.object({
  status: z.enum(["REQUESTED", "APPROVED", "DECLINED"]),
  days: z.number().int(),
  feePct: z.number(),
  fee: z.number(),
  netAmount: z.number(),
  requestedAt: z.string(),
  requestedByAccountId: z.string(),
  decidedAt: z.string().optional(),
  decidedByAccountId: z.string().optional(),
});
export type QuickPay = z.infer<typeof QuickPay>;

export const InvoiceHistoryEntry = z.object({
  status: z.string(),
  at: z.string(),
  byAccountId: z.string().optional(),
  note: z.string().optional(),
});
export type InvoiceHistoryEntry = z.infer<typeof InvoiceHistoryEntry>;

const r2 = (n: number) => Math.round(n * 100) / 100;
const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);

/** Due date: the approved quick-pay days from approval, otherwise the terms from the invoice date. */
export function dueDate(inv: Pick<Invoice, "issuedAt" | "termsDays" | "quickPay">): string {
  if (inv.quickPay?.status === "APPROVED" && inv.quickPay.decidedAt) return addDays(inv.quickPay.decidedAt, inv.quickPay.days);
  return addDays(inv.issuedAt, inv.termsDays ?? 30);
}

/** What the payer owes in total: the invoice, less the quick-pay fee when quick pay was approved. */
export function amountOwed(inv: Pick<Invoice, "total" | "quickPay">): number {
  return inv.quickPay?.status === "APPROVED" ? inv.quickPay.netAmount : inv.total;
}

export function amountPaid(inv: Pick<Invoice, "payments">): number {
  return r2((inv.payments ?? []).reduce((s, p) => s + p.amount, 0));
}

export function balance(inv: Pick<Invoice, "total" | "quickPay" | "payments">): number {
  return r2(Math.max(0, amountOwed(inv) - amountPaid(inv)));
}

const OPEN = ["SENT", "ACKNOWLEDGED", "APPROVED", "PARTIALLY_PAID", "DISPUTED"];
export const isOpen = (inv: Pick<Invoice, "status">) => OPEN.includes(inv.status);

/** Ask the payer to pay early at its quick-pay fee. */
export function requestQuickPay(inv: Invoice, offer: PayerTerms["quickPay"], accountId: string, now: string): Invoice {
  if (!offer) throw new DomainError("NO_QUICK_PAY", "This customer does not offer quick pay", 409);
  if (!["SENT", "ACKNOWLEDGED", "APPROVED"].includes(inv.status)) throw new DomainError("NOT_OPEN", "Quick pay is for invoices not yet paid or disputed", 409);
  if (inv.quickPay && inv.quickPay.status !== "DECLINED") throw new DomainError("ALREADY_REQUESTED", "Quick pay was already requested", 409);
  const fee = r2((inv.total * offer.feePct) / 100);
  const quickPay: QuickPay = { status: "REQUESTED", days: offer.days, feePct: offer.feePct, fee, netAmount: r2(inv.total - fee), requestedAt: now, requestedByAccountId: accountId };
  return { ...inv, quickPay, history: [...(inv.history ?? []), { status: "QUICK_PAY_REQUESTED", at: now, byAccountId: accountId, note: `${offer.feePct}% fee, paid in ${offer.days} days` }] };
}

export function decideQuickPay(inv: Invoice, approve: boolean, accountId: string, now: string): Invoice {
  if (inv.quickPay?.status !== "REQUESTED") throw new DomainError("NO_REQUEST", "No quick-pay request is waiting", 409);
  const quickPay: QuickPay = { ...inv.quickPay, status: approve ? "APPROVED" : "DECLINED", decidedAt: now, decidedByAccountId: accountId };
  const status = approve && (inv.status === "SENT" || inv.status === "ACKNOWLEDGED") ? "APPROVED" : inv.status;
  return { ...inv, status, quickPay, history: [...(inv.history ?? []), { status: approve ? "QUICK_PAY_APPROVED" : "QUICK_PAY_DECLINED", at: now, byAccountId: accountId }] };
}

const NEXT: Record<string, string[]> = {
  SENT: ["ACKNOWLEDGED", "APPROVED", "DISPUTED", "REJECTED"],
  ACKNOWLEDGED: ["APPROVED", "DISPUTED", "REJECTED"],
  APPROVED: ["DISPUTED"],
  PARTIALLY_PAID: ["DISPUTED"],
  DISPUTED: ["APPROVED", "REJECTED"],
};

/** The payer moves an invoice along: received, approved for payment, disputed or rejected. */
export function setInvoiceStatus(inv: Invoice, status: "ACKNOWLEDGED" | "APPROVED" | "DISPUTED" | "REJECTED", accountId: string, now: string, note?: string): Invoice {
  if (!NEXT[inv.status]?.includes(status)) throw new DomainError("INVALID_TRANSITION", `An invoice that is ${inv.status.toLowerCase().replace("_", " ")} can't be marked ${status.toLowerCase()}`, 409);
  if ((status === "DISPUTED" || status === "REJECTED") && !note?.trim()) throw new DomainError("REASON_REQUIRED", "Say what is wrong so the carrier can fix it", 400);
  return { ...inv, status, disputeReason: status === "DISPUTED" || status === "REJECTED" ? note : inv.disputeReason, history: [...(inv.history ?? []), { status, at: now, byAccountId: accountId, note }] };
}

/** Record money paid. Paying the balance closes the invoice; less leaves it partly paid. */
export function recordPayment(inv: Invoice, p: Omit<Payment, "id" | "recordedAt" | "recordedByAccountId">, accountId: string, now: string): Invoice {
  if (!isOpen(inv)) throw new DomainError("NOT_OPEN", "This invoice is not open for payment", 409);
  const left = balance(inv);
  if (p.amount > left + 0.005) throw new DomainError("OVERPAYMENT", `Only ${left.toFixed(2)} is owed on this invoice`, 400);
  const payment: Payment = { ...p, id: newId("pay"), recordedByAccountId: accountId, recordedAt: now };
  const next = { ...inv, payments: [...(inv.payments ?? []), payment] };
  const status = balance(next) <= 0.005 ? "PAID" : "PARTIALLY_PAID";
  return { ...next, status, history: [...(inv.history ?? []), { status, at: now, byAccountId: accountId, note: `${p.method} ${p.amount.toFixed(2)}${p.reference ? ` ref ${p.reference}` : ""}` }] };
}

export const AGING_BUCKETS = ["CURRENT", "DAYS_1_30", "DAYS_31_60", "DAYS_61_90", "DAYS_90_PLUS"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export function agingBucket(due: string, today: string): AgingBucket {
  const late = Math.floor((Date.parse(today) - Date.parse(due)) / 86_400_000);
  if (late <= 0) return "CURRENT";
  if (late <= 30) return "DAYS_1_30";
  if (late <= 60) return "DAYS_31_60";
  if (late <= 90) return "DAYS_61_90";
  return "DAYS_90_PLUS";
}

export interface Aging {
  buckets: Record<AgingBucket, { count: number; amount: number }>;
  open: number;
  overdue: number;
  /** Average days from invoice to final payment, over invoices paid in full. */
  averageDaysToPay?: number;
}

/** Open balances by how late they are. */
export function aging(invoices: Invoice[], today: string): Aging {
  const buckets = Object.fromEntries(AGING_BUCKETS.map((b) => [b, { count: 0, amount: 0 }])) as Aging["buckets"];
  for (const inv of invoices.filter(isOpen)) {
    const b = buckets[agingBucket(dueDate(inv), today)];
    b.count++;
    b.amount = r2(b.amount + balance(inv));
  }
  const open = r2(AGING_BUCKETS.reduce((s, b) => s + buckets[b].amount, 0));
  const paid = invoices.filter((i) => i.status === "PAID" && i.payments?.length);
  const days = paid.map((i) => (Date.parse(i.payments!.at(-1)!.paidOn) - Date.parse(i.issuedAt.slice(0, 10))) / 86_400_000);
  return { buckets, open, overdue: r2(open - buckets.CURRENT.amount), averageDaysToPay: days.length ? Math.round(days.reduce((s, d) => s + d, 0) / days.length) : undefined };
}
