import type { ShipmentStatus } from "../transactions.js";
import { type CodeTables, decodeCode, encodeCode } from "./codes.js";
import { Cursor, type Segment, X12ParseError, el, fromX12DateTime, optEl, seg, x12DateTime } from "./core.js";

/** Decimal degrees -> X12 DDDMMSS / DDMMSS. */
export function toDms(value: number, degDigits: 2 | 3): string {
  const abs = Math.abs(value);
  let d = Math.floor(abs);
  let m = Math.floor((abs - d) * 60);
  let s = Math.round(((abs - d) * 60 - m) * 60);
  if (s === 60) {
    s = 0;
    m += 1;
  }
  if (m === 60) {
    m = 0;
    d += 1;
  }
  return String(d).padStart(degDigits, "0") + String(m).padStart(2, "0") + String(s).padStart(2, "0");
}

export function fromDms(code: string, dir: string): number {
  if (!/^\d{6,7}$/.test(code)) throw new X12ParseError(`bad lat/long ${code}`);
  const s = Number(code.slice(-2));
  const m = Number(code.slice(-4, -2));
  const d = Number(code.slice(0, -4));
  const v = d + m / 60 + s / 3600;
  return Math.round((dir === "S" || dir === "W" ? -v : v) * 1e6) / 1e6;
}

/**
 * 214 Transportation Carrier Shipment Status (4010): B10, L11 refs, then one
 * LX loop with AT7 status (and a second AT7*AG for an ETA), MS1 location,
 * MS2 equipment and L11*QN stop sequence.
 */
export function encode214(s: ShipmentStatus, codes: CodeTables): Segment[] {
  const out: Segment[] = [seg("B10", s.references.pro ?? s.shipmentId, s.shipmentId, s.carrierScac)];
  if (s.references.bol) out.push(seg("L11", s.references.bol, "BM"));
  for (const po of s.references.po ?? []) out.push(seg("L11", po, "PO"));
  out.push(seg("LX", 1));
  const at = x12DateTime(s.at);
  out.push(seg("AT7", encodeCode(codes.status, s.statusCode, "status"), encodeCode(codes.reason, s.reason, "reason"), "", "", at.date, at.time, "UT"));
  if (s.eta) {
    const e = x12DateTime(s.eta);
    out.push(seg("AT7", codes.status.ETA_UPDATE, codes.reason.NORMAL, "", "", e.date, e.time, "UT"));
  }
  const loc = s.location;
  if (loc.city || loc.state || loc.country || loc.lat !== undefined || loc.lng !== undefined) {
    const hasGeo = loc.lat !== undefined && loc.lng !== undefined;
    out.push(
      seg(
        "MS1",
        loc.city,
        loc.state,
        loc.country,
        hasGeo ? toDms(loc.lng!, 3) : undefined,
        hasGeo ? toDms(loc.lat!, 2) : undefined,
        hasGeo ? (loc.lng! < 0 ? "W" : "E") : undefined,
        hasGeo ? (loc.lat! < 0 ? "S" : "N") : undefined,
      ),
    );
  }
  if (s.equipmentNumber) out.push(seg("MS2", s.carrierScac, s.equipmentNumber));
  if (s.stopSequence) out.push(seg("L11", s.stopSequence, "QN"));
  return out;
}

export function decode214(body: Segment[], codes: CodeTables): ShipmentStatus {
  const c = new Cursor(body);
  const b10 = c.require("B10");
  const s: Partial<ShipmentStatus> & { references: ShipmentStatus["references"]; location: ShipmentStatus["location"] } = {
    shipmentId: el(b10, 2),
    carrierScac: el(b10, 3),
    references: {},
    location: {},
  };
  if (el(b10, 1) !== el(b10, 2)) s.references.pro = el(b10, 1);
  for (const l11 of c.takeAll("L11")) {
    if (el(l11, 2) === "BM") s.references.bol = el(l11, 1);
    else if (el(l11, 2) === "PO") (s.references.po ??= []).push(el(l11, 1));
  }
  c.require("LX");
  const ats = c.takeAll("AT7");
  const first = ats[0];
  if (!first) throw new X12ParseError("214 requires an AT7 status segment");
  s.statusCode = decodeCode(codes.status, el(first, 1), "status");
  s.reason = decodeCode(codes.reason, el(first, 2) || codes.reason.NORMAL, "reason");
  s.at = fromX12DateTime(el(first, 5), el(first, 6));
  const eta = ats[1];
  if (eta) s.eta = fromX12DateTime(el(eta, 5), el(eta, 6));
  const ms1 = c.take("MS1");
  if (ms1) {
    const city = optEl(ms1, 1);
    const state = optEl(ms1, 2);
    const country = optEl(ms1, 3);
    if (city) s.location.city = city;
    if (state) s.location.state = state;
    if (country) s.location.country = country;
    const lng = optEl(ms1, 4);
    const lat = optEl(ms1, 5);
    if (lng && lat) {
      s.location.lng = fromDms(lng, el(ms1, 6));
      s.location.lat = fromDms(lat, el(ms1, 7));
    }
  }
  const ms2 = c.take("MS2");
  if (ms2) s.equipmentNumber = el(ms2, 2);
  const qn = c.take("L11");
  if (qn && el(qn, 2) === "QN") s.stopSequence = Number(el(qn, 1));
  return s as ShipmentStatus;
}
