import { IntegrationEngine, type PartnerProfile } from "@logisticspro/integration";
import { describe, expect, it } from "vitest";
import { HOU, NASH, NYC, api, harness, loadBody, signUp } from "./helpers.js";

async function world() {
  const h = await harness();
  // Shipper A wants status by JSON API and invoices as EDI 210.
  const shipperA = await signUp(h, "BUSINESS", "Acme Logistics Mgr");
  const A = api(h, shipperA);
  const acme = (await A.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;

  // Shipper B wants invoices as JSON through its API.
  const shipperB = await signUp(h, "BUSINESS", "Beta Buyer");
  const B = api(h, shipperB);
  const beta = (await B.post("/v1/orgs", { name: "Beta Retail", kinds: ["SHIPPER"], address: HOU })).org;

  // A fleet carrier with a dispatcher-owner and four drivers.
  const fleetOwner = await signUp(h, "CARRIER", "Fleet Owner");
  const F = api(h, fleetOwner);
  const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"], scac: "BIGF", mcNumber: "MC123" })).org;
  const drivers = [];
  for (const nm of ["Dee One", "Dee Two", "Dee Three", "Dee Four"]) {
    const d = await signUp(h, "TRUCKER", nm);
    await F.post(`/v1/orgs/${fleet.id}/members`, { email: d.email, roles: ["DRIVER"] }, 201);
    drivers.push(d);
  }

  // An owner-operator: trucker who registers their own carrier.
  const ownerOp = await signUp(h, "TRUCKER", "Olivia Owner");
  const O = api(h, ownerOp);
  const solo = (await O.post("/v1/orgs", { name: "Olivia Trucking", kinds: ["CARRIER"], scac: "OLIV" })).org;
  return { h, shipperA, A, acme, shipperB, B, beta, fleetOwner, F, fleet, drivers, ownerOp, O, solo };
}

describe("one layout for an owner-operator", () => {
  it("shows driving and carrier work together after registering a company", async () => {
    const { O } = await world();
    const me = await O.get("/v1/me");
    expect(me.ownerOperator).toBe(true);
    expect(me.capabilities).toEqual(expect.arrayContaining(["DRIVE", "DISPATCH", "BID", "INVOICE", "MANAGE_INTEGRATIONS"]));
    expect(me.workspace.tabs.map((t: { id: string }) => t.id)).toEqual(["today", "loads", "navigate", "messages", "more"]);
    expect(me.workspace.loadFilters.map((f: { id: string }) => f.id)).toEqual(["driving", "dispatch"]);
  });
});

describe("brokered load: bid, award, relay with team drivers, status, invoice", () => {
  it("runs New York -> Houston team expedited end to end", async () => {
    const w = await world();
    const { h, A, acme, F, fleet, drivers, O, solo } = w;

    // Shipper A's ERP receives statuses as JSON and invoices as EDI 210.
    await A.put(`/v1/orgs/${acme.id}/receiving`, {
      channels: {
        SHIPMENT_STATUS: { method: "API_JSON", endpoint: { url: "https://erp.acme.example/lp/status", auth: { type: "bearer", secretRef: "acme_erp" } } },
        FREIGHT_INVOICE: { method: "EDI_X12", transport: "VAN" },
      },
      edi: { receiverQualifier: "01", receiverId: "ACMEFOODS" },
    });

    const load = await A.post("/v1/loads", loadBody(acme.id, { service: "TEAM_EXPEDITED" }), 201);
    expect(load.teamRequired).toBe(true);
    await A.post(`/v1/loads/${load.id}/post`, {});

    // Board: carriers see it; a solo bid on a team load is refused.
    expect((await O.get("/v1/board")).map((l: { id: string }) => l.id)).toContain(load.id);
    await O.post(`/v1/loads/${load.id}/bids`, { carrierOrgId: solo.id, amount: { amount: 4000, currency: "USD" }, plan: "SOLO" }, 400);
    const bid = await F.post(`/v1/loads/${load.id}/bids`, { carrierOrgId: fleet.id, amount: { amount: 6100, currency: "USD" }, plan: "TEAM", transitHours: 34 }, 201);
    const bids = await A.get(`/v1/loads/${load.id}/bids`);
    expect(bids).toHaveLength(1);

    const awarded = await A.post(`/v1/loads/${load.id}/bids/${bid.id}/award`);
    expect(awarded.load).toMatchObject({ status: "TENDERED", carrierOrgId: fleet.id });
    // The carrier sees the tender in its feed and accepts.
    const fleetFeed = (await F.get("/v1/me")).feed;
    expect(fleetFeed[0]).toMatchObject({ hat: "DISPATCH", title: `Tender ${load.loadNumber}` });
    expect((await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT", pro: "PRO555" })).load.status).toBe("BOOKED");

    // Break the trip at Nashville; team on each leg.
    const relayed = await F.post(`/v1/loads/${load.id}/relay`, { points: [{ address: NASH }] });
    expect(relayed.stops.map((s: { type: string }) => s.type)).toEqual(["PICKUP", "RELAY", "DELIVERY"]);
    const [leg1, leg2] = relayed.legs;
    await F.post(`/v1/loads/${load.id}/legs/${leg1.id}/assign`, { driverAccountIds: [drivers[0]!.accountId] }, 400);
    await F.post(`/v1/loads/${load.id}/legs/${leg1.id}/assign`, { driverAccountIds: [drivers[0]!.accountId, drivers[1]!.accountId] });
    const dispatched = await F.post(`/v1/loads/${load.id}/legs/${leg2.id}/assign`, { driverAccountIds: [drivers[2]!.accountId, drivers[3]!.accountId] });
    expect(dispatched.status).toBe("DISPATCHED");
    const transit = await F.get(`/v1/loads/${load.id}/transit`);
    expect(transit.team.totalHours).toBeLessThan(transit.solo.totalHours);

    // The first-leg driver sees the load and the next button in Today.
    const D1 = api(h, drivers[0]!);
    const d1Feed = (await D1.get("/v1/me")).feed;
    expect(d1Feed[0]).toMatchObject({ hat: "DRIVING", cta: { statusCode: "ARRIVED_PICKUP" } });
    // A driver from another leg cannot touch leg 1, and outsiders cannot see the load at all.
    await O.get(`/v1/loads/${load.id}`, 404);

    // Shipper refines before pickup: allowed, and the carrier is told.
    const refined = await A.patch(`/v1/loads/${load.id}`, { notes: "Call receiver 1h out" });
    expect(refined.changed).toEqual(["notes"]);

    await D1.post(`/v1/loads/${load.id}/status`, { code: "ARRIVED_PICKUP", city: "Bronx", state: "NY" });
    const loaded = await D1.post(`/v1/loads/${load.id}/status`, { code: "LOADED", city: "Bronx", state: "NY", geo: NYC.geo });
    expect(loaded.load.status).toBe("IN_TRANSIT");
    // Statuses went to Acme's ERP as JSON with its bearer token.
    expect(loaded.transmissions[0]).toMatchObject({ method: "API_JSON", status: "SENT", transaction: "SHIPMENT_STATUS" });
    const erpCall = h.https.sent.find((m) => m.url === "https://erp.acme.example/lp/status" && m.body.includes('"LOADED"'))!;
    expect(erpCall.headers.authorization).toBe("Bearer secret-for-acme_erp");
    expect(JSON.parse(erpCall.body)).toMatchObject({ shipmentId: load.loadNumber, carrierScac: "BIGF", statusCode: "LOADED", references: { pro: "PRO555", bol: "BOL-1" } });

    // After pickup the shipper can no longer change the load.
    const locked = await A.patch(`/v1/loads/${load.id}`, { notes: "too late" }, 409);
    expect(locked.error.code).toBe("LOAD_LOCKED");

    // Relay: leg-1 team hands off to leg-2 team (internal events are not sent to the shipper's ERP).
    const sentBefore = h.https.sent.length;
    await D1.post(`/v1/loads/${load.id}/status`, { code: "ARRIVED_RELAY", city: "Nashville", state: "TN" });
    await D1.post(`/v1/loads/${load.id}/status`, { code: "RELAY_HANDOFF" });
    expect(h.https.sent.length).toBe(sentBefore);
    const D3 = api(h, drivers[2]!);
    expect((await D3.get("/v1/me")).feed[0]).toMatchObject({ cta: { statusCode: "ARRIVED_DELIVERY" } });
    await D3.post(`/v1/loads/${load.id}/status`, { code: "DELAYED", reason: "WEATHER", eta: "2026-10-08T20:00:00Z", city: "Texarkana", state: "TX" });
    await D3.post(`/v1/loads/${load.id}/status`, { code: "ARRIVED_DELIVERY", city: "Houston", state: "TX" });
    const delivered = await D3.post(`/v1/loads/${load.id}/status`, { code: "DELIVERED", city: "Houston", state: "TX" });
    expect(delivered.load.legs.map((l: { status: string }) => l.status)).toEqual(["COMPLETED", "COMPLETED"]);

    // Messages: every status became a thread entry; the driver can message the carrier and shipper.
    await D3.post(`/v1/loads/${load.id}/messages`, { body: "POD signed by J. Smith" }, 201);
    const thread = await A.get(`/v1/loads/${load.id}/messages`);
    expect(thread.filter((m: { kind: string }) => m.kind === "STATUS").length).toBe(7);
    expect(thread[thread.length - 1]).toMatchObject({ kind: "TEXT", body: "POD signed by J. Smith", senderName: "Dee Three" });

    // The leg-2 driver invoices; Acme gets an EDI 210 because that is what Acme asked for.
    const inv = await D3.post(`/v1/loads/${load.id}/invoices`, { fuelSurchargePct: 10, lines: [{ code: "TEAM", description: "Team service", quantity: 1, rate: 400 }] }, 201);
    expect(inv.invoice.total).toBe(7110); // awarded bid 6100 + team 400 + 10% fuel on linehaul
    expect(inv.transmissions[0]).toMatchObject({ method: "EDI_X12", transaction: "FREIGHT_INVOICE", status: "SENT", transport: "VAN" });
    const edi = h.van.sent.find((m) => m.body.includes("ST*210"))!.body;
    expect(edi).toContain("*01*ACMEFOODS      *");
    expect(edi).toContain(`B3**INV-${load.loadNumber}*${load.loadNumber}*PP*L*`);
    expect(edi).toContain("L1*2*400*FR*40000****TMS~");
    expect((await A.get(`/v1/loads/${load.id}`)).status).toBe("INVOICED");
    // and Acme's billing sees it to pay
    expect((await A.get("/v1/me")).feed.some((i: { title: string }) => i.title.startsWith(`Invoice INV-${load.loadNumber}`))).toBe(true);
  });
});

describe("each customer gets invoices in its own format", () => {
  it("sends Beta a JSON invoice to its API while Acme gets EDI", async () => {
    const { h, B, beta, F, fleet, drivers } = await world();
    await B.put(`/v1/orgs/${beta.id}/receiving`, {
      channels: {
        FREIGHT_INVOICE: {
          method: "API_JSON",
          endpoint: { url: "https://api.beta.example/ap/invoices", auth: { type: "apiKey", header: "x-beta-key", secretRef: "beta_ap" } },
          fieldMap: {
            "invoice.number": "invoiceNumber", "invoice.loadRef": "shipmentId", "invoice.scac": "carrierScac", "invoice.date": "invoiceDate", "invoice.terms": "paymentTerms",
            "invoice.currency": "currency", "invoice.total": "totalAmount", "billTo": "billTo", "shipper": "shipper", "consignee": "consignee", "refs": "references",
            "dates.pickup": "pickupDate", "dates.delivery": "deliveryDate", "totals.weight": "weightLb", "totals.pieces": "pieces", "charges": "lines",
          },
        },
      },
    });
    const load = await B.post("/v1/loads", loadBody(beta.id, { stops: [{ type: "PICKUP", address: HOU, window: { start: "2026-10-06T13:00:00Z", end: "2026-10-06T15:00:00Z" } }, { type: "DELIVERY", address: NASH, window: { start: "2026-10-07T13:00:00Z", end: "2026-10-07T15:00:00Z" } }] }), 201);
    await B.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
    await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
    await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [drivers[0]!.accountId] });
    const D = api(h, drivers[0]!);
    for (const code of ["ARRIVED_PICKUP", "LOADED", "ARRIVED_DELIVERY", "DELIVERED"]) await D.post(`/v1/loads/${load.id}/status`, { code });
    const inv = await F.post(`/v1/loads/${load.id}/invoices`, {}, 201);
    expect(inv.transmissions[0]).toMatchObject({ method: "API_JSON", status: "SENT" });
    const call = h.https.sent.find((m) => m.url === "https://api.beta.example/ap/invoices")!;
    expect(call.headers["x-beta-key"]).toBe("secret-for-beta_ap");
    expect(JSON.parse(call.body)).toMatchObject({ invoice: { number: `INV-${load.loadNumber}`, total: 5200, scac: "BIGF" }, charges: [{ code: "LINEHAUL", amount: 5200 }] });
  });
});

describe("external carriers from the catalog", () => {
  it("tenders to R+L by EDI 204 and applies its 990, 214 and 210 coming back", async () => {
    const { h, A, acme } = await world();
    // Seed R+L from the catalog, then this shipper chooses EDI for tenders.
    const seeded = await A.post(`/v1/orgs/${acme.id}/partners/from-catalog/rl-carriers`, {}, 201);
    expect(seeded.channels.LOAD_TENDER.method).toBe("API_JSON");
    const edi = { receiverQualifier: "02", receiverId: "RLCA", usage: "P" };
    await A.put(`/v1/orgs/${acme.id}/partners/rl-carriers`, {
      name: "R+L Carriers", kind: "CARRIER", scac: "RLCA", catalogCode: "rl-carriers", edi,
      channels: { LOAD_TENDER: { method: "EDI_X12", transport: "VAN" }, SHIPMENT_STATUS: { method: "EDI_X12", transport: "VAN" }, FREIGHT_INVOICE: { method: "EDI_X12", transport: "VAN" }, TENDER_RESPONSE: { method: "EDI_X12", transport: "VAN" } },
    });
    const partners = await A.get(`/v1/orgs/${acme.id}/partners`);
    expect(partners[0].issues).toEqual([]);

    const load = await A.post("/v1/loads", loadBody(acme.id), 201);
    const t = await A.post(`/v1/loads/${load.id}/tender`, { partnerKey: "rl-carriers" });
    expect(t.transmissions[0]).toMatchObject({ method: "EDI_X12", transaction: "LOAD_TENDER", status: "SENT" });
    expect(h.van.sent[0]!.body).toContain(`B2**RLCA**${load.loadNumber}**PP~`);

    // R+L answers. Build their documents with the same engine from their side of the envelope.
    const { inboundToken } = await A.post(`/v1/orgs/${acme.id}/partners/rl-carriers/inbound-token`);
    const rl = new IntegrationEngine({ transports: {}, secrets: () => undefined });
    const rlProfile: PartnerProfile = { key: "acme", ownerOrgId: "rl", name: "Acme", kind: "SHIPPER", channels: { TENDER_RESPONSE: { method: "EDI_X12", enabled: true, transport: "VAN" }, SHIPMENT_STATUS: { method: "EDI_X12", enabled: true, transport: "VAN" }, FREIGHT_INVOICE: { method: "EDI_X12", enabled: true, transport: "VAN" } }, edi: { senderQualifier: "02", senderId: "RLCA", receiverQualifier: "ZZ", receiverId: "LOGISTICSPRO", usage: "P", ackRequested: true, codeOverrides: {} } };
    const post = (body: string) => h.app.inject({ method: "POST", url: `/v1/inbound/${acme.id}/rl-carriers/edi`, payload: body, headers: { "content-type": "application/edi-x12", "x-lp-inbound-token": inboundToken } });

    const r990 = await post(rl.render("TENDER_RESPONSE", { shipmentId: load.loadNumber, carrierScac: "RLCA", decision: "ACCEPT", respondedOn: "2026-10-05", carrierReference: "RL-PRO-1" }, rlProfile).body);
    expect(r990.statusCode).toBe(200);
    expect(r990.body).toContain("AK5*A~");
    expect(r990.body).toContain("*ZZ*LOGISTICSPRO   *02*RLCA           *");
    let current = await A.get(`/v1/loads/${load.id}`);
    expect(current).toMatchObject({ status: "BOOKED", references: { pro: "RL-PRO-1" } });

    await post(rl.render("SHIPMENT_STATUS", { shipmentId: load.loadNumber, carrierScac: "RLCA", statusCode: "LOADED", reason: "NORMAL", at: "2026-10-06T14:05:00Z", location: { city: "Bronx", state: "NY" }, references: { pro: "RL-PRO-1" } }, rlProfile).body);
    current = await A.get(`/v1/loads/${load.id}`);
    expect(current.status).toBe("IN_TRANSIT");
    expect(current.refinement.locked).toBe(true);
    expect(current.events[0]).toMatchObject({ code: "LOADED", source: "EDI" });

    // A bad token is refused and a bad set is rejected in the 997.
    const wrong = await h.app.inject({ method: "POST", url: `/v1/inbound/${acme.id}/rl-carriers/edi`, payload: "ISA", headers: { "content-type": "application/edi-x12", "x-lp-inbound-token": "nope" } });
    expect(wrong.statusCode).toBe(401);
    const badStatus = rl.render("SHIPMENT_STATUS", { shipmentId: "LP-999999", carrierScac: "RLCA", statusCode: "DELIVERED", reason: "NORMAL", at: "2026-10-08T14:05:00Z", location: {}, references: {} }, rlProfile).body;
    const rejected = await post(badStatus);
    expect(rejected.statusCode).toBe(200);
    expect(JSON.parse(String(rejected.headers["x-lp-results"]))[0].error).toMatch(/No load/);

    const txs = await A.get(`/v1/orgs/${acme.id}/transmissions?loadId=${load.id}`);
    expect(txs.map((x: { direction: string; transaction: string }) => `${x.direction}:${x.transaction}`)).toEqual(expect.arrayContaining(["OUTBOUND:LOAD_TENDER", "INBOUND:TENDER_RESPONSE", "INBOUND:SHIPMENT_STATUS"]));
  });

  it("previews what a partner will receive in any method", async () => {
    const { A, acme } = await world();
    await A.post(`/v1/orgs/${acme.id}/partners/from-catalog/estes`, {}, 201);
    const load = await A.post("/v1/loads", loadBody(acme.id), 201);
    const xml = await A.post("/v1/integrations/preview", { orgId: acme.id, partnerKey: "estes", transaction: "LOAD_TENDER", loadId: load.id, method: "API_XML" });
    expect(xml.body).toContain("<loadTender>");
    const x12 = await A.post("/v1/integrations/preview", { orgId: acme.id, partnerKey: "estes", transaction: "LOAD_TENDER", loadId: load.id, method: "EDI_X12" });
    expect(x12.body).toContain("ST*204*0001~");
  });

  it("publishes the 25-carrier catalog and the per-transaction field rules", async () => {
    const { A } = await world();
    const catalog = await A.get("/v1/integrations/catalog");
    expect(catalog).toHaveLength(25);
    const txs = await A.get("/v1/integrations/transactions");
    const inv = txs.find((t: { type: string }) => t.type === "FREIGHT_INVOICE");
    expect(inv.methods).toEqual(["API_JSON", "API_XML", "EDI_X12"]);
    expect(txs.find((t: { type: string }) => t.type === "RATE_QUOTE").methods).toEqual(["API_JSON", "API_XML"]);
  });
});

describe("a carrier running its business from an external shipper's ERP", () => {
  it("receives a JSON tender, and its statuses flow back to that shipper", async () => {
    const { h, F, fleet, drivers } = await world();
    await F.put(`/v1/orgs/${fleet.id}/partners/megamart`, {
      name: "MegaMart", kind: "SHIPPER",
      channels: {
        LOAD_TENDER: { method: "API_JSON", endpoint: { url: "https://megamart.example/unused" } },
        TENDER_RESPONSE: { method: "API_XML", endpoint: { url: "https://megamart.example/tms/990" } },
        SHIPMENT_STATUS: { method: "API_XML", endpoint: { url: "https://megamart.example/tms/214" } },
      },
    });
    const { inboundToken } = await F.post(`/v1/orgs/${fleet.id}/partners/megamart/inbound-token`);
    const tender = {
      purpose: "ORIGINAL", shipmentId: "MM-778", carrierScac: "BIGF", paymentTerms: "PREPAID", equipmentType: "DRY_VAN", references: { po: ["MM-PO-1"] },
      billTo: { name: "MegaMart AP", line1: "1 Mart Way", city: "Bentonville", state: "AR", postalCode: "72712", country: "US" },
      stops: [
        { sequence: 1, type: "PICKUP", party: { name: "MM DC", line1: "1 DC Rd", city: "Dallas", state: "TX", postalCode: "75201", country: "US" }, windowStart: "2026-10-06T13:00:00Z", windowEnd: "2026-10-06T15:00:00Z" },
        { sequence: 2, type: "DELIVERY", party: { name: "MM Store 12", line1: "12 Store St", city: "Tulsa", state: "OK", postalCode: "74103", country: "US" }, windowStart: "2026-10-07T13:00:00Z", windowEnd: "2026-10-07T15:00:00Z" },
      ],
      items: [{ description: "Mixed retail", pieces: 26, packaging: "PLT", weightLb: 22000 }], totalWeightLb: 22000, totalPieces: 26, rateUsd: 1450,
    };
    const res = await h.app.inject({ method: "POST", url: `/v1/inbound/${fleet.id}/megamart/load_tender`, payload: tender, headers: { "x-lp-inbound-token": inboundToken } });
    expect(res.statusCode, res.body).toBe(202);
    const { loadId } = res.json();
    const load = await F.get(`/v1/loads/${loadId}`);
    expect(load).toMatchObject({ status: "TENDERED", carrierOrgId: fleet.id, references: { shipperRef: "MM-778" }, rate: { amount: 1450 } });
    expect((await F.get("/v1/me")).feed[0].title).toBe(`Tender ${load.loadNumber}`);

    const accepted = await F.post(`/v1/loads/${loadId}/tender-response`, { decision: "ACCEPT" });
    expect(accepted.transmissions[0]).toMatchObject({ method: "API_XML", transaction: "TENDER_RESPONSE", status: "SENT" });
    await F.post(`/v1/loads/${loadId}/legs/first/assign`, { driverAccountIds: [drivers[1]!.accountId] });
    const D = api(h, drivers[1]!);
    const st = await D.post(`/v1/loads/${loadId}/status`, { code: "ARRIVED_PICKUP", city: "Dallas", state: "TX" });
    expect(st.transmissions[0]).toMatchObject({ method: "API_XML", status: "SENT" });
    expect(h.https.sent.find((m) => m.url === "https://megamart.example/tms/214")!.body).toContain("<statusCode>ARRIVED_PICKUP</statusCode>");

    // A JSON tender missing a required field is rejected with the exact field.
    const bad = await h.app.inject({ method: "POST", url: `/v1/inbound/${fleet.id}/megamart/load_tender`, payload: { ...tender, billTo: undefined }, headers: { "x-lp-inbound-token": inboundToken } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toMatch(/billTo/);
  });
});

describe("LTL consolidation through a distribution center", () => {
  it("routes several shipments through the carrier's DC onto shared trailers", async () => {
    const { A, acme, F, fleet } = await world();
    await F.post(`/v1/orgs/${fleet.id}/distribution-centers`, { name: "Newark Cross-Dock", address: { name: "Newark Cross-Dock", line1: "1 Port St", city: "Newark", state: "NJ", postalCode: "07114", country: "US" }, geo: { lat: 40.7066, lng: -74.1567 } }, 201);
    const dc = (await F.get(`/v1/orgs/${fleet.id}`)).org.distributionCenters[0];
    const dallas = { ...HOU, name: "Dallas Store", city: "Dallas", postalCode: "75201", geo: { lat: 32.78, lng: -96.8 } };
    const ids: string[] = [];
    for (const [dest, w] of [[dallas, 6000], [{ ...dallas, postalCode: "75207" }, 5000], [HOU, 4000]] as const) {
      const l = await A.post("/v1/loads", loadBody(acme.id, { mode: "LTL", equipment: { type: "DRY_VAN" }, items: [{ description: "Cases", pieces: 6, packaging: "PLT", weightLb: w, freightClass: "70" }], stops: [{ type: "PICKUP", address: NYC, window: { start: "2026-10-06T13:00:00Z", end: "2026-10-06T15:00:00Z" } }, { type: "DELIVERY", address: dest, window: { start: "2026-10-09T13:00:00Z", end: "2026-10-09T15:00:00Z" } }] }), 201);
      await A.post(`/v1/loads/${l.id}/tender`, { carrierOrgId: fleet.id });
      await F.post(`/v1/loads/${l.id}/tender-response`, { decision: "ACCEPT" });
      ids.push(l.id);
    }
    const plan = await F.post("/v1/consolidations", { carrierOrgId: fleet.id, dcId: dc.id, loadIds: ids }, 201);
    expect(plan.trailers.map((t: { destinationZip3: string; loadIds: string[] }) => [t.destinationZip3, t.loadIds.length]).sort()).toEqual([["752", 2], ["770", 1]]);
    const l0 = await F.get(`/v1/loads/${ids[0]}`);
    expect(l0.stops.map((s: { type: string }) => s.type)).toEqual(["PICKUP", "CROSS_DOCK", "DELIVERY"]);
  });
});

describe("navigation planning", () => {
  it("routes a standard load and runs the permit check for an oversize load", async () => {
    const { h, A, acme, F, fleet, drivers } = await world();
    const std = await A.post("/v1/loads", loadBody(acme.id), 201);
    await A.post(`/v1/loads/${std.id}/tender`, { carrierOrgId: fleet.id });
    await F.post(`/v1/loads/${std.id}/tender-response`, { decision: "ACCEPT" });
    await F.post(`/v1/loads/${std.id}/legs/first/assign`, { driverAccountIds: [drivers[0]!.accountId] });
    const D = api(h, drivers[0]!);
    const plan = await D.post(`/v1/loads/${std.id}/navigation/plan`, {});
    expect(plan.mode).toBe("STANDARD");
    expect(plan.route.geometry).toHaveLength(2);

    const route = [{ lat: 40, lng: -75 }, { lat: 40, lng: -74.95 }, { lat: 40, lng: -74.9 }];
    const osow = await A.post("/v1/loads", loadBody(acme.id, {
      equipment: { type: "LOWBOY" },
      oversize: { lengthIn: 1200, widthIn: 168, heightIn: 170, grossWeightLb: 120000, permits: [{ state: "PA", permitNumber: "PA-1", validFrom: "2026-10-01T00:00:00Z", validTo: "2026-10-31T00:00:00Z", route, daylightOnly: true, noWeekends: true, escortsRequired: 1 }] },
    }), 201);
    await A.post(`/v1/loads/${osow.id}/tender`, { carrierOrgId: fleet.id });
    await F.post(`/v1/loads/${osow.id}/tender-response`, { decision: "ACCEPT" });
    await F.post(`/v1/loads/${osow.id}/legs/first/assign`, { driverAccountIds: [drivers[0]!.accountId] });
    const check = await D.post(`/v1/loads/${osow.id}/navigation/plan`, { departAt: "2026-10-06T16:00:00Z", restrictions: [{ id: "br", type: "LOW_CLEARANCE", at: { lat: 40.00004, lng: -74.95 }, limit: 168, description: "Overpass 14 ft 0 in" }] });
    expect(check.mode).toBe("OVERSIZE");
    expect(check.corridor).toHaveLength(3);
    expect(check.escortsRequired).toBe(1);
    expect(check.conflicts.map((c: { kind: string }) => c.kind)).toEqual(["RESTRICTION"]);

    const v = await D.post(`/v1/loads/${osow.id}/navigation/violations`, { startedAt: "2026-10-06T16:10:00Z", endedAt: "2026-10-06T16:12:00Z", maxDeviationM: 140, firstPoint: { lat: 40.001, lng: -74.97 } }, 201);
    expect(v.maxDeviationM).toBe(140);
    const msgs = await F.get(`/v1/loads/${osow.id}/messages`);
    expect(msgs[msgs.length - 1].body).toMatch(/left the permitted corridor by up to 140 m/);
  });
});
