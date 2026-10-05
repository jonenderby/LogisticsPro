import { recordFix } from "../services/hos.js";
import {
  DocumentKind,
  GeoPoint,
  type Load,
  type LoadEvent,
  RelayPoint,
  StatusCode,
  applyStatusEvent,
  assignLeg,
  buildInvoice,
  estimateTransit,
  handoffLegs,
  loadMiles,
  newId,
  planConsolidation,
  planRelay,
  statusText,
  transition,
} from "@logisticspro/domain";
import { ChargeCode } from "@logisticspro/domain";
import { LEGAL_TRUCK, NoRouteError, type Restriction, checkOversizeTrip } from "@logisticspro/navigation";
import { withGeo } from "../services/geocode.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, getLoad, hasOrgCap, isDriverOn, me, parse, postMessage, requireOrgCap, saveLoad } from "../http.js";

const StatusInput = z.object({
  code: StatusCode,
  at: z.string().optional(),
  legId: z.string().optional(),
  stopId: z.string().optional(),
  geo: GeoPoint.optional(),
  city: z.string().max(30).optional(),
  state: z.string().max(3).optional(),
  note: z.string().max(500).optional(),
  reason: z.enum(["NORMAL", "WEATHER", "TRAFFIC", "MECHANICAL", "SHIPPER_DELAY", "CONSIGNEE_DELAY", "OTHER"]).optional(),
  eta: z.string().optional(),
});

const RestrictionInput = z.object({
  id: z.string(),
  type: z.enum(["LOW_CLEARANCE", "WEIGHT_LIMIT", "WIDTH_LIMIT", "LENGTH_LIMIT", "NO_OVERSIZE", "CONSTRUCTION"]),
  at: GeoPoint,
  limit: z.number().optional(),
  description: z.string(),
});

