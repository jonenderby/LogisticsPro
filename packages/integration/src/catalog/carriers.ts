import { type IntegrationMethod, preferredMethod } from "../profile.js";
import type { TransactionType } from "../transactions.js";

/**
 * Top carriers and what each one publicly offers for integration.
 *
 * Ranking: Transport Topics 2026 Top 100 For-Hire Carriers (revenue) where a
 * rank was confirmed; remaining slots are filled with the largest LTL and
 * truckload carriers from the 2026 TT segment lists.
 *
 * Confidence:
 *  - documented: the carrier's own developer portal or API guide says so.
 *  - reported:   third-party sources (EDI networks, integrators) say so.
 *  - assumed:    industry-standard EDI support; confirm during onboarding.
 *
 * Carrier APIs need an account with that carrier (API keys, OAuth clients or
 * an approval step). Endpoint URLs, credentials and partner-specific field
 * maps are filled in per business during onboarding; this catalog only seeds
 * the default method per transaction.
 */
export type Segment = "PARCEL" | "LTL" | "TRUCKLOAD" | "INTERMODAL" | "LOGISTICS" | "EXPEDITED" | "DEDICATED";
export type Confidence = "documented" | "reported" | "assumed";

export interface CarrierCatalogEntry {
  code: string;
  name: string;
  scac: string[];
  segments: Segment[];
  ttRank2026?: number;
  api?: {
    formats: Array<"JSON" | "XML">;
    style: string;
    auth: string;
    access: "self-serve" | "account-holder" | "approval" | "invitation";
    portal?: string;
    services: string[];
  };
  edi: { sets: string[]; confidence: Confidence };
  /** Methods the carrier supports for each canonical transaction (any order). */
  methods: Partial<Record<TransactionType, IntegrationMethod[]>>;
  confidence: Confidence;
  notes?: string;
  sources: string[];
}

const LTL_EDI = ["204", "210", "214", "990", "997"];
const TL_EDI = ["204", "210", "214", "990", "997"];

