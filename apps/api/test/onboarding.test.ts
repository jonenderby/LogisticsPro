import { IntegrationEngine, type PartnerProfile } from "@logisticspro/integration";
import { describe, expect, it } from "vitest";
import { NYC, api, harness, loadBody, signUp } from "./helpers.js";

describe("carrier onboarding", () => {
  it("tests each channel in EDI test mode, waits for the 997 and the partner's replies, then goes live", async () => {
    const h = await harness({ secrets: (ref) => (ref === "rl_api" ? "set" : undefined) });
    const A = api(h, await signUp(h, "BUSINESS", "Integrations Ivy"));
    const acme = (await A.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
    await A.put(`/v1/orgs/${acme.id}/partners/rl-carriers`, {
      name: "R+L Carriers",
      kind: "CARRIER",
      scac: "RLCA",
      channels: {
        LOAD_TENDER: { method: "EDI_X12", transport: "VAN" },
        TENDER_RESPONSE: { method: "EDI_X12", transport: "VAN" },
        SHIPMENT_STATUS: { method: "API_JSON", endpoint: { url: "https://api.rlc.example/status", auth: { type: "bearer", secretRef: "rl_api" } } },
        PICKUP_REQUEST: { method: "API_JSON", endpoint: { url: "https://api.rlc.example/pickups", auth: { type: "bearer", secretRef: "rl_pickups" } } },
      },
      edi: { senderQualifier: "ZZ", senderId: "LOGISTICSPRO", receiverQualifier: "02", receiverId: "RLCA", usage: "T", ackRequested: true },
    });
    const url = `/v1/orgs/${acme.id}/partners/rl-carriers`;
    const state = async () => Object.fromEntries((await A.get(`${url}/onboarding`)).items.map((i: { id: string; state: string }) => [i.id, i.state]));

    expect(await state()).toEqual({
      settings: "DONE",
      credentials: "TODO", // rl_pickups isn't set on the server
      "test:LOAD_TENDER": "TODO",
      "received:TENDER_RESPONSE": "TODO",
      "received:SHIPMENT_STATUS": "TODO",
      "test:PICKUP_REQUEST": "TODO",
      inbound: "TODO",
      live: "TODO",
    });
    expect((await A.get(`${url}/onboarding`)).items.find((i: { id: string }) => i.id === "credentials").detail).toBe("Set LP_SECRET_RL_PICKUPS on the server");
    expect((await A.post(`${url}/go-live`, {}, 409)).error.message).toMatch(/^Finish first: Credentials, Test: Motor carrier load tender/);

    // Tests: the 204 goes in test mode through the VAN; the pickup API call fails without its credential.
    const run = await A.post(`${url}/test`, {});
    expect(run.sent.map((s: { transaction: string; status: string }) => [s.transaction, s.status])).toEqual([["LOAD_TENDER", "SENT"], ["PICKUP_REQUEST", "FAILED"]]);
    const edi = h.van.sent.at(-1)!.body;
    expect(edi.split("~")[0]!.split("*")[15]).toBe("T");
    expect(edi).toContain("B2**RLCA**TEST-0001**PP~");
    let items = (await A.get(`${url}/onboarding`)).items;
    expect(items.find((i: { id: string }) => i.id === "test:LOAD_TENDER")).toMatchObject({ state: "TODO", detail: "Test sent; waiting for the partner's 997" });
    expect(items.find((i: { id: string }) => i.id === "test:PICKUP_REQUEST")).toMatchObject({ state: "PROBLEM", detail: 'secret "rl_pickups" is not configured' });

    // R+L acknowledges and answers our test tender by EDI, and posts a test status by API.
    const { inboundToken } = await A.post(`${url}/inbound-token`);
    const rl = new IntegrationEngine({ transports: {}, secrets: () => undefined });
    const ack = rl.parseEdi(edi).ack997!;
    const rlProfile: PartnerProfile = { key: "acme", ownerOrgId: "rl", name: "Acme", kind: "SHIPPER", channels: { TENDER_RESPONSE: { method: "EDI_X12", enabled: true, transport: "VAN" } }, edi: { senderQualifier: "02", senderId: "RLCA", receiverQualifier: "ZZ", receiverId: "LOGISTICSPRO", usage: "T", ackRequested: true, codeOverrides: {} } };
    const post = (path: string, body: unknown, type: string) => h.app.inject({ method: "POST", url: `/v1/inbound/${acme.id}/rl-carriers/${path}`, payload: body as string, headers: { "content-type": type, "x-lp-inbound-token": inboundToken } });
    expect((await post("edi", ack, "application/edi-x12")).statusCode).toBe(200);
    expect((await post("edi", rl.render("TENDER_RESPONSE", { shipmentId: "TEST-0001", carrierScac: "RLCA", decision: "ACCEPT", respondedOn: "2026-10-06" }, rlProfile).body, "application/edi-x12")).statusCode).toBe(200);
    const status = await post("shipment_status", { shipmentId: "TEST-0001", carrierScac: "RLCA", statusCode: "LOADED", reason: "NORMAL", at: "2026-10-06T14:00:00Z", location: { city: "Memphis", state: "TN" }, references: {} }, "application/json");
    expect(status.json()).toEqual({ action: "test received" });
    // Test traffic never touches real loads.
    expect([...h.ctx.store.loads.values()]).toEqual([]);

    // Drop the pickup channel we can't test yet; then everything is done.
    await A.put(url, { name: "R+L Carriers", kind: "CARRIER", scac: "RLCA", channels: { LOAD_TENDER: { method: "EDI_X12", transport: "VAN" }, TENDER_RESPONSE: { method: "EDI_X12", transport: "VAN" }, SHIPMENT_STATUS: { method: "API_JSON", endpoint: { url: "https://api.rlc.example/status", auth: { type: "bearer", secretRef: "rl_api" } } } }, edi: { senderQualifier: "ZZ", senderId: "LOGISTICSPRO", receiverQualifier: "02", receiverId: "RLCA", usage: "T", ackRequested: true } });
    expect(await state()).toEqual({ settings: "DONE", credentials: "DONE", "test:LOAD_TENDER": "DONE", "received:TENDER_RESPONSE": "DONE", "received:SHIPMENT_STATUS": "DONE", inbound: "DONE", live: "TODO" });

    // Live: real tenders go in production mode with fresh control numbers.
    const live = await A.post(`${url}/go-live`, {});
    expect(live).toMatchObject({ ready: true, live: true });
    const load = await A.post("/v1/loads", loadBody(acme.id), 201);
    await A.post(`/v1/loads/${load.id}/tender`, { partnerKey: "rl-carriers" });
    const real = h.van.sent.at(-1)!.body;
    expect(real.split("~")[0]!.split("*")[15]).toBe("P");
    expect(real.split("~")[0]!.split("*")[13]).not.toBe(edi.split("~")[0]!.split("*")[13]);
    // Back to test mode for re-certification.
    expect((await A.post(`${url}/back-to-test`, {})).live).toBe(false);
  });
});
