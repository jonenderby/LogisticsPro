import { z } from "zod";
import { Address, Contact, GeoPoint, Money, TimeWindow } from "./common.js";

export const EquipmentType = z.enum([
  "DRY_VAN",
  "REEFER",
  "FLATBED",
  "STEP_DECK",
  "LOWBOY",
  "CONTAINER",
  "POWER_ONLY",
]);
export type EquipmentType = z.infer<typeof EquipmentType>;

export const Mode = z.enum(["FTL", "LTL", "PARTIAL"]);
export type Mode = z.infer<typeof Mode>;

export const ServiceLevel = z.enum(["STANDARD", "EXPEDITED", "TEAM_EXPEDITED"]);
export type ServiceLevel = z.infer<typeof ServiceLevel>;

export const LoadStatus = z.enum([
  "DRAFT",
  "POSTED",
  "TENDERED",
  "BOOKED",
  "DISPATCHED",
  "AT_PICKUP",
  "IN_TRANSIT",
  "AT_DELIVERY",
  "DELIVERED",
  "INVOICED",
  "CANCELLED",
]);
export type LoadStatus = z.infer<typeof LoadStatus>;

/**
 * Canonical status events. Every channel (in-app, JSON, XML, EDI 214) maps to
 * and from this list, so a driver tapping "Loaded" produces the same fact for
 * every trading partner.
 */
export const StatusCode = z.enum([
  "DISPATCHED",
  "EN_ROUTE_TO_PICKUP",
  "ARRIVED_PICKUP",
  "LOADED",
  "IN_TRANSIT",
  "ARRIVED_RELAY",
  "RELAY_HANDOFF",
  "ARRIVED_TERMINAL",
  "DEPARTED_TERMINAL",
  "DELAYED",
  "ETA_UPDATE",
  "ARRIVED_DELIVERY",
  "DELIVERED",
]);
export type StatusCode = z.infer<typeof StatusCode>;

export const StopType = z.enum(["PICKUP", "DELIVERY", "RELAY", "CROSS_DOCK"]);
export type StopType = z.infer<typeof StopType>;

export const Stop = z.object({
  id: z.string(),
  sequence: z.number().int().positive(),
  type: StopType,
  address: Address,
  window: TimeWindow,
  contact: Contact.optional(),
  instructions: z.string().optional(),
  appointmentRef: z.string().optional(),
});
export type Stop = z.infer<typeof Stop>;

export const Hazmat = z.object({
  unNumber: z.string().regex(/^(UN|NA)\d{4}$/),
  hazardClass: z.string(),
  packingGroup: z.enum(["I", "II", "III"]).optional(),
  emergencyPhone: z.string(),
});

export const LineItem = z.object({
  description: z.string().min(1),
  pieces: z.number().int().positive(),
  packaging: z.enum(["PLT", "CTN", "SKD", "DRM", "BDL", "PCS", "CRT"]).default("PLT"),
  weightLb: z.number().positive(),
  freightClass: z.string().optional(),
  nmfc: z.string().optional(),
  dimsIn: z.object({ length: z.number(), width: z.number(), height: z.number() }).optional(),
  hazmat: Hazmat.optional(),
});
export type LineItem = z.infer<typeof LineItem>;

export const Permit = z.object({
  state: z.string().min(2).max(2),
  permitNumber: z.string(),
  validFrom: z.string(),
  validTo: z.string(),
  /** Mandatory permitted route as [lat,lng] pairs, in travel order. */
  route: z.array(GeoPoint).min(2),
  daylightOnly: z.boolean().default(true),
  noWeekends: z.boolean().default(false),
  escortsRequired: z.number().int().min(0).default(0),
});
export type Permit = z.infer<typeof Permit>;

export const Oversize = z.object({
  lengthIn: z.number().positive(),
  widthIn: z.number().positive(),
  heightIn: z.number().positive(),
  grossWeightLb: z.number().positive(),
  axles: z.number().int().positive().optional(),
  permits: z.array(Permit).default([]),
});
export type Oversize = z.infer<typeof Oversize>;

export const LegStatus = z.enum(["PLANNED", "ASSIGNED", "IN_PROGRESS", "COMPLETED"]);

export const Leg = z.object({
  id: z.string(),
  sequence: z.number().int().positive(),
  fromStopId: z.string(),
  toStopId: z.string(),
  driverAccountIds: z.array(z.string()).max(2).default([]),
  tractorId: z.string().optional(),
  trailerId: z.string().optional(),
  status: LegStatus.default("PLANNED"),
  consolidationId: z.string().optional(),
});
export type Leg = z.infer<typeof Leg>;

