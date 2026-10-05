import { DomainError, newId } from "./common.js";
import type { Load, LoadEvent, LoadStatus, StatusCode } from "./load.js";

const TRANSITIONS: Record<LoadStatus, LoadStatus[]> = {
  DRAFT: ["POSTED", "TENDERED", "BOOKED", "CANCELLED"],
  POSTED: ["TENDERED", "BOOKED", "DRAFT", "CANCELLED"],
  TENDERED: ["BOOKED", "POSTED", "DRAFT", "CANCELLED"],
  BOOKED: ["DISPATCHED", "AT_PICKUP", "IN_TRANSIT", "TENDERED", "CANCELLED"],
  DISPATCHED: ["AT_PICKUP", "IN_TRANSIT", "BOOKED", "CANCELLED"],
  AT_PICKUP: ["IN_TRANSIT", "CANCELLED"],
  IN_TRANSIT: ["AT_DELIVERY", "DELIVERED", "IN_TRANSIT"],
  AT_DELIVERY: ["DELIVERED", "IN_TRANSIT"],
  DELIVERED: ["INVOICED"],
  INVOICED: [],
  CANCELLED: [],
};

export function canTransition(from: LoadStatus, to: LoadStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function transition(load: Load, to: LoadStatus, now = new Date().toISOString()): Load {
  if (!canTransition(load.status, to)) {
    throw new DomainError("INVALID_TRANSITION", `Load ${load.loadNumber} cannot move from ${load.status} to ${to}`, 409);
  }
  return { ...load, status: to, version: load.version + 1, updatedAt: now };
}

/** Which lifecycle status a status event implies (undefined = informational only). */
const STATUS_FOR_EVENT: Partial<Record<StatusCode, LoadStatus>> = {
  DISPATCHED: "DISPATCHED",
  EN_ROUTE_TO_PICKUP: "DISPATCHED",
  ARRIVED_PICKUP: "AT_PICKUP",
  LOADED: "IN_TRANSIT",
  IN_TRANSIT: "IN_TRANSIT",
  ARRIVED_RELAY: "IN_TRANSIT",
  RELAY_HANDOFF: "IN_TRANSIT",
  ARRIVED_TERMINAL: "IN_TRANSIT",
  DEPARTED_TERMINAL: "IN_TRANSIT",
  ARRIVED_DELIVERY: "AT_DELIVERY",
  DELIVERED: "DELIVERED",
};

const ACTIVE_STATUSES: LoadStatus[] = ["BOOKED", "DISPATCHED", "AT_PICKUP", "IN_TRANSIT", "AT_DELIVERY"];

/**
 * Apply a status event reported by a driver, a partner API, or an inbound 214.
 * Pickup locks shipper refinement; delivery completes the final leg.
 */
export function applyStatusEvent(load: Load, input: Omit<LoadEvent, "id"> & { id?: string }): Load {
  if (!ACTIVE_STATUSES.includes(load.status) && !(load.status === "DELIVERED" && input.code === "DELIVERED")) {
    throw new DomainError("NOT_ACTIVE", `Load ${load.loadNumber} is ${load.status}; status updates need a booked load`, 409);
  }
  const event: LoadEvent = { ...input, id: input.id ?? newId("evt") };
  let next: Load = { ...load, events: [...load.events, event], updatedAt: event.at, version: load.version + 1 };

  const target = STATUS_FOR_EVENT[event.code];
  if (target && target !== next.status) {
    // Drivers may skip intermediate taps (e.g. BOOKED -> LOADED); allow forward jumps.
    if (!canTransition(next.status, target) && !isForward(next.status, target)) {
      throw new DomainError("INVALID_TRANSITION", `Status ${event.code} is not valid while ${next.status}`, 409);
    }
    next = { ...next, status: target };
  }
  if (event.code === "LOADED" && !next.pickedUpAt) next.pickedUpAt = event.at;
  if (event.code === "DELIVERED") next.deliveredAt = event.at;

  next.legs = next.legs.map((leg) => {
    if (event.legId && leg.id !== event.legId) return leg;
    if (event.code === "LOADED" && leg.sequence === 1) return { ...leg, status: "IN_PROGRESS" };
    if (event.code === "RELAY_HANDOFF" && event.legId === leg.id) return { ...leg, status: "COMPLETED" };
    if (event.code === "DELIVERED" && leg.sequence === next.legs.length) return { ...leg, status: "COMPLETED" };
    return leg;
  });
  if (event.code === "RELAY_HANDOFF" && event.legId) {
    const done = next.legs.find((l) => l.id === event.legId);
    if (done) {
      next.legs = next.legs.map((l) => (l.sequence === done.sequence + 1 ? { ...l, status: "IN_PROGRESS" } : l));
    }
  }
  return next;
}

const ORDER: LoadStatus[] = ["DRAFT", "POSTED", "TENDERED", "BOOKED", "DISPATCHED", "AT_PICKUP", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED", "INVOICED"];
function isForward(from: LoadStatus, to: LoadStatus): boolean {
  const a = ORDER.indexOf(from);
  const b = ORDER.indexOf(to);
  return a >= ORDER.indexOf("BOOKED") && b > a;
}

/**
 * The shipper may refine a load until the driver reports pickup or the
 * shipper issues a ship confirm.
 */
export function refinementLock(load: Load): { locked: boolean; reason?: string } {
  if (load.status === "CANCELLED") return { locked: true, reason: "Load is cancelled" };
  if (load.pickedUpAt) return { locked: true, reason: `Driver reported pickup at ${load.pickedUpAt}` };
  if (load.shipConfirmedAt) return { locked: true, reason: `Shipper confirmed shipment at ${load.shipConfirmedAt}` };
  if (["IN_TRANSIT", "AT_DELIVERY", "DELIVERED", "INVOICED"].includes(load.status)) {
    return { locked: true, reason: `Load is ${load.status}` };
  }
  return { locked: false };
}

export const REFINABLE_FIELDS = ["stops", "items", "references", "accessorials", "equipment", "oversize", "notes", "billTo", "service", "teamRequired"] as const;
export type RefinableField = (typeof REFINABLE_FIELDS)[number];
export type LoadRefinement = Partial<Pick<Load, RefinableField>>;

export function refineLoad(load: Load, patch: LoadRefinement, now = new Date().toISOString()): { load: Load; changed: RefinableField[] } {
  const lock = refinementLock(load);
  if (lock.locked) throw new DomainError("LOAD_LOCKED", `Load can no longer be changed: ${lock.reason}`, 409);
  const changed: RefinableField[] = [];
  const next: Load = { ...load };
  for (const key of REFINABLE_FIELDS) {
    if (patch[key] === undefined) continue;
    if (JSON.stringify(patch[key]) === JSON.stringify(load[key])) continue;
    (next as Record<string, unknown>)[key] = patch[key];
    changed.push(key);
  }
  if (changed.length === 0) return { load, changed };
  if (changed.includes("stops")) {
    // Stop changes invalidate a dispatch plan built on the old stops.
    const stopIds = new Set(next.stops.map((s) => s.id));
    next.legs = next.legs.filter((l) => stopIds.has(l.fromStopId) && stopIds.has(l.toStopId));
  }
  return { load: { ...next, version: load.version + 1, updatedAt: now }, changed };
}

export function shipConfirm(load: Load, now = new Date().toISOString()): Load {
  if (load.shipConfirmedAt) return load;
  if (!load.carrierOrgId && !load.externalCarrierKey) {
    throw new DomainError("NO_CARRIER", "Assign a carrier before confirming shipment", 409);
  }
  return { ...load, shipConfirmedAt: now, version: load.version + 1, updatedAt: now };
}
