import { describe, expect, it } from "vitest";
import { NYC, api, harness, loadBody, signUp } from "./helpers.js";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), Buffer.alloc(200, 7)]);
const PDF = Buffer.from("%PDF-1.4\n%fake but starts right\n");
const scribble = (w: number, h: number) => [Array.from({ length: 40 }, (_, i) => [10 + i * ((w - 20) / 40), h / 2 + Math.sin(i / 3) * (h / 4)] as [number, number])];

describe("documents", () => {
  it("stores scans and PDFs, serves them only to people on the load or a signed link, and builds a signed POD", async () => {
    const h = await harness({ now: () => new Date("2026-10-06T14:00:00Z") });
    const sam = await signUp(h, "BUSINESS", "Shipper Sam");
    const S = api(h, sam);
    const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
    const F = api(h, await signUp(h, "CARRIER", "Owner Olga"));
    const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"] })).org;
    const ana = await signUp(h, "TRUCKER", "Ana");
    await F.post(`/v1/orgs/${fleet.id}/members`, { email: ana.email, roles: ["DRIVER"] }, 201);
    const A = api(h, ana);
    const outsider = await signUp(h, "BUSINESS", "Nosy Ned");
    const load = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
    await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
    await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [ana.accountId] });
    const pickup = load.stops[0].id;

    // The driver scans the BOL at pickup.
    const bol = await A.post(`/v1/loads/${load.id}/documents/upload`, { kind: "BOL", name: "BOL page 1", contentType: "image/jpeg", data: JPEG.toString("base64"), stopId: pickup }, 201);
    expect(bol).toMatchObject({ kind: "BOL", name: "BOL page 1", contentType: "image/jpeg", size: JPEG.length, stopId: pickup, url: `/v1/files/${bol.fileId}` });
    expect(bol.viewUrl).toMatch(new RegExp(`^/v1/files/${bol.fileId}\\?exp=\\d+&sig=[\\w-]+$`));
    await A.post(`/v1/loads/${load.id}/documents/upload`, { kind: "BOL", name: "Lies", contentType: "image/png", data: JPEG.toString("base64") }, 400);
    await A.post(`/v1/loads/${load.id}/documents/upload`, { kind: "OTHER", name: "Page", contentType: "image/svg+xml", data: Buffer.from("<svg onload=alert(1)>").toString("base64") }, 400);
    await A.post(`/v1/loads/${load.id}/documents/upload`, { kind: "OTHER", name: "Huge", contentType: "application/pdf", data: Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]).toString("base64") }, 413);
    await F.post(`/v1/loads/${load.id}/documents/upload`, { kind: "LUMPER_RECEIPT", name: "Lumper", contentType: "application/pdf", data: PDF.toString("base64") }, 201);
    await api(h, outsider).post(`/v1/loads/${load.id}/documents/upload`, { kind: "OTHER", name: "x", contentType: "application/pdf", data: PDF.toString("base64") }, 404);

    // Served: by signed link without a session, or to people on the load.
    const signed = await h.app.inject({ method: "GET", url: bol.viewUrl });
    expect(signed.statusCode).toBe(200);
    expect(signed.rawPayload.equals(JPEG)).toBe(true);
    expect(signed.headers).toMatchObject({ "content-type": "image/jpeg", "x-content-type-options": "nosniff" });
    expect(signed.headers["content-disposition"]).toBe('inline; filename="BOL page 1.jpg"');
    expect((await h.app.inject({ method: "GET", url: bol.viewUrl.replace(/sig=.{4}/, "sig=AAAA") })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "GET", url: `/v1/files/${bol.fileId}` })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "GET", url: `/v1/files/${bol.fileId}`, headers: { authorization: `Bearer ${outsider.token}` } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: `/v1/files/${bol.fileId}`, headers: { authorization: `Bearer ${sam.token}` } })).statusCode).toBe(200);
    const seen = await S.get(`/v1/loads/${load.id}`);
    expect(seen.documents.map((d: { name: string; viewUrl: string }) => [d.name, d.viewUrl.startsWith("/v1/files/")])).toEqual([["BOL page 1", true], ["Lumper", true]]);

    // Delivery signature: only at delivery, only from the driver or dispatch, and it must be a signature.
    const pod = { receiverName: "Jane <b>Dock</b>", width: 300, height: 120, strokes: scribble(300, 120), piecesReceived: 19, exceptions: "1 pallet crushed", geo: { lat: 29.7419, lng: -95.4614 } };
    await A.post(`/v1/loads/${load.id}/pod`, pod, 409);
    for (const code of ["ARRIVED_PICKUP", "LOADED", "ARRIVED_DELIVERY"]) await A.post(`/v1/loads/${load.id}/status`, { code });
    await S.post(`/v1/loads/${load.id}/pod`, pod, 403);
    await A.post(`/v1/loads/${load.id}/pod`, { ...pod, strokes: [[[10, 10], [12, 11]]] }, 400);
    const receipt = await A.post(`/v1/loads/${load.id}/pod`, pod, 201);
    expect(receipt).toMatchObject({ kind: "POD", contentType: "image/svg+xml", signedBy: "Jane <b>Dock</b>", stopId: load.stops[1].id, geo: pod.geo });
    const svg = (await h.app.inject({ method: "GET", url: receipt.viewUrl })).body;
    expect(svg).toContain("Received by Jane &lt;b&gt;Dock&lt;/b&gt;");
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("Pieces received: 19 of 20 · Exceptions: 1 pallet crushed");
    expect(svg).toMatch(/<path d="M[\d. ]+L[\d. ]+/);
    const thread = await S.get(`/v1/loads/${load.id}/messages`);
    expect(thread.at(-1).body).toBe("Delivery receipt signed by Jane <b>Dock</b>. Exceptions: 1 pallet crushed");

    // The invoice carries the paperwork.
    await A.post(`/v1/loads/${load.id}/status`, { code: "DELIVERED" });
    const { invoice } = await F.post(`/v1/loads/${load.id}/invoices`, {}, 201);
    const view = await S.get(`/v1/invoices/${invoice.id}`);
    expect(view.documents.map((d: { kind: string }) => d.kind)).toEqual(["BOL", "LUMPER_RECEIPT", "POD"]);
    expect(view.documents.every((d: { viewUrl: string }) => d.viewUrl.includes("sig="))).toBe(true);
  });
});
