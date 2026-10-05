import type { LoadTender } from "../transactions.js";
import { type CodeTables, decodeCode, encodeCode } from "./codes.js";
import { Cursor, type Segment, X12ParseError, el, fromN2, fromX12DateTime, optEl, seg, toN2, x12DateTime } from "./core.js";
import { decodeParty, encodeParty } from "./party.js";

/**
 * 204 Motor Carrier Load Tender (4010).
 *
 * Header: B2, B2A, L11 (BM bill of lading, PO purchase order, SI shipper ref,
 * ZZ service level), G62*64 respond-by, NTE, N1 BT loop, N7 equipment with
 * MEA oversize dimensions. Detail: S5 stop loops (L11 AO appointment, G62
 * window, N1 SH/CN loop, G61 contact) with L5/AT8/LAD/LH1 line items on the
 * first pickup. Summary: L3 totals.
 */
export function encode204(t: LoadTender, codes: CodeTables): Segment[] {
  const out: Segment[] = [];
  out.push(seg("B2", "", t.carrierScac, "", t.shipmentId, "", encodeCode(codes.payment, t.paymentTerms, "payment")));
  out.push(seg("B2A", encodeCode(codes.purpose, t.purpose, "purpose"), "LT"));
  if (t.references.bol) out.push(seg("L11", t.references.bol, "BM"));
  for (const po of t.references.po ?? []) out.push(seg("L11", po, "PO"));
  if (t.references.shipperRef) out.push(seg("L11", t.references.shipperRef, "SI"));
  if (t.service) out.push(seg("L11", t.service, "ZZ"));
  if (t.respondBy) {
    const r = x12DateTime(t.respondBy);
    out.push(seg("G62", "64", r.date, "1", r.time, "UT"));
  }
  if (t.notes) out.push(seg("NTE", "GEN", t.notes));
  out.push(...encodeParty("BT", t.billTo));
  const len = t.equipmentLengthFt ? String(t.equipmentLengthFt * 100) : undefined;
  out.push(seg("N7", "", "NONE", "", "", "", "", "", "", "", "", encodeCode(codes.equipment, t.equipmentType, "equipment"), "", "", "", len));
  if (t.oversize) {
    out.push(seg("MEA", "PD", "LN", t.oversize.lengthIn, "IN"));
    out.push(seg("MEA", "PD", "WD", t.oversize.widthIn, "IN"));
    out.push(seg("MEA", "PD", "HT", t.oversize.heightIn, "IN"));
    out.push(seg("MEA", "PD", "G", t.oversize.grossWeightLb, "LB"));
  }

  const stops = [...t.stops].sort((a, b) => a.sequence - b.sequence);
  const firstPickup = stops.find((s) => s.type === "PICKUP");
  for (const s of stops) {
    out.push(seg("S5", s.sequence, s.type === "PICKUP" ? "LD" : "UL"));
    if (s.appointmentRef) out.push(seg("L11", s.appointmentRef, "AO"));
    const a = x12DateTime(s.windowStart);
    const b = x12DateTime(s.windowEnd);
    out.push(seg("G62", s.type === "PICKUP" ? "69" : "70", a.date, s.type === "PICKUP" ? "U" : "X", a.time, "UT"));
    out.push(seg("G62", s.type === "PICKUP" ? "38" : "54", b.date, "Z", b.time, "UT"));
    out.push(...encodeParty(s.type === "PICKUP" ? "SH" : "CN", s.party));
    if (s.contact) out.push(seg("G61", "IC", s.contact.name, "TE", s.contact.phone));
    if (s === firstPickup) {
      t.items.forEach((it, i) => {
        out.push(seg("L5", i + 1, it.description, it.nmfc, it.nmfc ? "N" : undefined));
        out.push(seg("AT8", "G", "L", it.weightLb, it.pieces));
        out.push(seg("LAD", it.packaging, it.pieces, "", "", "", "", it.freightClass ? "ZZ" : undefined, it.freightClass));
        if (it.hazmat) {
          out.push(seg("LH1", "PC", it.pieces, it.hazmat.unNumber, "", "", "", "", "", "", it.hazmat.packingGroup));
          out.push(seg("LH2", it.hazmat.hazardClass));
          out.push(seg("LFH", "TEL", it.hazmat.emergencyPhone));
        }
      });
    }
  }
  out.push(seg("L3", t.totalWeightLb, "G", "", "", t.rateUsd !== undefined ? toN2(t.rateUsd) : undefined, "", "", "", "", "", t.totalPieces, "L"));
  return out;
}

