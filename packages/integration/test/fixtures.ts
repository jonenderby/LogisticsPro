import type { FreightInvoice, LoadTender, PartnerProfile, ShipmentStatus, TenderResponse } from "../src/index.js";

const party = (name: string, city: string, state: string, zip: string) => ({ name, line1: "1 Main St", city, state, postalCode: zip, country: "US" });

export const tender: LoadTender = {
  purpose: "ORIGINAL",
  shipmentId: "LP-1001",
  carrierScac: "EXLA",
  paymentTerms: "PREPAID",
  equipmentType: "FLATBED",
  equipmentLengthFt: 48,
  service: "TEAM_EXPEDITED",
  respondBy: "2026-10-05T18:00:00Z",
  references: { bol: "BOL1", po: ["PO-1", "PO-2"], shipperRef: "SR-9" },
  billTo: { ...party("Acme AP", "Bronx", "NY", "10474"), line2: "Suite 200" },
  stops: [
    { sequence: 1, type: "PICKUP", party: { ...party("Acme DC", "Bronx", "NY", "10474"), locationCode: "ACME-BX" }, windowStart: "2026-10-06T13:00:00Z", windowEnd: "2026-10-06T15:00:00Z", contact: { name: "Dock Lead", phone: "7185550100" } },
    { sequence: 2, type: "DELIVERY", party: party("Gulf Grocers", "Houston", "TX", "77056"), windowStart: "2026-10-08T14:00:00Z", windowEnd: "2026-10-08T18:00:00Z", appointmentRef: "APT-42" },
  ],
  items: [
    { description: "Steel beams", pieces: 4, packaging: "BDL", weightLb: 42000, freightClass: "50", nmfc: "12345" },
    { description: "Paint", pieces: 2, packaging: "DRM", weightLb: 800, hazmat: { unNumber: "UN1263", hazardClass: "3", packingGroup: "II", emergencyPhone: "8004249300" } },
  ],
  totalWeightLb: 42800,
  totalPieces: 6,
  rateUsd: 5200.5,
  oversize: { lengthIn: 600, widthIn: 120, heightIn: 102, grossWeightLb: 82000 },
  notes: "Tarps required",
};

export const tenderResponse: TenderResponse = { shipmentId: "LP-1001", carrierScac: "EXLA", decision: "DECLINE", respondedOn: "2026-10-05", carrierReference: "PRO123", declineReason: "No capacity" };

export const status: ShipmentStatus = {
  shipmentId: "LP-1001",
  carrierScac: "EXLA",
  statusCode: "DELAYED",
  reason: "WEATHER",
  at: "2026-10-07T03:15:00Z",
  eta: "2026-10-08T20:00:00Z",
  location: { city: "Nashville", state: "TN", country: "US", lat: 36.15, lng: -86.75 },
  references: { pro: "PRO123", bol: "BOL1", po: ["PO-1"] },
  stopSequence: 2,
  equipmentNumber: "TRL5309",
};

export const invoice: FreightInvoice = {
  invoiceNumber: "INV-LP-1001",
  shipmentId: "LP-1001",
  carrierScac: "EXLA",
  invoiceDate: "2026-10-09",
  paymentTerms: "PREPAID",
  currency: "USD",
  totalAmount: 6037.5,
  billTo: party("Acme AP", "Bronx", "NY", "10474"),
  shipper: party("Acme DC", "Bronx", "NY", "10474"),
  consignee: party("Gulf Grocers", "Houston", "TX", "77056"),
  references: { bol: "BOL1", po: ["PO-1"], pro: "PRO123" },
  pickupDate: "2026-10-06",
  deliveryDate: "2026-10-08",
  weightLb: 42800,
  pieces: 6,
  lines: [
    { code: "LINEHAUL", description: "Linehaul", quantity: 1, rate: 5200, amount: 5200 },
    { code: "FUEL_SURCHARGE", description: "Fuel surcharge 15%", quantity: 1, rate: 780, amount: 780 },
    { code: "DETENTION", description: "Detention 1.5h", quantity: 1.5, rate: 38.33, amount: 57.5 },
  ],
};

export function profile(method: "API_JSON" | "API_XML" | "EDI_X12", extra: Partial<PartnerProfile> = {}): PartnerProfile {
  const ch = {
    method,
    enabled: true,
    transport: method === "EDI_X12" ? ("VAN" as const) : ("HTTPS" as const),
    endpoint: method === "EDI_X12" ? undefined : { url: "https://partner.example.com/inbound", httpMethod: "POST" as const, auth: { type: "apiKey" as const, header: "x-api-key", secretRef: "partner_key" }, headers: {} },
  };
  return {
    key: `partner-${method.toLowerCase()}`,
    ownerOrgId: "org_shipper",
    name: `Partner ${method}`,
    kind: "CARRIER",
    scac: "EXLA",
    channels: { LOAD_TENDER: ch, TENDER_RESPONSE: ch, SHIPMENT_STATUS: ch, FREIGHT_INVOICE: ch },
    edi: method === "EDI_X12" ? { senderQualifier: "ZZ", senderId: "LOGISTICSPRO", receiverQualifier: "02", receiverId: "EXLA", usage: "T", ackRequested: true, codeOverrides: {} } : undefined,
    ...extra,
  };
}
