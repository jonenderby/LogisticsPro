import { describe, expect, it } from "vitest";
import { NYC, api, harness, loadBody, signUp } from "./helpers.js";

// loadBody: pickup window 2026-10-06 13:00-15:00Z, delivery 2026-10-08 14:00-18:00Z.
async function world() {
  let now = Date.parse("2026-10-05T12:00:00Z");
  const h = await harness({ now: () => new Date(now) });
  const at = (iso: string) => (now = Date.parse(iso));
  const S = api(h, await signUp(h, "BUSINESS", "Shipper Sam"));
  const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
  const A = api(h, await signUp(h, "CARRIER", "Alpha Owner"));
  const alpha = (await A.post("/v1/orgs", { name: "Alpha Freight", kinds: ["CARRIER"], scac: "ALFA" })).org;
  const B = api(h, await signUp(h, "CARRIER", "Bravo Owner"));
  const bravo = (await B.post("/v1/orgs", { name: "Bravo Lines", kinds: ["CARRIER"], scac: "BRVO" })).org;
  // Dana drives for both carriers.
  const dana = await signUp(h, "TRUCKER", "Dana");
  await A.post(`/v1/orgs/${alpha.id}/members`, { email: dana.email, roles: ["DRIVER"] }, 201);
  await B.post(`/v1/orgs/${bravo.id}/members`, { email: dana.email, roles: ["DRIVER"] }, 201);
  const D = api(h, dana);
  const book = async (carrier: ReturnType<typeof api>, carrierOrgId: string, loadId?: string) => {
    const load = loadId ? { id: loadId } : await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId });
    await carrier.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
    await carrier.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [dana.accountId] });
    return S.get(`/v1/loads/${load.id}`);
  };
  const deliver = async (loadId: string, loaded = "2026-10-06T14:10:00Z") => {
    await D.post(`/v1/loads/${loadId}/status`, { code: "LOADED", at: loaded });
    await D.post(`/v1/loads/${loadId}/status`, { code: "ARRIVED_DELIVERY", at: "2026-10-08T15:00:00Z" });
    await D.post(`/v1/loads/${loadId}/status`, { code: "DELIVERED", at: "2026-10-08T16:00:00Z" });
  };
  const pickupOf = (load: { stops: Array<{ id: string; type: string }> }) => load.stops.find((s) => s.type === "PICKUP")!.id;
  const deliveryOf = (load: { stops: Array<{ id: string; type: string }> }) => load.stops.find((s) => s.type === "DELIVERY")!.id;
  return { h, at, S, acme, A, alpha, B, bravo, dana, D, book, deliver, pickupOf, deliveryOf };
}