export function decode204(body: Segment[], codes: CodeTables): LoadTender {
  const c = new Cursor(body);
  const b2 = c.require("B2");
  const b2a = c.require("B2A");
  const t: Partial<LoadTender> & { references: LoadTender["references"] } = {
    carrierScac: el(b2, 2),
    shipmentId: el(b2, 4),
    paymentTerms: decodeCode(codes.payment, el(b2, 6), "payment"),
    purpose: decodeCode(codes.purpose, el(b2a, 1), "purpose"),
    references: {},
  };
  for (const l11 of c.takeAll("L11")) {
    const [v, q] = [el(l11, 1), el(l11, 2)];
    if (q === "BM") t.references.bol = v;
    else if (q === "PO") (t.references.po ??= []).push(v);
    else if (q === "SI") t.references.shipperRef = v;
    else if (q === "ZZ") t.service = v as LoadTender["service"];
  }
  const g62 = c.take("G62");
  if (g62) t.respondBy = fromX12DateTime(el(g62, 2), el(g62, 4));
  const nte = c.take("NTE");
  if (nte) t.notes = el(nte, 2);
  const bt = decodeParty(c);
  if (bt.qualifier !== "BT") throw new X12ParseError("expected N1*BT bill-to loop");
  t.billTo = bt.party;
  const n7 = c.require("N7");
  t.equipmentType = decodeCode(codes.equipment, el(n7, 11), "equipment");
  const len = optEl(n7, 15);
  if (len) t.equipmentLengthFt = Math.floor(Number(len) / 100);
  const meas = c.takeAll("MEA");
  if (meas.length) {
    const get = (q: string) => Number(el(meas.find((m) => el(m, 2) === q) ?? { id: "MEA", elements: [] }, 3));
    t.oversize = { lengthIn: get("LN"), widthIn: get("WD"), heightIn: get("HT"), grossWeightLb: get("G") };
  }

  t.stops = [];
  t.items = [];
  while (c.peek()?.id === "S5") {
    const s5 = c.next()!;
    const type = el(s5, 2) === "LD" ? "PICKUP" : el(s5, 2) === "UL" ? "DELIVERY" : undefined;
    if (!type) throw new X12ParseError(`unsupported S502 stop reason ${el(s5, 2)}`);
    const stop: LoadTender["stops"][number] = { sequence: Number(el(s5, 1)), type, windowStart: "", windowEnd: "", party: undefined as never };
    const appt = c.take("L11");
    if (appt) stop.appointmentRef = el(appt, 1);
    for (const g of c.takeAll("G62")) {
      const v = fromX12DateTime(el(g, 2), el(g, 4));
      if (["69", "70"].includes(el(g, 1))) stop.windowStart = v;
      else stop.windowEnd = v;
    }
    stop.party = decodeParty(c).party;
    const g61 = c.take("G61");
    if (g61) stop.contact = { name: el(g61, 2), phone: el(g61, 4) };
    while (c.peek()?.id === "L5") {
      const l5 = c.next()!;
      const at8 = c.require("AT8");
      const lad = c.require("LAD");
      const item: LoadTender["items"][number] = {
        description: el(l5, 2),
        pieces: Number(el(at8, 4)),
        packaging: el(lad, 1) as LoadTender["items"][number]["packaging"],
        weightLb: Number(el(at8, 3)),
      };
      const nmfc = optEl(l5, 3);
      if (nmfc) item.nmfc = nmfc;
      const cls = optEl(lad, 8);
      if (cls) item.freightClass = cls;
      const lh1 = c.take("LH1");
      if (lh1) {
        const lh2 = c.require("LH2");
        const lfh = c.require("LFH");
        item.hazmat = { unNumber: el(lh1, 3), hazardClass: el(lh2, 1), emergencyPhone: el(lfh, 2) };
        const pg = optEl(lh1, 10);
        if (pg) item.hazmat.packingGroup = pg as "I" | "II" | "III";
      }
      t.items.push(item);
    }
    t.stops.push(stop);
  }
  const l3 = c.require("L3");
  t.totalWeightLb = Number(el(l3, 1));
  const rate = optEl(l3, 5);
  if (rate !== undefined) t.rateUsd = fromN2(rate);
  t.totalPieces = Number(el(l3, 11));
  if (!c.done()) throw new X12ParseError(`unexpected segment ${c.peek()!.id} after L3`);
  return t as LoadTender;
}
