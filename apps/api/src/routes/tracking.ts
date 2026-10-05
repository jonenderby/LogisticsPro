import { type Load, byUrgency, loadParties, summarizeEtas } from "@logisticspro/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, capsOf, getLoad, hasOrgCap, isDriverOn, me, parse } from "../http.js";
import { hosFor, recordFix } from "../services/hos.js";
import { recordStopVisits } from "../services/stops.js";
import { MOVING, OFFLINE_AFTER_MS, UNDELIVERED, activeLeg, etaFor, lane, positionForLoad } from "../services/tracking.js";

/**
 * Live tracking.
 *
 * - Drivers' phones report their position while they work (POST /v1/me/location).
 * - Carriers see every truck in their network on a map with its current load
 *   and arrival status (GET /v1/tracking/fleet).
 * - Shippers and 3PLs see every undelivered shipment with its ETA and whether
 *   it will be early, on time, at risk or late, plus the truck's position
 *   while it is moving their freight (GET /v1/tracking/shipments).
 */
export function trackingRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };

  const Fix = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), at: z.string().optional(), speedMps: z.number().min(0).max(80).optional(), headingDeg: z.number().min(0).max(360).optional(), accuracyM: z.number().min(0).optional() });

  /** Record one location fix: the latest position, the trail for miles, and automatic duty status. */
  const acceptFix = (accountId: string, b: z.infer<typeof Fix>, now: Date) => {
    const at = b.at ? new Date(b.at) : now;
    if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime() + 5 * 60_000) throw new HttpError(400, "INVALID_REQUEST", "Position time is invalid");
    const prior = ctx.store.positions.get(accountId);
    if (!prior || prior.at <= at.toISOString()) {
      ctx.store.positions.set(accountId, { accountId, geo: { lat: b.lat, lng: b.lng }, at: at.toISOString(), speedMps: b.speedMps, headingDeg: b.headingDeg, accuracyM: b.accuracyM });
    }
    recordFix(ctx.store, accountId, { geo: { lat: b.lat, lng: b.lng }, at: at.toISOString(), speedMps: b.speedMps }, now, { autoDuty: true });
    recordStopVisits(ctx, accountId, { geo: { lat: b.lat, lng: b.lng }, at: at.toISOString() });
  };
  const driverOnly = (accountId: string) => {
    if (!capsOf(ctx, accountId).all.has("DRIVE")) throw new HttpError(403, "FORBIDDEN", "Only drivers share their location");
  };
  const duty = (accountId: string, now: Date) => {
    const hos = hosFor(ctx.store, accountId, now);
    return { ok: true, duty: { status: hos.status, availableMin: hos.availableMin } };
  };

  app.post("/v1/me/location", auth, async (req) => {
    const account = me(ctx, req);
    driverOnly(account.id);
    const now = ctx.now();
    acceptFix(account.id, parse(Fix, req.body), now);
    return duty(account.id, now);
  });

  /**
   * Fixes collected while the app was in the background or offline, sent
   * together. Applied in time order; fixes older than what is already
   * recorded only fill the trail where they fit.
   */
  app.post("/v1/me/locations", auth, async (req) => {
    const account = me(ctx, req);
    driverOnly(account.id);
    const now = ctx.now();
    const { fixes } = parse(z.object({ fixes: z.array(Fix).min(1).max(500) }), req.body);
    for (const f of [...fixes].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))) acceptFix(account.id, f, now);
    return duty(account.id, now);
  });

  const shipmentView = (load: Load, viewerIsShipper: boolean) => {
    const eta = etaFor(ctx.store, load, ctx.now());
    const p = positionForLoad(ctx.store, load);
    return {
      id: load.id,
      loadNumber: load.loadNumber,
      status: load.status,
      ...lane(load),
      carrierName: load.carrierOrgId ? ctx.store.orgs.get(load.carrierOrgId)?.name : load.externalCarrierKey,
      customerName: viewerIsShipper ? undefined : ctx.store.orgs.get(load.brokerOrgId ?? load.shipperOrgId)?.name,
      references: load.references,
      eta,
      truck: p && MOVING.includes(load.status) ? { geo: p.geo, at: p.at, headingDeg: p.headingDeg, stale: ctx.now().getTime() - Date.parse(p.at) > OFFLINE_AFTER_MS } : eta.position ? { geo: eta.position.geo, at: eta.position.at, stale: eta.position.stale } : undefined,
    };
  };

  /** One load's arrival estimate, for the parties on it (not for carriers just viewing it on the board). */
  app.get("/v1/loads/:id/tracking", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    // Drivers see their own loads only, not where their colleagues are.
    const myOrgs = new Set(ctx.store.membershipsOf(account.id).filter((m) => m.roles.some((r) => r !== "DRIVER")).map((m) => m.orgId));
    if (!isDriverOn(load, account.id) && !loadParties(load).some((o) => myOrgs.has(o))) throw new HttpError(404, "NOT_FOUND", "Load not found");
    return { generatedAt: ctx.now().toISOString(), ...shipmentView(load, myOrgs.has(load.shipperOrgId)) };
  });

  /** Shippers and 3PLs: every undelivered shipment, most urgent first. */
  app.get("/v1/tracking/shipments", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.query as { orgId?: string };
    const caps = capsOf(ctx, account.id);
    const mine = [...caps.byOrg].filter(([, s]) => s.has("SHIP") || s.has("BROKER")).map(([id]) => id);
    if (!mine.length) throw new HttpError(403, "FORBIDDEN", "Shipment tracking is for shippers and 3PLs");
    if (orgId && !mine.includes(orgId)) throw new HttpError(403, "FORBIDDEN", "Not your organization");
    const orgs = new Set(orgId ? [orgId] : mine);
    const shipments = [...ctx.store.loads.values()]
      .filter((l) => UNDELIVERED.includes(l.status) && (orgs.has(l.shipperOrgId) || (!!l.brokerOrgId && orgs.has(l.brokerOrgId))))
      .map((l) => shipmentView(l, orgs.has(l.shipperOrgId) && !l.brokerOrgId))
      .sort((a, b) => byUrgency(a.eta, b.eta));
    return { generatedAt: ctx.now().toISOString(), summary: summarizeEtas(shipments.map((s) => s.eta)), shipments };
  });

  /** Carriers: every truck under the carrier's umbrella, with its current load. */
  app.get("/v1/tracking/fleet", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.query as { orgId?: string };
    const caps = capsOf(ctx, account.id);
    const managed = [...caps.byOrg].filter(([id, s]) => (s.has("DISPATCH") || s.has("MANAGE_FLEET")) && ctx.store.orgs.get(id)?.kinds.includes("CARRIER")).map(([id]) => id);
    const carrierId = orgId ?? managed[0];
    if (!carrierId || !managed.includes(carrierId) || !hasOrgCap(ctx, account.id, carrierId, "DISPATCH")) throw new HttpError(403, "FORBIDDEN", "Fleet tracking is for the carrier's owner, admins and dispatchers");
    const now = ctx.now().getTime();
    const loads = [...ctx.store.loads.values()].filter((l) => l.carrierOrgId === carrierId && UNDELIVERED.includes(l.status) && l.status !== "POSTED");
    const loadViews = loads.map((l) => shipmentView(l, false)).sort((a, b) => byUrgency(a.eta, b.eta));
    const drivers = ctx.store.memberships
      .filter((m) => m.orgId === carrierId && m.roles.includes("DRIVER"))
      .map((m) => {
        const acct = ctx.store.accounts.get(m.accountId)!;
        const p = ctx.store.positions.get(m.accountId);
        const load = loads.find((l) => MOVING.includes(l.status) && activeLeg(l)?.driverAccountIds.includes(m.accountId)) ?? loads.find((l) => activeLeg(l)?.driverAccountIds.includes(m.accountId));
        const view = load ? loadViews.find((v) => v.id === load.id) : undefined;
        const offline = !p || now - Date.parse(p.at) > OFFLINE_AFTER_MS;
        // A driver who also drives for another carrier: while moving that carrier's freight,
        // this carrier sees only that they are busy, not where they are or for whom.
        const elsewhere = !view && [...ctx.store.loads.values()].some((l) => l.carrierOrgId !== carrierId && MOVING.includes(l.status) && activeLeg(l)?.driverAccountIds.includes(m.accountId));
        const hos = hosFor(ctx.store, m.accountId, ctx.now());
        return {
          accountId: acct.id,
          name: acct.name,
          phone: acct.phone,
          // Hours are the driver's own across every carrier they drive for, as the law counts them.
          hos: { status: hos.status, availableMin: hos.availableMin, limitedBy: hos.limitedBy, cycleLeftMin: hos.cycleLeftMin },
          position: p && !elsewhere ? { geo: p.geo, at: p.at, speedMps: p.speedMps, headingDeg: p.headingDeg, stale: offline } : undefined,
          state: view ? "ON_LOAD" : elsewhere ? "OTHER_CARRIER" : offline ? "OFFLINE" : "AVAILABLE",
          load: view ? { id: view.id, loadNumber: view.loadNumber, status: view.status, origin: view.origin, destination: view.destination, customerName: view.customerName, eta: view.eta } : undefined,
        };
      })
      .sort((a, b) => (a.load && b.load ? byUrgency(a.load.eta, b.load.eta) : a.load ? -1 : b.load ? 1 : a.name.localeCompare(b.name)));
    return {
      orgId: carrierId,
      name: ctx.store.orgs.get(carrierId)?.name,
      generatedAt: ctx.now().toISOString(),
      summary: summarizeEtas(loadViews.map((v) => v.eta)),
      trucks: { total: drivers.length, onLoad: drivers.filter((d) => d.state === "ON_LOAD").length, otherCarrier: drivers.filter((d) => d.state === "OTHER_CARRIER").length, available: drivers.filter((d) => d.state === "AVAILABLE").length, offline: drivers.filter((d) => d.state === "OFFLINE").length },
      drivers,
      loads: loadViews,
    };
  });
}