describe("missed appointments", () => {
  it("lets the business ding the hauling carrier, and only that carrier, even with a shared driver", async () => {
    const { at, S, A, alpha, B, bravo, dana, D, book, deliver, pickupOf, deliveryOf } = await world();
    const load = await book(A, alpha.id);

    // Not before the window closes, and only the shipper or broker can report.
    await S.post(`/v1/loads/${load.id}/appointment-misses`, { stopId: pickupOf(load), kind: "NO_SHOW" }, 409);
    at("2026-10-06T16:00:00Z");
    await D.post(`/v1/loads/${load.id}/appointment-misses`, { stopId: pickupOf(load), kind: "NO_SHOW" }, 403);
    await A.post(`/v1/loads/${load.id}/appointment-misses`, { stopId: pickupOf(load), kind: "NO_SHOW" }, 403);
    await S.post(`/v1/loads/${load.id}/appointment-misses`, { stopId: deliveryOf(load), kind: "NO_SHOW" }, 409);

    const miss = await S.post(`/v1/loads/${load.id}/appointment-misses`, { stopId: pickupOf(load), kind: "LATE", minutesLate: 90, note: "Dock waited" }, 201);
    expect(miss).toMatchObject({ carrierOrgId: alpha.id, carrierName: "Alpha Freight", businessName: "Acme Foods", driverIds: [dana.accountId], stopType: "PICKUP", minutesLate: 90 });
    await S.post(`/v1/loads/${load.id}/appointment-misses`, { stopId: pickupOf(load), kind: "NO_SHOW" }, 409);

    // The carrier is charged even before delivery; the shared driver's other carrier is not.
    const alphaSeen = await S.get(`/v1/reliability/carriers/${alpha.id}`);
    expect(alphaSeen.forBusiness).toMatchObject({ shipments: 1, onTimePickupPct: 0, missedAppointments: 1 });
    expect((await S.get(`/v1/reliability/carriers/${bravo.id}`)).overall).toMatchObject({ shipments: 0, missedAppointments: 0 });

    // It still counts against Alpha after delivery, even though the Loaded time was on time.
    await deliver(load.id);
    const alphaOwn = await A.get(`/v1/reliability/carriers/${alpha.id}`);
    expect(alphaOwn.overall).toMatchObject({ shipments: 1, onTimePickupPct: 0, onTimeDeliveryPct: 100, missedAppointments: 1 });
    expect(alphaOwn.appointmentMisses).toHaveLength(1);

    // Dana carries it personally; Bravo looking at Dana sees nothing charged to Bravo and none of Alpha's customers.
    expect((await D.get(`/v1/reliability/drivers/${dana.accountId}`)).overall).toMatchObject({ missedAppointments: 1 });
    const danaForBravo = await B.get(`/v1/reliability/drivers/${dana.accountId}`);
    expect(danaForBravo.forCarrier).toMatchObject({ carrierKey: bravo.id, shipments: 0 });
    expect(danaForBravo.byBusiness).toEqual([]);

    // Alpha disputes; it still counts until Acme withdraws it.
    await B.post(`/v1/appointment-misses/${miss.id}/dispute`, { note: "Not ours" }, 403);
    await A.post(`/v1/appointment-misses/${miss.id}/dispute`, { note: "Gate was closed when we arrived" });
    expect((await A.get(`/v1/reliability/carriers/${alpha.id}`)).overall.missedAppointments).toBe(1);
    await A.post(`/v1/appointment-misses/${miss.id}/withdraw`, {}, 403);
    await S.post(`/v1/appointment-misses/${miss.id}/withdraw`);
    expect((await A.get(`/v1/reliability/carriers/${alpha.id}`)).overall).toMatchObject({ onTimePickupPct: 100, missedAppointments: 0 });
    const thread = await S.get(`/v1/loads/${load.id}/messages`);
    expect(thread.map((m: { body: string }) => m.body).join("\n")).toMatch(/reported a missed pickup.*\n?[\s\S]*disputed[\s\S]*withdrew/);
  });

  it("keeps a no-show with the carrier that missed it when the load moves to another carrier", async () => {
    const { at, S, A, alpha, B, bravo, book, deliver, pickupOf } = await world();
    const load = await book(A, alpha.id);
    at("2026-10-06T16:00:00Z");
    await S.post(`/v1/loads/${load.id}/appointment-misses`, { stopId: pickupOf(load), kind: "NO_SHOW" }, 201);

    // Acme takes the load back and gives it to Bravo, who rescues it with the same shared driver.
    await S.post(`/v1/loads/${load.id}/release-carrier`);
    await A.get(`/v1/loads/${load.id}`, 404);
    at("2026-10-06T17:00:00Z");
    await book(B, bravo.id, load.id);
    // Bravo cannot be charged for an appointment that passed before it had the load.
    await S.post(`/v1/loads/${load.id}/appointment-misses`, { stopId: pickupOf(load), kind: "NO_SHOW" }, 409);
    await deliver(load.id, "2026-10-06T20:00:00Z");

    const alphaOwn = await A.get(`/v1/reliability/carriers/${alpha.id}`);
    expect(alphaOwn.overall).toMatchObject({ shipments: 1, onTimePickupPct: 0, onTimeDeliveryPct: null, damageFreePct: null, missedAppointments: 1 });
    // Bravo picked up after the original window, but it took the load after that window closed: not judged on pickup.
    const bravoOwn = await B.get(`/v1/reliability/carriers/${bravo.id}`);
    expect(bravoOwn.overall).toMatchObject({ shipments: 1, onTimePickupPct: null, onTimeDeliveryPct: 100, damageFreePct: 100, missedAppointments: 0, score: 100 });
    expect(bravoOwn.appointmentMisses).toEqual([]);
  });

  it("charges a no-show on a cancelled load to the carrier that missed it", async () => {
    const { at, S, A, alpha, book, pickupOf } = await world();
    const load = await book(A, alpha.id);
    at("2026-10-06T16:00:00Z");
    await S.post(`/v1/loads/${load.id}/appointment-misses`, { stopId: pickupOf(load), kind: "NO_SHOW" }, 201);
    await S.post(`/v1/loads/${load.id}/cancel`);
    expect((await A.get(`/v1/reliability/carriers/${alpha.id}`)).overall).toMatchObject({ shipments: 1, onTimePickupPct: 0, missedAppointments: 1 });
  });

  it("scores carriers reached only by API or EDI, for the business that uses them", async () => {
    const { h, at, S, acme, pickupOf } = await world();
    await S.post(`/v1/orgs/${acme.id}/partners/from-catalog/estes`, {}, 201);
    const load = await S.post("/v1/loads", loadBody(acme.id), 201);
    await S.post(`/v1/loads/${load.id}/tender`, { partnerKey: "estes" });
    const before = await S.get(`/v1/reliability/partners/estes`);
    expect(before.overall).toMatchObject({ shipments: 0, score: null });
    at("2026-10-06T16:00:00Z");
    const full = await S.get(`/v1/loads/${load.id}`);
    const miss = await S.post(`/v1/loads/${load.id}/appointment-misses`, { stopId: pickupOf(full), kind: "NO_SHOW" }, 201);
    expect(miss).toMatchObject({ externalCarrierKey: "estes", carrierName: "estes" });
    expect((await S.get(`/v1/reliability/partners/estes`)).overall).toMatchObject({ shipments: 1, onTimePickupPct: 0, missedAppointments: 1 });
    const other = api(h, await signUp(h, "BUSINESS", "Nosy"));
    await other.post("/v1/orgs", { name: "Nosy Co", kinds: ["SHIPPER"] }, 201);
    await other.get(`/v1/reliability/partners/estes`, 403);
  });
});
