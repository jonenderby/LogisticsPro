import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeLoad } from "../../domain/test/fixtures.js";
import {
  CARRIER_CATALOG,
  IntegrationEngine,
  MemoryTransport,
  OutboxTransport,
  defaultMethods,
  fieldMapCoverage,
  findCarrier,
  invoiceDoc,
  profileFromCatalog,
  statusFromEvent,
  tenderFromLoad,
  validateDoc,
  validateProfile,
} from "../src/index.js";
import { buildInvoice } from "@logisticspro/domain";
import { invoice, profile, status } from "./fixtures.js";

const now = () => new Date("2026-10-05T12:00:00Z");

/** A partner that wants its own JSON field names. */
const statusMap = {
  "proNumber": "references.pro",
  "loadId": "shipmentId",
  "scac": "carrierScac",
  "event.code": "statusCode",
  "event.reason": "reason",
  "event.timestamp": "at",
  "event.eta": "eta",
  "event.position": "location",
  "refs": "references",
  "stop": "stopSequence",
  "trailer": "equipmentNumber",
};

describe("per-partner field maps", () => {
  it("renders the partner's own shape and parses it back to canonical", () => {
    const engine = new IntegrationEngine({ transports: {}, secrets: () => "k", now });
    const p = profile("API_JSON");
    p.channels.SHIPMENT_STATUS = { ...p.channels.SHIPMENT_STATUS!, fieldMap: statusMap };
    const body = engine.render("SHIPMENT_STATUS", status, p).body;
    const json = JSON.parse(body);
    expect(json.loadId).toBe("LP-1001");
    expect(json.event.code).toBe("DELAYED");
    expect(json.event.position.city).toBe("Nashville");
    expect(engine.parseApi("SHIPMENT_STATUS", "API_JSON", body, p.channels.SHIPMENT_STATUS)).toEqual(status);
  });

  it("maps array elements with []", () => {
    const engine = new IntegrationEngine({ transports: {}, secrets: () => "k", now });
    const p = profile("API_XML");
    const invoiceMap: Record<string, string> = {
      "header.number": "invoiceNumber", "header.load": "shipmentId", "header.scac": "carrierScac", "header.date": "invoiceDate",
      "header.terms": "paymentTerms", "header.currency": "currency", "header.total": "totalAmount",
      "parties.billTo": "billTo", "parties.shipper": "shipper", "parties.consignee": "consignee", "refs": "references",
      "dates.pickup": "pickupDate", "dates.delivery": "deliveryDate", "totals.weight": "weightLb", "totals.pieces": "pieces",
      "charges[].type": "lines[].code", "charges[].text": "lines[].description", "charges[].qty": "lines[].quantity", "charges[].rate": "lines[].rate", "charges[].amount": "lines[].amount",
    };
    p.channels.FREIGHT_INVOICE = { ...p.channels.FREIGHT_INVOICE!, fieldMap: invoiceMap, xmlRoot: "CarrierInvoice" };
    expect(validateProfile(p)).toEqual([]);
    const body = engine.render("FREIGHT_INVOICE", invoice, p).body;
    expect(body).toContain("<CarrierInvoice>");
    expect(body).toMatch(/<charges>\s*<charge>\s*<type>LINEHAUL<\/type>/);
    expect(engine.parseApi("FREIGHT_INVOICE", "API_XML", body, p.channels.FREIGHT_INVOICE)).toEqual(invoice);
  });

  it("refuses a field map that drops a required field", () => {
    const { lines: _drop, ...rest } = { ...statusMap, lines: "" };
    const partial = { ...rest } as Record<string, string>;
    delete partial["event.timestamp"];
    expect(fieldMapCoverage("SHIPMENT_STATUS", partial).missingRequired).toEqual(["at"]);
    const p = profile("API_JSON");
    p.channels.SHIPMENT_STATUS = { ...p.channels.SHIPMENT_STATUS!, fieldMap: partial };
    expect(validateProfile(p).map((i) => i.message)).toContain("field map does not carry required field at");
  });
});

