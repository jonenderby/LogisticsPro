import type { FreightInvoice, Party } from "../transactions.js";
import { type CodeTables, decodeCode, encodeCode } from "./codes.js";
import { Cursor, type Segment, X12ParseError, el, fromN2, fromX12Date, optEl, seg, toN2, x12Date } from "./core.js";
import { decodeParty, encodeParty, requireParty } from "./party.js";

/**
 * 210 Motor Carrier Freight Details and Invoice (4010): B3, C3 currency,
 * N9 references, G62*86 pickup date, N1 BT/SH/CN loops, one LX loop per
 * charge (L5 description, L0 quantity, L1 rate/charge/code), L3 totals.
 */
export function encode210(inv: FreightInvoice, codes: CodeTables): Segment[] {
  const out: Segment[] = [
    seg("B3", "", inv.invoiceNumber, inv.shipmentId, encodeCode(codes.payment, inv.paymentTerms, "payment"), "L", x12Date(inv.invoiceDate), toN2(inv.totalAmount), "", x12Date(inv.deliveryDate), "035", inv.carrierScac),
    seg("C3", inv.currency),
  ];
  if (inv.references.bol) out.push(seg("N9", "BM", inv.references.bol));
  for (const po of inv.references.po ?? []) out.push(seg("N9", "PO", po));
  if (inv.references.pro) out.push(seg("N9", "CN", inv.references.pro));
  out.push(seg("G62", "86", x12Date(inv.pickupDate)));
  out.push(...encodeParty("BT", inv.billTo), ...encodeParty("SH", inv.shipper), ...encodeParty("CN", inv.consignee));
  inv.lines.forEach((l, i) => {
    const n = i + 1;
    out.push(seg("LX", n), seg("L5", n, l.description), seg("L0", n, l.quantity, "FR"));
    out.push(seg("L1", n, l.rate, "FR", toN2(l.amount), "", "", "", encodeCode(codes.charge, l.code, "charge")));
  });
  out.push(seg("L3", inv.weightLb, "G", "", "", toN2(inv.totalAmount), "", "", "", "", "", inv.pieces, "L"));
  return out;
}

export function decode210(body: Segment[], codes: CodeTables): FreightInvoice {
  const c = new Cursor(body);
  const b3 = c.require("B3");
  const c3 = c.require("C3");
  const inv: Partial<FreightInvoice> & { references: FreightInvoice["references"] } = {
    invoiceNumber: el(b3, 2),
    shipmentId: el(b3, 3),
    paymentTerms: decodeCode(codes.payment, el(b3, 4), "payment"),
    invoiceDate: fromX12Date(el(b3, 6)),
    totalAmount: fromN2(el(b3, 7)),
    deliveryDate: fromX12Date(el(b3, 9)),
    carrierScac: el(b3, 11),
    currency: el(c3, 1),
    references: {},
  };
  for (const n9 of c.takeAll("N9")) {
    const [q, v] = [el(n9, 1), el(n9, 2)];
    if (q === "BM") inv.references.bol = v;
    else if (q === "PO") (inv.references.po ??= []).push(v);
    else if (q === "CN") inv.references.pro = v;
  }
  const g62 = c.require("G62");
  inv.pickupDate = fromX12Date(el(g62, 2));
  const parties = new Map<string, Party>();
  while (c.peek()?.id === "N1") {
    const { qualifier, party } = decodeParty(c);
    parties.set(qualifier, party);
  }
  inv.billTo = requireParty(parties, "BT", "bill-to");
  inv.shipper = requireParty(parties, "SH", "shipper");
  inv.consignee = requireParty(parties, "CN", "consignee");
  inv.lines = [];
  while (c.peek()?.id === "LX") {
    c.next();
    const l5 = c.require("L5");
    const l0 = c.require("L0");
    const l1 = c.require("L1");
    inv.lines.push({
      code: decodeCode(codes.charge, optEl(l1, 8) ?? "", "charge"),
      description: el(l5, 2),
      quantity: Number(el(l0, 2)),
      rate: Number(el(l1, 2)),
      amount: fromN2(el(l1, 4)),
    });
  }
  const l3 = c.require("L3");
  inv.weightLb = Number(el(l3, 1));
  inv.pieces = Number(el(l3, 11));
  if (fromN2(el(l3, 5)) !== inv.totalAmount) throw new X12ParseError("L305 total does not match B307 net amount");
  return inv as FreightInvoice;
}