export const CARRIER_CATALOG: CarrierCatalogEntry[] = [
  {
    code: "ups",
    name: "UPS",
    scac: ["UPSN"],
    segments: ["PARCEL", "LOGISTICS"],
    ttRank2026: 1,
    api: { formats: ["JSON"], style: "REST", auth: "OAuth 2.0 client credentials", access: "account-holder", portal: "https://developer.ups.com", services: ["Rating", "Shipping", "Pickup", "Tracking", "Paperless documents"] },
    edi: { sets: ["210", "214"], confidence: "assumed" },
    methods: { RATE_QUOTE: ["API_JSON"], PICKUP_REQUEST: ["API_JSON"], LOAD_TENDER: ["API_JSON"], TENDER_RESPONSE: ["API_JSON"], SHIPMENT_STATUS: ["API_JSON", "EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "documented",
    sources: ["https://developer.ups.com"],
  },
  {
    code: "fedex",
    name: "FedEx",
    scac: ["FDEG"],
    segments: ["PARCEL"],
    ttRank2026: 2,
    api: { formats: ["JSON"], style: "REST", auth: "OAuth 2.0 client credentials", access: "account-holder", portal: "https://developer.fedex.com", services: ["Rates and transit times", "Ship", "Pickup", "Track"] },
    edi: { sets: ["210"], confidence: "assumed" },
    methods: { RATE_QUOTE: ["API_JSON"], PICKUP_REQUEST: ["API_JSON"], LOAD_TENDER: ["API_JSON"], TENDER_RESPONSE: ["API_JSON"], SHIPMENT_STATUS: ["API_JSON"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "documented",
    sources: ["https://developer.fedex.com/api/en-us/support.html"],
  },
  {
    code: "jbhunt",
    name: "J.B. Hunt Transport Services",
    scac: ["HJBT"],
    segments: ["TRUCKLOAD", "INTERMODAL", "DEDICATED", "LOGISTICS"],
    ttRank2026: 3,
    api: { formats: ["JSON"], style: "REST (J.B. Hunt 360 Connect)", auth: "Subscription key", access: "approval", portal: "https://apiportal.jbhunt.com", services: ["Orders", "Shipment tracking"] },
    edi: { sets: TL_EDI, confidence: "reported" },
    methods: { LOAD_TENDER: ["API_JSON", "EDI_X12"], TENDER_RESPONSE: ["EDI_X12"], SHIPMENT_STATUS: ["API_JSON", "EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "documented",
    notes: "Developer access requires an existing business relationship and approval.",
    sources: ["https://apiportal.jbhunt.com/docs/services/orders-api/operations/get-order", "https://www.stacksync.com/edi/jb-hunt/hunt-j-b-transport-inc-truckload-asset"],
  },
  {
    code: "fedex-freight",
    name: "FedEx Freight",
    scac: ["FXFE", "FXNL"],
    segments: ["LTL"],
    ttRank2026: 4,
    api: { formats: ["JSON"], style: "REST (Freight LTL API)", auth: "OAuth 2.0 client credentials", access: "account-holder", portal: "https://developer.fedex.com/api/en-us/catalog/ltl-freight.html", services: ["Rates and transit times", "Ship / BOL and labels", "Pickup availability and request", "Tracking"] },
    edi: { sets: LTL_EDI, confidence: "assumed" },
    methods: { RATE_QUOTE: ["API_JSON"], PICKUP_REQUEST: ["API_JSON"], LOAD_TENDER: ["API_JSON", "EDI_X12"], TENDER_RESPONSE: ["API_JSON", "EDI_X12"], SHIPMENT_STATUS: ["API_JSON", "EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "documented",
    notes: "Stand-alone public company since the June 2026 spinoff from FedEx Corp.",
    sources: ["https://developer.fedex.com/api/en-us/catalog/ltl-freight/docs.html", "https://developer.fedexfreight.com/ltl-ship-overview"],
  },
  {
    code: "xpo",
    name: "XPO",
    scac: ["CNWY"],
    segments: ["LTL"],
    ttRank2026: 5,
    api: { formats: ["JSON"], style: "REST (api.ltl.xpo.com)", auth: "OAuth bearer token", access: "account-holder", portal: "https://www.xpo.com/help-center/integration-with-customer-systems/api/", services: ["Rate quotes and spot quotes", "Bill of lading create/update/cancel", "Pickup requests", "Shipment tracking and imaging"] },
    edi: { sets: LTL_EDI, confidence: "assumed" },
    methods: { RATE_QUOTE: ["API_JSON"], PICKUP_REQUEST: ["API_JSON"], LOAD_TENDER: ["API_JSON", "EDI_X12"], TENDER_RESPONSE: ["API_JSON", "EDI_X12"], SHIPMENT_STATUS: ["API_JSON", "EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "documented",
    notes: "Pickup and BOL APIs have a testMode flag for certification.",
    sources: ["https://www.xpo.com/help-center/integration-with-customer-systems/api/", "https://www.xpo.com/cdn/files/s1/XPO_API_Rating_Guide.pdf"],
  },
  {
    code: "tforce-freight",
    name: "TFI International (TForce Freight)",
    scac: ["UPGF"],
    segments: ["LTL", "TRUCKLOAD", "PARCEL"],
    ttRank2026: 6,
    api: { formats: ["JSON"], style: "REST", auth: "OAuth 2.0", access: "account-holder", portal: "https://developer.tforcefreight.com", services: ["Rating", "Shipping / BOL", "Pickup", "Tracking"] },
    edi: { sets: LTL_EDI, confidence: "assumed" },
    methods: { RATE_QUOTE: ["API_JSON"], PICKUP_REQUEST: ["API_JSON"], LOAD_TENDER: ["API_JSON", "EDI_X12"], TENDER_RESPONSE: ["API_JSON", "EDI_X12"], SHIPMENT_STATUS: ["API_JSON", "EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "documented",
    sources: ["https://developer.tforcefreight.com/", "https://www.tforcefreight.com/downloads/Shipping-API-User-Manual-V1.pdf"],
  },
  {
    code: "ryder",
    name: "Ryder System",
    scac: [],
    segments: ["DEDICATED", "LOGISTICS"],
    ttRank2026: 7,
    edi: { sets: TL_EDI, confidence: "assumed" },
    methods: { LOAD_TENDER: ["EDI_X12"], TENDER_RESPONSE: ["EDI_X12"], SHIPMENT_STATUS: ["EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "assumed",
    notes: "No public carrier API found; integration is arranged per contract. Confirm SCAC and sets at onboarding.",
    sources: [],
  },
  {
    code: "knight-swift",
    name: "Knight-Swift Transportation",
    scac: ["KNIG", "SWFT"],
    segments: ["TRUCKLOAD", "LTL", "INTERMODAL"],
    ttRank2026: 8,
    edi: { sets: ["204", "210", "214", "990"], confidence: "reported" },
    methods: { LOAD_TENDER: ["EDI_X12"], TENDER_RESPONSE: ["EDI_X12"], SHIPMENT_STATUS: ["EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "reported",
    sources: ["https://github.com/api-evangelist/swift-transportation"],
  },
  {
    code: "estes",
    name: "Estes Express Lines",
    scac: ["EXLA"],
    segments: ["LTL"],
    ttRank2026: 9,
    api: { formats: ["JSON", "XML"], style: "REST (current) and SOAP/XML (legacy web services)", auth: "API key + account credentials", access: "account-holder", portal: "https://developer.estes-express.com/", services: ["Rate quote", "Bill of lading", "Pickup create/update/cancel", "Shipment tracking", "Image retrieval"] },
    edi: { sets: LTL_EDI, confidence: "assumed" },
    methods: { RATE_QUOTE: ["API_JSON", "API_XML"], PICKUP_REQUEST: ["API_JSON"], LOAD_TENDER: ["API_JSON", "EDI_X12"], TENDER_RESPONSE: ["API_JSON", "EDI_X12"], SHIPMENT_STATUS: ["API_JSON", "API_XML", "EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "documented",
    sources: ["https://developer.estes-express.com/", "https://www.estes-express.com/resources/digital-services/api/"],
  },
  {
    code: "schneider",
    name: "Schneider National",
    scac: ["SNLU"],
    segments: ["TRUCKLOAD", "INTERMODAL", "LOGISTICS"],
    ttRank2026: 10,
    api: { formats: ["JSON"], style: "REST (FreightPower)", auth: "Subscription key", access: "approval", services: ["Quotes", "Load booking", "Tracking"] },
    edi: { sets: ["204", "210", "214", "990"], confidence: "reported" },
    methods: { LOAD_TENDER: ["API_JSON", "EDI_X12"], TENDER_RESPONSE: ["EDI_X12"], SHIPMENT_STATUS: ["API_JSON", "EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"], RATE_QUOTE: ["API_JSON"] },
    confidence: "reported",
    notes: "Schneider issues test subscription keys within about two days.",
    sources: ["https://schneider.com/resources/case-study/FreightPower-API-connection-delivers-more-capacity-faster-freight-quotes", "https://www.stacksync.com/edi/schneider-national-carriers-inc"],
  },
  {
    code: "odfl",
    name: "Old Dominion Freight Line",
    scac: ["ODFL"],
    segments: ["LTL"],
    ttRank2026: 11,
    api: { formats: ["JSON", "XML"], style: "REST, with SOAP for rate estimates", auth: "Developer portal application keys", access: "account-holder", portal: "https://www.odfl.com/us/en/resources/shipping-api-integrations.html", services: ["Rate estimate (SOAP)", "Transit times", "Bill of lading", "Pickup", "Documents", "Tracking"] },
    edi: { sets: LTL_EDI, confidence: "assumed" },
    methods: { RATE_QUOTE: ["API_XML"], PICKUP_REQUEST: ["API_JSON"], LOAD_TENDER: ["API_JSON", "EDI_X12"], TENDER_RESPONSE: ["API_JSON", "EDI_X12"], SHIPMENT_STATUS: ["API_JSON", "EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "documented",
    sources: ["https://www.odfl.com/us/en/resources/shipping-api-integrations.html", "https://www.odfl.com/content/dam/odfl/us/en/documents/web-services/Rate%20Estimate%20API%20Development%20Guide.pdf"],
  },
  {
    code: "landstar",
    name: "Landstar System",
    scac: [],
    segments: ["TRUCKLOAD", "LOGISTICS"],
    ttRank2026: 12,
    edi: { sets: TL_EDI, confidence: "assumed" },
    methods: { LOAD_TENDER: ["EDI_X12"], TENDER_RESPONSE: ["EDI_X12"], SHIPMENT_STATUS: ["EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "assumed",
    notes: "Tracking visibility is offered through project44 (Landstar Clarity). No public carrier API found.",
    sources: ["https://www.landstar.com/blog/clarity/"],
  },
  {
    code: "penske-logistics",
    name: "Penske Logistics",
    scac: [],
    segments: ["DEDICATED", "LOGISTICS"],
    ttRank2026: 13,
    edi: { sets: TL_EDI, confidence: "assumed" },
    methods: { LOAD_TENDER: ["EDI_X12"], TENDER_RESPONSE: ["EDI_X12"], SHIPMENT_STATUS: ["EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "assumed",
    sources: [],
  },
  {
    code: "arcbest",
    name: "ArcBest (ABF Freight)",
    scac: ["ABFS"],
    segments: ["LTL", "TRUCKLOAD", "LOGISTICS"],
    ttRank2026: 14,
    api: { formats: ["XML", "JSON"], style: "HTTP/XML and JSON", auth: "API key", access: "invitation", portal: "https://arcb.com/technology/shippers/API", services: ["Rate quote", "Volume quote", "Tracking", "Document retrieval", "Transit times", "Pickup request", "Bill of lading"] },
    edi: { sets: LTL_EDI, confidence: "documented" },
    methods: { RATE_QUOTE: ["API_JSON", "API_XML"], PICKUP_REQUEST: ["API_JSON", "API_XML"], LOAD_TENDER: ["API_JSON", "API_XML", "EDI_X12"], TENDER_RESPONSE: ["EDI_X12"], SHIPMENT_STATUS: ["API_JSON", "API_XML", "EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "documented",
    notes: "API access is by invitation; documentation is behind the arcb.com login.",
    sources: ["https://arcb.com/technology/shippers/API"],
  },
  {
    code: "hub-group",
    name: "Hub Group",
    scac: ["HUBG"],
    segments: ["INTERMODAL", "LOGISTICS", "DEDICATED"],
    ttRank2026: 15,
    api: { formats: ["JSON"], style: "REST feeds", auth: "Arranged per customer", access: "approval", services: ["Real-time tracking and ETA"] },
    edi: { sets: ["204", "210", "214", "990"], confidence: "reported" },
    methods: { LOAD_TENDER: ["EDI_X12"], TENDER_RESPONSE: ["EDI_X12"], SHIPMENT_STATUS: ["API_JSON", "EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "reported",
    sources: ["https://www.freightwaves.com/news/hub-group-rolls-out-enhanced-end-to-end-visibility-for-customers-to-track-shipments-in-real-time", "https://www.stacksync.com/edi/hub-group-inc/204"],
  },
  {
    code: "rl-carriers",
    name: "R+L Carriers",
    scac: ["RLCA"],
    segments: ["LTL"],
    ttRank2026: 16,
    api: { formats: ["JSON", "XML"], style: "REST (JSON) and SOAP", auth: "API key", access: "account-holder", portal: "https://technology.rlcarriers.com/", services: ["Rate quote", "Bill of lading", "Pickup request", "Shipment tracing", "Transit times", "Document retrieval", "Notifications"] },
    edi: { sets: LTL_EDI, confidence: "assumed" },
    methods: { RATE_QUOTE: ["API_JSON", "API_XML"], PICKUP_REQUEST: ["API_JSON", "API_XML"], LOAD_TENDER: ["API_JSON", "API_XML", "EDI_X12"], TENDER_RESPONSE: ["API_JSON", "EDI_X12"], SHIPMENT_STATUS: ["API_JSON", "API_XML", "EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "documented",
    sources: ["https://www.rlcarriers.com/freight/shipping-software/freight-api-overview", "https://technology.rlcarriers.com/"],
  },
  {
    code: "saia",
    name: "Saia",
    scac: ["SAIA"],
    segments: ["LTL"],
    ttRank2026: 18,
    api: { formats: ["JSON", "XML"], style: "REST tracking; XML/SOAP web services for rating, eBOL and pickup", auth: "Subscription key + Saia Secure basic auth", access: "account-holder", portal: "https://www.saia.com/tools-and-resources/web-integration-services", services: ["Tracking (REST)", "Rate quote", "NMFTA eBOL", "Pickup", "Proof of delivery"] },
    edi: { sets: LTL_EDI, confidence: "assumed" },
    methods: { RATE_QUOTE: ["API_XML"], PICKUP_REQUEST: ["API_XML"], LOAD_TENDER: ["API_XML", "EDI_X12"], TENDER_RESPONSE: ["EDI_X12"], SHIPMENT_STATUS: ["API_JSON", "EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "documented",
    sources: ["https://www.saia.com/tools-and-resources/web-integration-services", "https://api.saia.com/customer-api/public/api-docs/index"],
  },
  {
    code: "werner",
    name: "Werner Enterprises",
    scac: ["WERN"],
    segments: ["TRUCKLOAD", "DEDICATED", "LOGISTICS"],
    ttRank2026: 19,
    api: { formats: ["JSON"], style: "REST (Werner Bridge / EDGE)", auth: "Arranged per customer", access: "approval", portal: "https://www.werner.com/technology/", services: ["Load booking", "Tracking", "Documents"] },
    edi: { sets: TL_EDI, confidence: "documented" },
    methods: { LOAD_TENDER: ["API_JSON", "EDI_X12"], TENDER_RESPONSE: ["EDI_X12"], SHIPMENT_STATUS: ["API_JSON", "EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "reported",
    notes: "Werner reports EDI with 700+ trading partners plus API and Snowflake data shares.",
    sources: ["https://www.werner.com/technology/"],
  },
  {
    code: "prime",
    name: "Prime Inc.",
    scac: [],
    segments: ["TRUCKLOAD"],
    ttRank2026: 20,
    edi: { sets: TL_EDI, confidence: "assumed" },
    methods: { LOAD_TENDER: ["EDI_X12"], TENDER_RESPONSE: ["EDI_X12"], SHIPMENT_STATUS: ["EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "assumed",
    sources: [],
  },
  {
    code: "sefl",
    name: "Southeastern Freight Lines",
    scac: ["SEFL"],
    segments: ["LTL"],
    api: { formats: ["JSON", "XML"], style: "Web Connect (REST and XML services)", auth: "MySEFL credentials", access: "account-holder", portal: "https://www.sefl.com/seflWebsite/technology/webConnect.jsp", services: ["Rate quote (REST)", "Tracing push notifications (REST)", "Routing guide", "Claim status", "Proof of delivery"] },
    edi: { sets: LTL_EDI, confidence: "assumed" },
    methods: { RATE_QUOTE: ["API_JSON"], LOAD_TENDER: ["EDI_X12"], TENDER_RESPONSE: ["EDI_X12"], SHIPMENT_STATUS: ["API_JSON", "EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "documented",
    sources: ["https://www.sefl.com/seflWebsite/technology/webConnect.jsp"],
  },
  {
    code: "averitt",
    name: "Averitt Express",
    scac: ["AVRT"],
    segments: ["LTL", "TRUCKLOAD"],
    api: { formats: ["JSON"], style: "REST (api.averittexpress.com)", auth: "API key", access: "account-holder", portal: "https://www.averitt.com/technology/api", services: ["eBOL", "BOL/PRO/order tracking", "Pickup request and tracking", "PRO reserve", "Transit times", "LTL, volume and truckload rate quotes"] },
    edi: { sets: LTL_EDI, confidence: "assumed" },
    methods: { RATE_QUOTE: ["API_JSON"], PICKUP_REQUEST: ["API_JSON"], LOAD_TENDER: ["API_JSON", "EDI_X12"], TENDER_RESPONSE: ["API_JSON", "EDI_X12"], SHIPMENT_STATUS: ["API_JSON", "EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "documented",
    sources: ["https://www.averitt.com/technology/api"],
  },
  {
    code: "aaa-cooper",
    name: "AAA Cooper Transportation",
    scac: ["AACT"],
    segments: ["LTL"],
    api: { formats: ["XML"], style: "SOAP", auth: "API token", access: "account-holder", portal: "https://www.aaacooper.com/web-services", services: ["Rate estimate", "Imaging", "Tracking", "Transit time", "Pickup request", "Claims"] },
    edi: { sets: LTL_EDI, confidence: "assumed" },
    methods: { RATE_QUOTE: ["API_XML"], PICKUP_REQUEST: ["API_XML"], LOAD_TENDER: ["EDI_X12"], TENDER_RESPONSE: ["EDI_X12"], SHIPMENT_STATUS: ["API_XML", "EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "documented",
    sources: ["https://www.aaacooper.com/web-services"],
  },
  {
    code: "dayton-freight",
    name: "Dayton Freight Lines",
    scac: ["DAFG"],
    segments: ["LTL"],
    edi: { sets: LTL_EDI, confidence: "assumed" },
    methods: { LOAD_TENDER: ["EDI_X12"], TENDER_RESPONSE: ["EDI_X12"], SHIPMENT_STATUS: ["EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "assumed",
    notes: "No public API documentation reviewed; confirm web services at onboarding.",
    sources: [],
  },
  {
    code: "nfi",
    name: "NFI",
    scac: [],
    segments: ["TRUCKLOAD", "DEDICATED", "INTERMODAL"],
    edi: { sets: TL_EDI, confidence: "assumed" },
    methods: { LOAD_TENDER: ["EDI_X12"], TENDER_RESPONSE: ["EDI_X12"], SHIPMENT_STATUS: ["EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "assumed",
    sources: [],
  },
  {
    code: "crst",
    name: "CRST The Transportation Solution",
    scac: [],
    segments: ["TRUCKLOAD", "EXPEDITED"],
    edi: { sets: TL_EDI, confidence: "assumed" },
    methods: { LOAD_TENDER: ["EDI_X12"], TENDER_RESPONSE: ["EDI_X12"], SHIPMENT_STATUS: ["EDI_X12"], FREIGHT_INVOICE: ["EDI_X12"] },
    confidence: "assumed",
    notes: "Team-expedited specialist; a natural partner for team loads.",
    sources: [],
  },
];

export function findCarrier(codeOrScac: string): CarrierCatalogEntry | undefined {
  const q = codeOrScac.toLowerCase();
  return CARRIER_CATALOG.find((c) => c.code === q || c.scac.some((s) => s.toLowerCase() === q));
}

/** Default method per transaction: API JSON, then API XML, then EDI. */
export function defaultMethods(entry: CarrierCatalogEntry): Partial<Record<TransactionType, IntegrationMethod>> {
  const out: Partial<Record<TransactionType, IntegrationMethod>> = {};
  for (const [tx, methods] of Object.entries(entry.methods) as Array<[TransactionType, IntegrationMethod[]]>) {
    const m = preferredMethod(methods);
    if (m) out[tx] = m;
  }
  return out;
}
