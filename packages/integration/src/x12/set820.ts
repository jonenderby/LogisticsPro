import type { PaymentAdvice } from "../transactions.js";
import { Cursor, type Segment, X12ParseError, el, fromX12Date, optEl, seg, x12Date } from "./core.js";

/** 820 amounts are decimal ("R") values with the point written out, unlike the 210's implied cents. */
const dec = (n: number) => n.toFixed(2);
const fromDec = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new X12ParseError(`bad amount ${v}`);
  return Math.round(n * 100) / 100;
};

const METHOD: Record<PaymentAdvice["method"], string> = { ACH: "ACH", CHECK: "CHK", WIRE: "FWT", OTHER: "ZZZ" };
const FROM_METHOD: Record<string, PaymentAdvice["method"]> = { ACH: "ACH", CHK: "CHECK", FWT: "WIRE", ZZZ: "OTHER", NON: "OTHER", BOP: "OTHER" };

/**
 * 820 Payment Order/Remittance Advice (4010): BPR payment (amount, method,
 * effective date), TRN trace number, CUR, N1 PR payer and PE payee, then an
 * ENT loop with one RMR*IV per invoice (paid, invoiced, adjustment).
 */
export function encode820(p: PaymentAdvice): Segment[] {
  const out: Segment[] = [
    seg("BPR", "C", dec(p.totalAmount), "C", METHOD[p.method], p.method === "ACH" ? "CCP" : "", "", "", "", "", "", "", "", "", "", "", x12Date(p.paymentDate)),
    seg("TRN", "1", p.paymentRef),
    seg("CUR", "PR", p.currency),
    seg("N1", "PR", p.payerName),
    p.payeeScac ? seg("N1", "PE", p.payeeName, "ZZ", p.payeeScac) : seg("N1", "PE", p.payeeName),
  ];
  p.invoices.forEach((inv, i) => {
    out.push(seg("ENT", i + 1));
    out.push(seg("RMR", "IV", inv.invoiceNumber, "PI", dec(inv.amountPaid), inv.amountInvoiced === undefined ? "" : dec(inv.amountInvoiced), inv.adjustment === undefined ? "" : dec(inv.adjustment)));
  });
  return out;
}

export function decode820(body: Segment[]): PaymentAdvice {
  const c = new Cursor(body);
  const bpr = c.require("BPR");
  const trn = c.require("TRN");
  let cur: Segment | undefined;
  let payerName: string | undefined;
  let payeeName: string | undefined;
  let payeeScac: string | undefined;
  // Header: CUR, REF, DTM and the N1 loops (with their N2-N4, REF and PER) in any order; skip what isn't needed.
  while (c.peek() && c.peek()!.id !== "ENT" && c.peek()!.id !== "RMR") {
    const s = c.next()!;
    if (s.id === "CUR") cur = s;
    else if (s.id === "N1" && el(s, 1) === "PR") payerName = el(s, 2);
    else if (s.id === "N1" && el(s, 1) === "PE") {
      payeeName = el(s, 2);
      if (optEl(s, 3) === "ZZ") payeeScac = optEl(s, 4);
    }
  }
  if (!payerName || !payeeName) throw new X12ParseError("820 needs N1*PR (payer) and N1*PE (payee)");
  const invoices: PaymentAdvice["invoices"] = [];
  while (c.peek()) {
    const s = c.next()!;
    if (s.id !== "RMR") continue;
    if (el(s, 1) !== "IV") continue;
    const invoiced = optEl(s, 5);
    const adj = optEl(s, 6);
    invoices.push({ invoiceNumber: el(s, 2), amountPaid: fromDec(el(s, 4)), ...(invoiced ? { amountInvoiced: fromDec(invoiced) } : {}), ...(adj ? { adjustment: fromDec(adj) } : {}) });
  }
  const method = FROM_METHOD[el(bpr, 4)];
  if (!method) throw new X12ParseError(`unknown payment method ${el(bpr, 4)}`);
  return {
    paymentRef: el(trn, 2),
    paymentDate: fromX12Date(el(bpr, 16)),
    method,
    currency: cur ? el(cur, 2) : "USD",
    totalAmount: fromDec(el(bpr, 2)),
    payerName,
    payeeName,
    ...(payeeScac ? { payeeScac } : {}),
    invoices,
  };
}
