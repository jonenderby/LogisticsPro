import type { Address, Invoice, Load, LoadEvent } from "@logisticspro/domain";
import { totalPieces, totalWeightLb } from "@logisticspro/domain";
import type { CarrierCatalogEntry } from "./catalog/carriers.js";
import { defaultMethods } from "./catalog/carriers.js";
import type { Channel, PartnerProfile } from "./profile.js";
import {
  type FreightInvoice,
  type LoadTender,
  type Party,
  type ShipmentStatus,
  type TenderResponse,
  type TransactionType,
  TransmittedStatus,
  toCanonicalDate,
  toCanonicalTime,
} from "./transactions.js";

/** Builders that turn domain records into canonical transaction documents. */

export function partyFromAddress(a: Address): Party {
  const p: Party = { name: a.name, line1: a.line1, city: a.city, state: a.state, postalCode: a.postalCode, country: a.country ?? "US" };
  if (a.line2) p.line2 = a.line2;
  if (a.locationCode) p.locationCode = a.locationCode;
  return p;
}

const compactRefs = <T extends Record<string, unknown>>(r: T): T => {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(r)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as T;
};

export function tenderFromLoad(load: Load, carrierScac: string, purpose: LoadTender["purpose"] = "ORIGINAL", respondBy?: string): LoadTender {
  const stops = load.stops
    .filter((s) => s.type === "PICKUP" || s.type === "DELIVERY")
    .sort((a, b) => a.sequence - b.sequence)
    .map((s, i) => {
      const stop: LoadTender["stops"][number] = {
        sequence: i + 1,
        type: s.type as "PICKUP" | "DELIVERY",
        party: partyFromAddress(s.address),
        windowStart: toCanonicalTime(s.window.start),
        windowEnd: toCanonicalTime(s.window.end),
      };
      if (s.appointmentRef) stop.appointmentRef = s.appointmentRef;
      if (s.contact?.phone) stop.contact = { name: s.contact.name, phone: s.contact.phone };
      return stop;
    });
  const t: LoadTender = {
    purpose,
    shipmentId: load.loadNumber,
    carrierScac,
    paymentTerms: load.paymentTerms,
    equipmentType: load.equipment.type,
    equipmentLengthFt: Math.round(load.equipment.lengthFt),
    service: load.service,
    references: compactRefs({ bol: load.references.bol, po: load.references.po, shipperRef: load.references.shipperRef }),
    billTo: partyFromAddress(load.billTo.address),
    stops,
    items: load.items.map((i) => {
      const item: LoadTender["items"][number] = { description: i.description, pieces: i.pieces, packaging: i.packaging, weightLb: Math.round(i.weightLb) };
      if (i.freightClass) item.freightClass = i.freightClass;
      if (i.nmfc) item.nmfc = i.nmfc;
      if (i.hazmat) item.hazmat = { ...i.hazmat };
      return item;
    }),
    totalWeightLb: Math.round(totalWeightLb(load)),
    totalPieces: totalPieces(load),
  };
  if (respondBy) t.respondBy = toCanonicalTime(respondBy);
  if (load.rate && load.rate.currency === "USD") t.rateUsd = load.rate.amount;
  if (load.oversize) {
    t.oversize = { lengthIn: Math.round(load.oversize.lengthIn), widthIn: Math.round(load.oversize.widthIn), heightIn: Math.round(load.oversize.heightIn), grossWeightLb: Math.round(load.oversize.grossWeightLb) };
  }
  if (load.notes) t.notes = load.notes.slice(0, 80);
  return t;
}

export function tenderResponseDoc(load: Load, carrierScac: string, decision: TenderResponse["decision"], at: string, declineReason?: string): TenderResponse {
  const r: TenderResponse = { shipmentId: load.loadNumber, carrierScac, decision, respondedOn: toCanonicalDate(at) };
  if (load.references.pro) r.carrierReference = load.references.pro;
  if (declineReason) r.declineReason = declineReason.slice(0, 30);
  return r;
}

/** Returns undefined for internal events (dispatch, relay swaps) that partners do not receive. */
export function statusFromEvent(load: Load, event: LoadEvent, carrierScac: string, reason: ShipmentStatus["reason"] = "NORMAL", eta?: string): ShipmentStatus | undefined {
  const code = event.code === "RELAY_HANDOFF" || event.code === "ARRIVED_RELAY" ? undefined : TransmittedStatus.safeParse(event.code).data;
  if (!code) return undefined;
  const location: ShipmentStatus["location"] = {};
  if (event.city) location.city = event.city;
  if (event.state) location.state = event.state;
  if (event.geo) {
    location.lat = Math.round(event.geo.lat * 1e6) / 1e6;
    location.lng = Math.round(event.geo.lng * 1e6) / 1e6;
  }
  const s: ShipmentStatus = {
    shipmentId: load.loadNumber,
    carrierScac,
    statusCode: code,
    reason: code === "DELAYED" && reason === "NORMAL" ? "OTHER" : reason,
    at: toCanonicalTime(event.at),
    location,
    references: compactRefs({ pro: load.references.pro, bol: load.references.bol, po: load.references.po }),
  };
  const stop = event.stopId ? load.stops.find((x) => x.id === event.stopId) : undefined;
  if (stop) s.stopSequence = stop.sequence;
  if (eta) s.eta = toCanonicalTime(eta);
  return s;
}

export function invoiceDoc(inv: Invoice, paymentTerms: FreightInvoice["paymentTerms"], shipmentId: string): FreightInvoice {
  if (!inv.carrierScac) throw new Error("Carrier SCAC is required to send an invoice");
  return {
    invoiceNumber: inv.invoiceNumber,
    shipmentId,
    carrierScac: inv.carrierScac,
    invoiceDate: toCanonicalDate(inv.issuedAt),
    paymentTerms,
    currency: inv.currency,
    totalAmount: inv.total,
    billTo: partyFromAddress(inv.billTo.address),
    shipper: partyFromAddress(inv.shipper),
    consignee: partyFromAddress(inv.consignee),
    references: compactRefs({ bol: inv.references.bol, po: inv.references.po, pro: inv.references.pro }),
    pickupDate: toCanonicalDate(inv.pickupDate),
    deliveryDate: toCanonicalDate(inv.deliveryDate),
    weightLb: Math.round(inv.weightLb),
    pieces: inv.pieces,
    lines: inv.lines.map((l) => ({ code: l.code, description: l.description.slice(0, 30), quantity: l.quantity, rate: l.rate, amount: l.amount })),
  };
}

/**
 * Seed a partner profile from the catalog. The business still supplies
 * endpoint URLs, credentials (as secret references) and EDI ids.
 */
export function profileFromCatalog(entry: CarrierCatalogEntry, ownerOrgId: string, overrides: Partial<Record<TransactionType, Partial<Channel>>> = {}): PartnerProfile {
  const channels: PartnerProfile["channels"] = {};
  for (const [tx, method] of Object.entries(defaultMethods(entry)) as Array<[TransactionType, Channel["method"]]>) {
    channels[tx] = { method, enabled: true, transport: method === "EDI_X12" ? "AS2" : "HTTPS", ...overrides[tx] } as Channel;
  }
  return { key: entry.code, ownerOrgId, name: entry.name, kind: "CARRIER", scac: entry.scac[0], catalogCode: entry.code, channels };
}