describe("delivery", () => {
  it("sends API payloads with resolved credentials and records the transmission", async () => {
    const https = new MemoryTransport();
    const engine = new IntegrationEngine({ transports: { HTTPS: https }, secrets: (ref) => (ref === "partner_key" ? "abc123" : undefined), now });
    const t = await engine.send("FREIGHT_INVOICE", invoice, profile("API_JSON"), { invoiceId: "inv_1" });
    expect(t.status).toBe("SENT");
    expect(https.sent[0]!.headers["x-api-key"]).toBe("abc123");
    expect(https.sent[0]!.contentType).toBe("application/json");
    expect(t.refs.invoiceId).toBe("inv_1");
  });

  it("fails cleanly when a secret is missing", async () => {
    const engine = new IntegrationEngine({ transports: { HTTPS: new MemoryTransport() }, secrets: () => undefined, now });
    const t = await engine.send("FREIGHT_INVOICE", invoice, profile("API_JSON"));
    expect(t.status).toBe("FAILED");
    expect(t.error).toMatch(/secret "partner_key"/);
  });

  it("drops EDI into the VAN outbox for the gateway to pick up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lp-outbox-"));
    const engine = new IntegrationEngine({ transports: { VAN: new OutboxTransport(dir) }, secrets: () => undefined, now });
    const t = await engine.send("FREIGHT_INVOICE", invoice, profile("EDI_X12"));
    expect(t.status).toBe("SENT");
    const written = await readFile(t.response!.body!, "utf8");
    expect(written).toContain("ST*210*0001~");
  });

  it("records a validation failure instead of sending", async () => {
    const https = new MemoryTransport();
    const engine = new IntegrationEngine({ transports: { HTTPS: https }, secrets: () => "k", now });
    const t = await engine.send("FREIGHT_INVOICE", { ...invoice, lines: [] }, profile("API_JSON"));
    expect(t.status).toBe("FAILED");
    expect(t.error).toMatch(/lines/);
    expect(https.sent).toHaveLength(0);
  });
});

describe("carrier catalog", () => {
  it("covers 25 carriers with unique codes", () => {
    expect(CARRIER_CATALOG).toHaveLength(25);
    expect(new Set(CARRIER_CATALOG.map((c) => c.code)).size).toBe(25);
    for (const c of CARRIER_CATALOG) expect(Object.keys(c.methods).length).toBeGreaterThan(0);
  });

  it("prefers API JSON, then API XML, then EDI", () => {
    expect(defaultMethods(findCarrier("estes")!).RATE_QUOTE).toBe("API_JSON");
    expect(defaultMethods(findCarrier("aaa-cooper")!).RATE_QUOTE).toBe("API_XML");
    expect(defaultMethods(findCarrier("RLCA")!).LOAD_TENDER).toBe("API_JSON");
    expect(defaultMethods(findCarrier("rl-carriers")!).FREIGHT_INVOICE).toBe("EDI_X12");
    expect(defaultMethods(findCarrier("knight-swift")!).LOAD_TENDER).toBe("EDI_X12");
  });

  it("seeds a profile that still needs onboarding details", () => {
    const p = profileFromCatalog(findCarrier("estes")!, "org_shipper");
    expect(p.channels.LOAD_TENDER!.method).toBe("API_JSON");
    const issues = validateProfile(p).map((i) => i.message);
    expect(issues).toContain("HTTPS channel needs an endpoint URL");
    expect(issues).toContain("EDI channel needs interchange settings (sender/receiver ids)");
  });

  it("lets a business switch a carrier to EDI per transaction", () => {
    const p = profileFromCatalog(findCarrier("rl-carriers")!, "org_shipper", { LOAD_TENDER: { method: "EDI_X12", transport: "VAN" } });
    expect(p.channels.LOAD_TENDER!.method).toBe("EDI_X12");
  });
});

describe("domain -> canonical builders", () => {
  it("builds valid tender, status and invoice documents from a load", () => {
    const load = makeLoad();
    const t = validateDoc("LOAD_TENDER", tenderFromLoad(load, "ACME"));
    expect(t.stops).toHaveLength(2);
    expect(t.totalWeightLb).toBe(38000);

    const delivered = { ...makeLoad(), status: "DELIVERED" as const, pickedUpAt: "2026-10-06T14:00:00Z", deliveredAt: "2026-10-08T15:00:00Z" };
    const inv = buildInvoice(delivered, { orgId: "org_carrier", scac: "ACME" }, "acct_1", { fuelSurchargePct: 10 }, "2026-10-09T00:00:00Z");
    const doc = validateDoc("FREIGHT_INVOICE", invoiceDoc(inv, "PREPAID", load.loadNumber));
    expect(doc.totalAmount).toBe(5720);

    const s = statusFromEvent(load, { id: "e1", code: "LOADED", at: "2026-10-06T14:03:27Z", source: "APP", geo: { lat: 40.8, lng: -73.9 } }, "ACME");
    expect(validateDoc("SHIPMENT_STATUS", s).at).toBe("2026-10-06T14:03:00Z");
    expect(statusFromEvent(load, { id: "e2", code: "RELAY_HANDOFF", at: "2026-10-07T00:00:00Z", source: "APP" }, "ACME")).toBeUndefined();
  });
});
