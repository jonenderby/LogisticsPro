import { type As2PartnerSettings, as2 } from "@logisticspro/integration";
import { describe, expect, it } from "vitest";
import { STATION, api, harness, loadBody, signUp } from "./helpers.js";

const RL = as2.generateAs2Identity("RLCARRIERS");
const rlSees = (over: Partial<As2PartnerSettings> = {}): As2PartnerSettings => ({ as2Id: "LOGISTICSPRO", url: "https://lp.example/as2", certificatePem: STATION.certificatePem, encryption: "aes256-CBC", signing: "sha256", mdn: "signed", ...over });
const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

/** A stand-in for R+L's AS2 server: decrypts, verifies, answers with a signed MDN, and keeps what it got. */
function rlServer(inbox: string[]) {
  return async (_url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
    const got = as2.receiveAs2(lower(init.headers), Buffer.from(init.body), RL, () => rlSees());
    inbox.push(got.payload.toString());
    const mdn = as2.buildMdn({ us: RL, partnerAs2Id: got.from, originalMessageId: got.messageId, mic: got.mic, sign: true });
    return { ok: true, status: 200, headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? mdn.headers["Content-Type"]! : null) }, arrayBuffer: async () => new Uint8Array(mdn.body).buffer };
  };
}

describe("central AS2 station", () => {
  it("publishes one station identity for partners to trust", async () => {
    const h = await harness();
    const S = api(h, await signUp(h, "BUSINESS", "Station Viewer"));
    const info = await S.get("/v1/integrations/as2");
    expect(info).toMatchObject({ as2Id: "LOGISTICSPRO", url: "http://localhost:8080/as2" });
    expect(info.fingerprintSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const pem = await h.app.inject({ method: "GET", url: "/as2/certificate" });
    expect(pem.body).toBe(STATION.certificatePem);
  });

  it("tenders over AS2, receives the 990 and 214 back, and acknowledges with a 997", async () => {
    const inbox: string[] = [];
    const h = await harness({ as2Fetch: rlServer(inbox) });
    const A = api(h, await signUp(h, "BUSINESS", "AS2 Shipper"));
    const acme = (await A.post("/v1/orgs", { name: "Acme AS2", kinds: ["SHIPPER"] })).org;
    await A.put(`/v1/orgs/${acme.id}/partners/rl`, {
      name: "R+L Carriers", kind: "CARRIER", scac: "RLCA",
      edi: { receiverQualifier: "02", receiverId: "RLCA" },
      as2: { as2Id: "RLCARRIERS", url: "https://as2.rlcarriers.example/as2", certificatePem: RL.certificatePem },
      channels: { LOAD_TENDER: { method: "EDI_X12", transport: "AS2" }, TENDER_RESPONSE: { method: "EDI_X12", transport: "AS2" }, SHIPMENT_STATUS: { method: "EDI_X12", transport: "AS2" } },
    });
    expect((await A.get(`/v1/orgs/${acme.id}/partners`))[0].issues).toEqual([]);

    const load = await A.post("/v1/loads", loadBody(acme.id), 201);
    const t = await A.post(`/v1/loads/${load.id}/tender`, { partnerKey: "rl" });
    expect(t.transmissions[0]).toMatchObject({ transport: "AS2", status: "SENT" });
    expect(JSON.parse(t.transmissions[0].response.body)).toMatchObject({ micMatched: true, signedReceipt: true });
    expect(inbox[0]).toContain(`B2**RLCA**${load.loadNumber}**PP~`);

    // R+L answers through the central station.
    const engine = h.ctx.engine;
    const rlProfile = { key: "lp", ownerOrgId: "rl", name: "Logistics Pro", kind: "SHIPPER" as const, channels: { TENDER_RESPONSE: { method: "EDI_X12" as const, enabled: true, transport: "AS2" as const }, SHIPMENT_STATUS: { method: "EDI_X12" as const, enabled: true, transport: "AS2" as const } }, edi: { senderQualifier: "02", senderId: "RLCA", receiverQualifier: "ZZ", receiverId: "LOGISTICSPRO", usage: "P" as const, ackRequested: true, codeOverrides: {} } };
    const send = async (x12: string, from = RL) => {
      const msg = as2.buildAs2Message(Buffer.from(x12), { contentType: "application/edi-x12", filename: "rl.x12", us: from, partner: { ...rlSees(), as2Id: "LOGISTICSPRO" } });
      const res = await h.app.inject({ method: "POST", url: "/as2", headers: msg.headers, payload: msg.body });
      return { res, msg, mdn: as2.parseMdn(String(res.headers["content-type"]), res.rawPayload, STATION.certificatePem) };
    };
    const r990 = await send(engine.render("TENDER_RESPONSE", { shipmentId: load.loadNumber, carrierScac: "RLCA", decision: "ACCEPT", respondedOn: "2026-10-05", carrierReference: "RL-PRO-9" }, rlProfile).body);
    expect(r990.res.statusCode).toBe(200);
    expect(r990.mdn).toMatchObject({ signed: true, processed: true });
    expect(as2.micMatches(r990.mdn.mic, r990.msg.mic)).toBe(true);
    expect(await A.get(`/v1/loads/${load.id}`)).toMatchObject({ status: "BOOKED", references: { pro: "RL-PRO-9" } });
    // The 990 is the carrier's signature on the rate confirmation.
    const rc = (await A.get(`/v1/loads/${load.id}/rate-confirmation`)).current;
    expect(rc).toMatchObject({ version: 1, status: "SIGNED", carrier: { partnerKey: "rl" }, references: { pro: "RL-PRO-9" } });
    expect(rc.signatures.map((x: { side: string; method: string }) => `${x.side}:${x.method}`)).toEqual(["TENDERING:TENDER", "CARRIER:PARTNER_RESPONSE"]);

    await send(engine.render("SHIPMENT_STATUS", { shipmentId: load.loadNumber, carrierScac: "RLCA", statusCode: "LOADED", reason: "NORMAL", at: "2026-10-06T14:05:00Z", location: { city: "Bronx", state: "NY" }, references: {} }, rlProfile).body);
    expect((await A.get(`/v1/loads/${load.id}`)).status).toBe("IN_TRANSIT");

    // The 997 goes back to R+L as its own AS2 message.
    await new Promise((r) => setTimeout(r, 50));
    expect(inbox.filter((m) => m.includes("ST*997*"))).toHaveLength(2);
    const txs = await A.get(`/v1/orgs/${acme.id}/transmissions?loadId=${load.id}`);
    expect(txs.filter((x: { transport: string; direction: string }) => x.transport === "AS2" && x.direction === "INBOUND")).toHaveLength(2);

    // An impostor signing as R+L gets an error receipt and changes nothing.
    const impostor = as2.generateAs2Identity("RLCARRIERS");
    const bad = await send(engine.render("SHIPMENT_STATUS", { shipmentId: load.loadNumber, carrierScac: "RLCA", statusCode: "DELIVERED", reason: "NORMAL", at: "2026-10-08T14:05:00Z", location: {}, references: {} }, rlProfile).body, impostor);
    expect(bad.mdn).toMatchObject({ processed: false, error: "integrity-check-failed" });
    expect((await A.get(`/v1/loads/${load.id}`)).status).toBe("IN_TRANSIT");
  });

  it("routes one partner's messages to the right business when several share the connection", async () => {
    const h = await harness({ as2Fetch: rlServer([]) });
    const make = async (name: string) => {
      const S = api(h, await signUp(h, "BUSINESS", name));
      const org = (await S.post("/v1/orgs", { name, kinds: ["SHIPPER"] })).org;
      await S.put(`/v1/orgs/${org.id}/partners/rl`, { name: "R+L", kind: "CARRIER", scac: "RLCA", edi: { receiverQualifier: "02", receiverId: "RLCA" }, as2: { as2Id: "RLCARRIERS", url: "https://as2.rl.example/as2", certificatePem: RL.certificatePem }, channels: { LOAD_TENDER: { method: "EDI_X12", transport: "AS2" } } });
      const load = await S.post("/v1/loads", loadBody(org.id), 201);
      await S.post(`/v1/loads/${load.id}/tender`, { partnerKey: "rl" });
      return { S, load };
    };
    const one = await make("Shipper One");
    const two = await make("Shipper Two");
    const prof = { key: "lp", ownerOrgId: "rl", name: "LP", kind: "SHIPPER" as const, channels: { TENDER_RESPONSE: { method: "EDI_X12" as const, enabled: true, transport: "AS2" as const } }, edi: { senderQualifier: "02", senderId: "RLCA", receiverQualifier: "ZZ", receiverId: "LOGISTICSPRO", usage: "P" as const, ackRequested: false, codeOverrides: {} } };
    const x12 = h.ctx.engine.render("TENDER_RESPONSE", { shipmentId: two.load.loadNumber, carrierScac: "RLCA", decision: "ACCEPT", respondedOn: "2026-10-05" }, prof).body;
    const msg = as2.buildAs2Message(Buffer.from(x12), { contentType: "application/edi-x12", filename: "990.x12", us: RL, partner: rlSees() });
    const res = await h.app.inject({ method: "POST", url: "/as2", headers: msg.headers, payload: msg.body });
    expect(JSON.parse(String(res.headers["x-lp-results"]))[0]).toMatchObject({ action: "booked" });
    expect((await two.S.get(`/v1/loads/${two.load.id}`)).status).toBe("BOOKED");
    expect((await one.S.get(`/v1/loads/${one.load.id}`)).status).toBe("TENDERED");
  });
});