export function operationsRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };
  const param = (req: { params: unknown }) => (req.params as { id: string }).id;

  // ---------------------------------------------------------------- dispatch planning

  app.post("/v1/loads/:id/relay", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, param(req));
    requireOrgCap(ctx, account.id, load.carrierOrgId, "DISPATCH");
    const { points: raw } = parse(z.object({ points: z.array(RelayPoint).min(1).max(5) }), req.body);
    const points = [];
    for (const p of raw) points.push({ ...p, address: (await withGeo(ctx, p.address, "Relay point")).address });
    const next = saveLoad(ctx, planRelay(load, points, ctx.now().toISOString()));
    postMessage(ctx, next, { senderAccountId: account.id, kind: "SYSTEM", body: `Dispatch planned ${next.legs.length} relay legs (${points.map((p) => p.address.city).join(", ")})` });
    return next;
  });

  /** Assign a driver, or a two-driver team, to a leg. */
  app.post("/v1/loads/:id/legs/:legId/assign", auth, async (req) => {
    const account = me(ctx, req);
    const { id, legId } = req.params as { id: string; legId: string };
    const load = getLoad(ctx, account.id, id);
    requireOrgCap(ctx, account.id, load.carrierOrgId, "DISPATCH");
    const body = parse(z.object({ driverAccountIds: z.array(z.string()).min(1).max(2), tractorId: z.string().optional(), trailerId: z.string().optional() }), req.body);
    for (const d of body.driverAccountIds) {
      const m = ctx.store.memberships.find((x) => x.accountId === d && x.orgId === load.carrierOrgId);
      if (!m?.roles.includes("DRIVER")) throw new HttpError(400, "NOT_A_DRIVER", `Account ${d} is not a driver for this carrier`);
    }
    const base = load.legs.length ? load : { ...load, legs: handoffLegs(load.stops) };
    const resolvedLegId = legId === "first" ? base.legs[0]!.id : legId;
    let next = assignLeg(base, resolvedLegId, body, ctx.now().toISOString());
    if (next.status === "BOOKED") next = transition(next, "DISPATCHED", ctx.now().toISOString());
    saveLoad(ctx, next);
    const names = body.driverAccountIds.map((d) => ctx.store.accounts.get(d)?.name).join(" & ");
    postMessage(ctx, next, { senderAccountId: account.id, kind: "SYSTEM", body: `${body.driverAccountIds.length === 2 ? "Team" : "Driver"} ${names} assigned to leg ${next.legs.find((l) => l.id === resolvedLegId)!.sequence}` });
    return next;
  });

  app.get("/v1/loads/:id/transit", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, param(req));
    const miles = Math.round(loadMiles(load));
    return { miles, solo: estimateTransit(miles), team: estimateTransit(miles, { team: true }) };
  });

  app.post("/v1/consolidations", auth, async (req, reply) => {
    const account = me(ctx, req);
    const body = parse(z.object({ carrierOrgId: z.string(), dcId: z.string(), loadIds: z.array(z.string()).min(2), maxWeightLb: z.number().positive().optional() }), req.body);
    requireOrgCap(ctx, account.id, body.carrierOrgId, "DISPATCH");
    const dc = ctx.store.orgs.get(body.carrierOrgId)?.distributionCenters.find((d) => d.id === body.dcId);
    if (!dc) throw new HttpError(404, "NOT_FOUND", "Distribution center not found");
    const loads = body.loadIds.map((id) => getLoad(ctx, account.id, id));
    const plan = planConsolidation(loads, dc, body.carrierOrgId, { maxWeightLb: body.maxWeightLb, now: ctx.now().toISOString() });
    for (const l of plan.loads) {
      saveLoad(ctx, l);
      postMessage(ctx, l, { senderAccountId: account.id, kind: "SYSTEM", body: `Routed through ${dc.name} and consolidated with ${plan.loads.length - 1} other shipment(s)` });
    }
    reply.code(201);
    return plan;
  });

  // ---------------------------------------------------------------- driver status & documents

  app.post("/v1/loads/:id/status", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, param(req));
    const driving = isDriverOn(load, account.id);
    if (!driving && !hasOrgCap(ctx, account.id, load.carrierOrgId, "DISPATCH")) throw new HttpError(403, "FORBIDDEN", "Only the assigned driver or dispatch can update status");
    const body = parse(StatusInput, req.body);
    const myLeg = load.legs.find((l) => l.driverAccountIds.includes(account.id) && l.status === "IN_PROGRESS") ?? load.legs.find((l) => l.driverAccountIds.includes(account.id) && l.status !== "COMPLETED");
    const legId = body.legId ?? (driving ? myLeg?.id : undefined);
    if (body.code === "RELAY_HANDOFF" && !legId) throw new HttpError(400, "INVALID_REQUEST", "Relay handoff needs the leg being handed off");
    const event: LoadEvent = {
      id: newId("evt"),
      code: body.code,
      at: body.at ?? ctx.now().toISOString(),
      legId,
      stopId: body.stopId,
      geo: body.geo,
      city: body.city,
      state: body.state,
      note: body.note,
      eta: body.eta ? new Date(body.eta).toISOString() : undefined,
      reportedByAccountId: account.id,
      source: "APP",
    };
    // A status with a location also updates the driver's position on the fleet map.
    if (driving && body.geo) {
      const prior = ctx.store.positions.get(account.id);
      if (!prior || prior.at <= event.at) ctx.store.positions.set(account.id, { accountId: account.id, geo: body.geo, at: event.at });
      recordFix(ctx.store, account.id, { geo: body.geo, at: event.at }, ctx.now(), { autoDuty: false });
    }
    const next = saveLoad(ctx, applyStatusEvent(load, event));
    const where = body.city ? ` · ${body.city}${body.state ? `, ${body.state}` : ""}` : "";
    postMessage(ctx, next, { senderAccountId: account.id, senderOrgId: next.carrierOrgId, kind: "STATUS", statusCode: body.code, body: `${statusText(body.code)}${where}${body.note ? ` — ${body.note}` : ""}` });
    const transmissions = await ctx.hub.status(next, event, { reason: body.reason, eta: body.eta });
    return { load: next, event, transmissions };
  });

  app.post("/v1/loads/:id/documents", auth, async (req, reply) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, param(req));
    const body = parse(z.object({ kind: DocumentKind, name: z.string().min(1).max(200), url: z.string().url() }), req.body);
    const doc = { id: newId("doc"), ...body, uploadedByAccountId: account.id, at: ctx.now().toISOString() };
    saveLoad(ctx, { ...load, documents: [...load.documents, doc], updatedAt: doc.at });
    postMessage(ctx, load, { senderAccountId: account.id, kind: "SYSTEM", body: `${body.kind.replace(/_/g, " ")} uploaded: ${body.name}` });
    reply.code(201);
    return doc;
  });

  // ---------------------------------------------------------------- messages

  app.get("/v1/loads/:id/messages", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, param(req));
    const msgs = ctx.store.messages.filter((m) => m.loadId === load.id);
    ctx.store.reads.set(`${account.id}:load:${load.id}`, ctx.now().toISOString());
    // Reading the thread clears its message notifications.
    for (const n of ctx.store.notifications.get(account.id) ?? []) if (n.kind === "MESSAGE" && n.loadId === load.id) n.read = true;
    return msgs.map((m) => ({ ...m, senderName: ctx.store.accounts.get(m.senderAccountId)?.name ?? "Logistics Pro" }));
  });

  app.post("/v1/loads/:id/messages", auth, async (req, reply) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, param(req));
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
    const senderOrgId = ctx.store.membershipsOf(account.id).find((m) => [load.shipperOrgId, load.brokerOrgId, load.carrierOrgId].includes(m.orgId))?.orgId;
    reply.code(201);
    const msg = postMessage(ctx, load, { senderAccountId: account.id, senderOrgId, kind: "TEXT", body });
    ctx.notifier.messagePosted(msg, load);
    return msg;
  });

  app.get("/v1/messages/threads", auth, async (req) => {
    const account = me(ctx, req);
    const visible = [...ctx.store.loads.values()].filter((l) => getLoadSafe(ctx, account.id, l.id));
    return visible
      .map((l) => {
        const msgs = ctx.store.messages.filter((m) => m.loadId === l.id);
        const last = msgs[msgs.length - 1];
        const read = ctx.store.reads.get(`${account.id}:load:${l.id}`) ?? "";
        return last ? { loadId: l.id, loadNumber: l.loadNumber, last, unread: msgs.filter((m) => m.createdAt > read && m.senderAccountId !== account.id).length } : undefined;
      })
      .filter((x) => !!x)
      .sort((a, b) => b!.last.createdAt.localeCompare(a!.last.createdAt));
  });

  // ---------------------------------------------------------------- invoices

  /**
   * Drivers (for loads they drove) and carrier billing can invoice a
   * delivered load. Delivery format follows the bill-to party's setup.
   */
  app.post("/v1/loads/:id/invoices", auth, async (req, reply) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, param(req));
    const carrierId = load.carrierOrgId;
    const billing = hasOrgCap(ctx, account.id, carrierId, "MANAGE_ORG") || ctx.store.memberships.some((m) => m.accountId === account.id && m.orgId === carrierId && m.roles.includes("BILLING"));
    if (!billing && !(isDriverOn(load, account.id) && hasOrgCap(ctx, account.id, carrierId, "INVOICE"))) throw new HttpError(403, "FORBIDDEN", "Only carrier billing or the driver of this load can invoice it");
    const body = parse(
      z.object({
        lines: z.array(z.object({ code: ChargeCode, description: z.string().min(1).max(30), quantity: z.number().positive().default(1), rate: z.number().nonnegative(), amount: z.number().nonnegative().optional() })).optional(),
        fuelSurchargePct: z.number().min(0).max(100).optional(),
        terms: z.string().max(20).optional(),
        invoiceNumber: z.string().max(22).optional(),
        partnerKey: z.string().optional(),
      }),
      req.body ?? {},
    );
    const carrier = ctx.store.orgs.get(carrierId!)!;
    const inv = buildInvoice(load, { orgId: carrier.id, scac: carrier.scac }, account.id, body, ctx.now().toISOString());
    const transmissions = await ctx.hub.invoice(inv, load);
    const delivered = transmissions.some((t) => t.status === "SENT") || (!!inv.billTo.orgId && ctx.store.orgs.has(inv.billTo.orgId));
    const saved = { ...inv, status: delivered ? ("SENT" as const) : ("DRAFT" as const) };
    ctx.store.invoices.set(saved.id, saved);
    if (delivered) saveLoad(ctx, transition(load, "INVOICED", ctx.now().toISOString()));
    reply.code(201);
    return { invoice: saved, transmissions };
  });

  app.get("/v1/invoices", auth, async (req) => {
    const account = me(ctx, req);
    const mine = new Set(ctx.store.membershipsOf(account.id).map((m) => m.orgId));
    return [...ctx.store.invoices.values()].filter((i) => mine.has(i.carrierOrgId) || (i.billTo.orgId && mine.has(i.billTo.orgId)) || i.createdByAccountId === account.id);
  });

  app.post("/v1/invoices/:id/status", auth, async (req) => {
    const account = me(ctx, req);
    const inv = ctx.store.invoices.get(param(req));
    if (!inv) throw new HttpError(404, "NOT_FOUND", "Invoice not found");
    requireOrgCap(ctx, account.id, inv.billTo.orgId, "PAY");
    const { status } = parse(z.object({ status: z.enum(["ACKNOWLEDGED", "PAID", "REJECTED"]) }), req.body);
    const next = { ...inv, status };
    ctx.store.invoices.set(inv.id, next);
    return next;
  });

  // ---------------------------------------------------------------- navigation

  /**
   * Standard loads get a truck-legal route from the routing provider.
   * Oversize loads get their permitted corridor plus a pre-trip compliance
   * check; the app then runs strict corridor navigation on it.
   */
  app.post("/v1/loads/:id/navigation/plan", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, param(req));
    if (!isDriverOn(load, account.id) && !hasOrgCap(ctx, account.id, load.carrierOrgId, "DISPATCH")) throw new HttpError(403, "FORBIDDEN", "Navigation is for the assigned driver or dispatch");
    const body = parse(z.object({ from: GeoPoint.optional(), departAt: z.string().optional(), restrictions: z.array(RestrictionInput).default([]) }), req.body ?? {});
    if (load.oversize) {
      const truck = { heightIn: load.oversize.heightIn, widthIn: load.oversize.widthIn, lengthIn: load.oversize.lengthIn, grossWeightLb: load.oversize.grossWeightLb, axles: load.oversize.axles };
      const check = checkOversizeTrip({ permits: load.oversize.permits, truck, restrictions: body.restrictions as Restriction[], departAt: body.departAt ?? ctx.now().toISOString() });
      return { mode: "OVERSIZE", truck, ...check };
    }
    const leg = load.legs.find((l) => l.driverAccountIds.includes(account.id) && l.status !== "COMPLETED");
    const stops = [...load.stops].sort((a, b) => a.sequence - b.sequence);
    const segment = leg ? stops.slice(stops.findIndex((s) => s.id === leg.fromStopId), stops.findIndex((s) => s.id === leg.toStopId) + 1) : stops;
    const waypoints = segment.map((s) => s.address.geo).filter((g): g is NonNullable<typeof g> => !!g);
    if (body.from) waypoints.unshift(body.from);
    if (waypoints.length < 2) throw new HttpError(400, "NO_GEO", "These stops have no map location yet. Check the addresses, or ask your admin to turn on address search.");
    const hazmat = load.items.some((i) => i.hazmat);
    try {
      const route = await ctx.routing.route(waypoints, { ...LEGAL_TRUCK, hazmat });
      return { mode: "STANDARD", route };
    } catch (e) {
      if (e instanceof NoRouteError) throw new HttpError(422, "NO_TRUCK_ROUTE", "No truck-legal route between these stops for this vehicle");
      throw e;
    }
  });

  /** Address search for the app (stop entry, "navigate to an address"). */
  app.get("/v1/geocode", auth, async (req) => {
    me(ctx, req);
    const q = req.query as { q?: string; lat?: string; lng?: string; limit?: string };
    if (!q.q || q.q.trim().length < 3) throw new HttpError(400, "INVALID_REQUEST", "Type at least 3 characters");
    if (!ctx.geocoder) throw new HttpError(503, "GEOCODER_UNAVAILABLE", "Address search is not configured on this server (set LP_GEOCODER_URL)");
    const near = q.lat && q.lng ? { lat: Number(q.lat), lng: Number(q.lng) } : undefined;
    return ctx.geocoder.search(q.q.trim(), { limit: Math.min(10, Number(q.limit ?? 5)), near });
  });

  /**
   * Route to any address (fuel, parking, a shop). Oversize loads are refused:
   * they stay on their permitted route.
   */
  app.post("/v1/navigation/route", auth, async (req) => {
    const account = me(ctx, req);
    const body = parse(z.object({ from: GeoPoint, to: z.object({ query: z.string().min(3).optional(), geo: GeoPoint.optional() }).refine((t) => t.query || t.geo, "Give an address or coordinates"), loadId: z.string().optional() }), req.body);
    const load = body.loadId ? getLoad(ctx, account.id, body.loadId) : undefined;
    if (load?.oversize) throw new HttpError(409, "OVERSIZE_STRICT", "Oversize loads must stay on the permitted route; ask dispatch to amend the permit");
    let destination: { label: string; geo: { lat: number; lng: number } };
    if (body.to.geo) destination = { label: body.to.query ?? "Destination", geo: body.to.geo };
    else {
      if (!ctx.geocoder) throw new HttpError(503, "GEOCODER_UNAVAILABLE", "Address search is not configured on this server (set LP_GEOCODER_URL)");
      const [hit] = await ctx.geocoder.search(body.to.query!, { limit: 1, near: body.from });
      if (!hit) throw new HttpError(404, "NOT_FOUND", "No address matched");
      destination = { label: hit.label, geo: hit.geo };
    }
    const hazmat = !!load?.items.some((i) => i.hazmat);
    try {
      const route = await ctx.routing.route([body.from, destination.geo], { ...LEGAL_TRUCK, hazmat });
      return { mode: "STANDARD", destination, route };
    } catch (e) {
      if (e instanceof NoRouteError) throw new HttpError(422, "NO_TRUCK_ROUTE", "No truck-legal route to that address");
      throw e;
    }
  });

  /** The app reports corridor violations so dispatch (and compliance) see them. */
  app.post("/v1/loads/:id/navigation/violations", auth, async (req, reply) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, param(req));
    if (!isDriverOn(load, account.id)) throw new HttpError(403, "FORBIDDEN", "Only the driver reports violations");
    const body = parse(z.object({ startedAt: z.string(), endedAt: z.string().optional(), maxDeviationM: z.number().nonnegative(), firstPoint: GeoPoint }), req.body);
    const rec = { id: newId("viol"), loadId: load.id, accountId: account.id, ...body };
    ctx.store.violations.push(rec);
    postMessage(ctx, load, { senderAccountId: account.id, kind: "SYSTEM", body: `Oversize route alert: truck left the permitted corridor by up to ${Math.round(body.maxDeviationM)} m${body.endedAt ? " and has returned" : ""}.` });
    reply.code(201);
    return rec;
  });

  app.get("/v1/loads/:id/navigation/violations", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, param(req));
    return ctx.store.violations.filter((v) => v.loadId === load.id);
  });

}

function getLoadSafe(ctx: AppContext, accountId: string, id: string): Load | undefined {
  try {
    return getLoad(ctx, accountId, id);
  } catch {
    return undefined;
  }
}
