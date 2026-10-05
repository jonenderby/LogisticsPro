import type { Address, DistributionCenter, Load } from "../src/index.js";

export const NYC_WAREHOUSE: Address = {
  name: "Acme Foods Bronx DC",
  line1: "600 Food Center Dr",
  city: "Bronx",
  state: "NY",
  postalCode: "10474",
  country: "US",
  geo: { lat: 40.8091, lng: -73.8752 },
  locationCode: "ACME-BX",
};

export const HOUSTON_STORE: Address = {
  name: "Gulf Grocers Houston",
  line1: "2800 Post Oak Blvd",
  city: "Houston",
  state: "TX",
  postalCode: "77056",
  country: "US",
  geo: { lat: 29.7419, lng: -95.4614 },
};

export const NASHVILLE_YARD: Address = {
  name: "Relay Yard Nashville",
  line1: "100 Relay Way",
  city: "Nashville",
  state: "TN",
  postalCode: "37210",
  country: "US",
  geo: { lat: 36.1447, lng: -86.7341 },
};

export function makeLoad(overrides: Partial<Load> = {}): Load {
  const now = "2026-10-05T12:00:00.000Z";
  return {
    id: "load_test1",
    loadNumber: "LP-1001",
    version: 1,
    status: "BOOKED",
    mode: "FTL",
    service: "STANDARD",
    equipment: { type: "REEFER", lengthFt: 53, tempMinF: 34, tempMaxF: 38 },
    shipperOrgId: "org_shipper",
    carrierOrgId: "org_carrier",
    references: { bol: "BOL778899", po: ["PO-1", "PO-2"], shipperRef: "ACME-55" },
    stops: [
      { id: "stop_pu", sequence: 1, type: "PICKUP", address: NYC_WAREHOUSE, window: { start: "2026-10-06T13:00:00Z", end: "2026-10-06T15:00:00Z" }, contact: { name: "Dock Lead", phone: "7185550100" } },
      { id: "stop_del", sequence: 2, type: "DELIVERY", address: HOUSTON_STORE, window: { start: "2026-10-08T14:00:00Z", end: "2026-10-08T18:00:00Z" }, appointmentRef: "APT-42" },
    ],
    items: [
      { description: "Frozen vegetables", pieces: 20, packaging: "PLT", weightLb: 30000, freightClass: "65" },
      { description: "Dairy", pieces: 6, packaging: "PLT", weightLb: 8000 },
    ],
    accessorials: [],
    rate: { amount: 5200, currency: "USD" },
    billTo: { orgId: "org_shipper", address: { ...NYC_WAREHOUSE, name: "Acme Foods AP" } },
    paymentTerms: "PREPAID",
    teamRequired: false,
    legs: [],
    events: [],
    documents: [],
    createdByAccountId: "acct_shipper",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function ltlLoad(id: string, num: string, dest: Address, weightLb: number, pallets: number): Load {
  return makeLoad({
    id,
    loadNumber: num,
    mode: "LTL",
    equipment: { type: "DRY_VAN", lengthFt: 53 },
    references: { po: [] },
    stops: [
      { id: `${id}_pu`, sequence: 1, type: "PICKUP", address: NYC_WAREHOUSE, window: { start: "2026-10-06T13:00:00Z", end: "2026-10-06T15:00:00Z" } },
      { id: `${id}_del`, sequence: 2, type: "DELIVERY", address: dest, window: { start: "2026-10-09T14:00:00Z", end: "2026-10-09T18:00:00Z" } },
    ],
    items: [{ description: "General freight", pieces: pallets, packaging: "PLT", weightLb, freightClass: "70" }],
  });
}

export const NEWARK_DC: DistributionCenter = {
  id: "dc_newark",
  name: "Newark Cross-Dock",
  address: { name: "Newark Cross-Dock", line1: "1 Port St", city: "Newark", state: "NJ", postalCode: "07114", country: "US" },
  geo: { lat: 40.7066, lng: -74.1567 },
  serviceZip3: ["070", "071"],
};