export const LoadEvent = z.object({
  id: z.string(),
  code: StatusCode,
  at: z.string(),
  stopId: z.string().optional(),
  legId: z.string().optional(),
  geo: GeoPoint.optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  note: z.string().optional(),
  /** Estimated arrival at the final delivery, when the carrier reports one (ETA updates, delays). */
  eta: z.string().optional(),
  reportedByAccountId: z.string().optional(),
  /** Where the event came from: the app, a partner API, or an inbound EDI 214. */
  source: z.enum(["APP", "API", "EDI", "SYSTEM"]).default("APP"),
});
export type LoadEvent = z.infer<typeof LoadEvent>;

export const DocumentKind = z.enum(["BOL", "POD", "RATE_CONFIRMATION", "LUMPER_RECEIPT", "SCALE_TICKET", "PERMIT", "INVOICE", "OTHER"]);

export const LoadDocument = z.object({
  id: z.string(),
  kind: DocumentKind,
  name: z.string(),
  url: z.string(),
  uploadedByAccountId: z.string(),
  at: z.string(),
});
export type LoadDocument = z.infer<typeof LoadDocument>;

export const PaymentTerms = z.enum(["PREPAID", "COLLECT", "THIRD_PARTY"]);

// Kept here (not imported from detention.ts) so load.ts has no cycle.
const StopVisitSchema = z.object({
  stopId: z.string(),
  arrivedAt: z.string(),
  departedAt: z.string().optional(),
  source: z.enum(["GEOFENCE", "STATUS"]),
  detentionNotifiedAt: z.string().optional(),
});

export const Load = z.object({
  id: z.string(),
  loadNumber: z.string(),
  version: z.number().int().nonnegative(),
  status: LoadStatus,
  mode: Mode,
  service: ServiceLevel.default("STANDARD"),
  equipment: z.object({
    type: EquipmentType,
    lengthFt: z.number().positive().default(53),
    tempMinF: z.number().optional(),
    tempMaxF: z.number().optional(),
  }),
  shipperOrgId: z.string(),
  brokerOrgId: z.string().optional(),
  carrierOrgId: z.string().optional(),
  /** Set when the carrier is not on the platform and is reached through a partner profile. */
  externalCarrierKey: z.string().optional(),
  references: z.object({
    bol: z.string().optional(),
    po: z.array(z.string()).default([]),
    shipperRef: z.string().optional(),
    pro: z.string().optional(),
  }),
  stops: z.array(Stop).min(2),
  items: z.array(LineItem).min(1),
  oversize: Oversize.optional(),
  accessorials: z.array(z.string()).default([]),
  rate: Money.optional(),
  billTo: z.object({ orgId: z.string().optional(), address: Address }),
  paymentTerms: PaymentTerms.default("PREPAID"),
  teamRequired: z.boolean().default(false),
  notes: z.string().optional(),
  shipConfirmedAt: z.string().optional(),
  pickedUpAt: z.string().optional(),
  deliveredAt: z.string().optional(),
  /** Arrival and departure at stops, from the truck's location (see detention.ts). */
  visits: z.array(StopVisitSchema).optional(),
  /** When the current carrier was given the load. A carrier is never charged for an appointment missed before this. */
  carrierSince: z.string().optional(),
  legs: z.array(Leg).default([]),
  events: z.array(LoadEvent).default([]),
  documents: z.array(LoadDocument).default([]),
  board: z
    .object({ postedByOrgId: z.string(), postedAt: z.string(), closesAt: z.string().optional() })
    .optional(),
  createdByAccountId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Load = z.infer<typeof Load>;

export function totalWeightLb(load: Pick<Load, "items">): number {
  return load.items.reduce((sum, i) => sum + i.weightLb, 0);
}

export function totalPieces(load: Pick<Load, "items">): number {
  return load.items.reduce((sum, i) => sum + i.pieces, 0);
}

export function pickupStop(load: Pick<Load, "stops">): Stop {
  const s = load.stops.find((x) => x.type === "PICKUP");
  if (!s) throw new Error("load has no pickup stop");
  return s;
}

export function finalDeliveryStop(load: Pick<Load, "stops">): Stop {
  const deliveries = load.stops.filter((x) => x.type === "DELIVERY");
  const s = deliveries[deliveries.length - 1];
  if (!s) throw new Error("load has no delivery stop");
  return s;
}

/** Org ids that are party to a load and may see it. */
export function loadParties(load: Pick<Load, "shipperOrgId" | "brokerOrgId" | "carrierOrgId">): string[] {
  return [load.shipperOrgId, load.brokerOrgId, load.carrierOrgId].filter((x): x is string => !!x);
}
