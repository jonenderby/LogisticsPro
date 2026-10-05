import {
  Address,
  Contact,
  EquipmentType,
  LineItem,
  type Load,
  Mode,
  Money,
  Oversize,
  PaymentTerms,
  ServiceLevel,
  TimeWindow,
  awardBid,
  loadParties,
  newId,
  placeBid,
  refineLoad,
  refinementLock,
  shipConfirm,
  transition,
} from "@logisticspro/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { geocodeStops } from "../services/geocode.js";
import { carrierProfile } from "../services/reliability.js";
import { type AppContext, HttpError, authenticate, canSeeLoad, capsOf, getLoad, hasOrgCap, isDriverOn, me, parse, postMessage, requireOrgCap, saveLoad } from "../http.js";

const StopInput = z.object({
  type: z.enum(["PICKUP", "DELIVERY"]),
  address: Address,
  window: TimeWindow,
  contact: Contact.optional(),
  instructions: z.string().max(500).optional(),
  appointmentRef: z.string().max(30).optional(),
});

const LoadInput = z.object({
  shipperOrgId: z.string(),
  brokerOrgId: z.string().optional(),
  mode: Mode,
  service: ServiceLevel.default("STANDARD"),
  equipment: z.object({ type: EquipmentType, lengthFt: z.number().positive().default(53), tempMinF: z.number().optional(), tempMaxF: z.number().optional() }),
  references: z.object({ bol: z.string().optional(), po: z.array(z.string()).default([]), shipperRef: z.string().optional() }).default({ po: [] }),
  stops: z.array(StopInput).min(2),
  items: z.array(LineItem).min(1),
  oversize: Oversize.optional(),
  accessorials: z.array(z.string()).default([]),
  rate: Money.optional(),
  billTo: z.object({ orgId: z.string().optional(), address: Address }).optional(),
  paymentTerms: PaymentTerms.default("PREPAID"),
  teamRequired: z.boolean().default(false),
  notes: z.string().max(500).optional(),
});

const Refinement = z.object({
  stops: z.array(StopInput.extend({ id: z.string().optional() })).min(2).optional(),
  items: z.array(LineItem).min(1).optional(),
  references: z.object({ bol: z.string().optional(), po: z.array(z.string()).default([]), shipperRef: z.string().optional(), pro: z.string().optional() }).optional(),
  accessorials: z.array(z.string()).optional(),
  equipment: LoadInput.shape.equipment.optional(),
  oversize: Oversize.optional(),
  notes: z.string().max(500).optional(),
  service: ServiceLevel.optional(),
  teamRequired: z.boolean().optional(),
});

function withStopIds(stops: Array<z.infer<typeof StopInput> & { id?: string }>) {
  return stops.map((s, i) => ({ ...s, id: s.id ?? newId("stop"), sequence: i + 1 }));
}

/** May this account act for the shipping side of the load (shipper or broker)? */
function canShip(ctx: AppContext, accountId: string, load: Load): boolean {
  return hasOrgCap(ctx, accountId, load.shipperOrgId, "SHIP") || hasOrgCap(ctx, accountId, load.brokerOrgId, "BROKER");
}

export function loadRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };

  app.post("/v1/loads", auth, async (req, reply) => {
    const account = me(ctx, req);
    const body = parse(LoadInput, req.body);
    if (!ctx.store.orgs.has(body.shipperOrgId)) throw new HttpError(404, "NOT_FOUND", "Shipper organization not found");
    if (body.brokerOrgId) requireOrgCap(ctx, account.id, body.brokerOrgId, "BROKER");
    else requireOrgCap(ctx, account.id, body.shipperOrgId, "SHIP");
    if (!body.stops.some((s) => s.type === "PICKUP") || body.stops[body.stops.length - 1]!.type !== "DELIVERY") {
      throw new HttpError(400, "INVALID_REQUEST", "A load needs a pickup and must end with a delivery");
    }
    const shipper = ctx.store.orgs.get(body.shipperOrgId)!;
    const now = ctx.now().toISOString();
    const geo = await geocodeStops(ctx, body.stops);
    const load: Load = {
      id: newId("load"),
      loadNumber: ctx.store.nextLoadNumber(),
      version: 1,
      status: "DRAFT",
      ...body,
      teamRequired: body.teamRequired || body.service === "TEAM_EXPEDITED",
      references: { ...body.references },
      stops: withStopIds(geo.stops),
      billTo: body.billTo ?? { orgId: shipper.id, address: shipper.address ?? body.stops[0]!.address },
      legs: [],
      events: [],
      documents: [],
      createdByAccountId: account.id,
      createdAt: now,
      updatedAt: now,
    };
    saveLoad(ctx, load);
    reply.code(201);
    return geo.warnings.length ? { ...load, warnings: geo.warnings } : load;
  });

  app.get("/v1/loads", auth, async (req) => {
    const account = me(ctx, req);
    const { filter, status } = req.query as { filter?: string; status?: string };
    const caps = capsOf(ctx, account.id);
    const orgsWith = (c: Parameters<typeof caps.all.has>[0]) => new Set([...caps.byOrg].filter(([, s]) => s.has(c)).map(([id]) => id));
    const myOrgs = new Set(ctx.store.membershipsOf(account.id).map((m) => m.orgId));
    // Open board loads belong on /v1/board unless you are a party to them.
    let loads = [...ctx.store.loads.values()].filter((l) => canSeeLoad(ctx, account.id, l) && (l.status !== "POSTED" || loadParties(l).some((o) => myOrgs.has(o))));
    if (filter === "driving") loads = loads.filter((l) => isDriverOn(l, account.id));
    if (filter === "dispatch") loads = loads.filter((l) => !!l.carrierOrgId && orgsWith("DISPATCH").has(l.carrierOrgId));
    if (filter === "shipments") loads = loads.filter((l) => orgsWith("SHIP").has(l.shipperOrgId) && !l.brokerOrgId);
    if (filter === "brokered") loads = loads.filter((l) => !!l.brokerOrgId && orgsWith("BROKER").has(l.brokerOrgId));
    if (status) loads = loads.filter((l) => status.split(",").includes(l.status));
    return loads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });

  app.get("/v1/loads/:id", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    return { ...load, refinement: refinementLock(load) };
  });

  /** Shipper/broker refinement. Open until pickup or ship confirm; carriers get a 204 change. */
  app.patch("/v1/loads/:id", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    if (!canShip(ctx, account.id, load)) throw new HttpError(403, "FORBIDDEN", "Only the shipper or broker can change this load");
    const body = parse(Refinement, req.body);
    const { stops: rawStops, references, ...rest } = body;
    const stops = rawStops ? (await geocodeStops(ctx, rawStops)).stops : undefined;
    const patch = { ...rest, ...(stops ? { stops: withStopIds(stops) } : {}), ...(references ? { references: { ...load.references, ...references } } : {}) };
    const { load: next, changed } = refineLoad(load, patch, ctx.now().toISOString());
    if (changed.length === 0) return { load, changed, transmissions: [] };
    saveLoad(ctx, next);
    let transmissions: unknown[] = [];
    if ((next.carrierOrgId || next.externalCarrierKey) && ["TENDERED", "BOOKED", "DISPATCHED", "AT_PICKUP"].includes(next.status)) {
      postMessage(ctx, next, { senderAccountId: account.id, kind: "SYSTEM", body: `Load updated by shipper: ${changed.join(", ")}` });
      transmissions = await ctx.hub.tender(next, "CHANGE");
    }
    return { load: next, changed, transmissions };
  });

  app.post("/v1/loads/:id/ship-confirm", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    if (!canShip(ctx, account.id, load)) throw new HttpError(403, "FORBIDDEN", "Only the shipper or broker can confirm shipment");
    const next = saveLoad(ctx, shipConfirm(load, ctx.now().toISOString()));
    postMessage(ctx, next, { senderAccountId: account.id, kind: "SYSTEM", body: "Shipper confirmed the shipment. Load details are now locked." });
    return next;
  });

  app.post("/v1/loads/:id/cancel", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    if (!canShip(ctx, account.id, load)) throw new HttpError(403, "FORBIDDEN", "Only the shipper or broker can cancel");
    if (load.pickedUpAt) throw new HttpError(409, "LOAD_LOCKED", "Load is already picked up");
    const next = saveLoad(ctx, transition(load, "CANCELLED", ctx.now().toISOString()));
    const transmissions = next.carrierOrgId || next.externalCarrierKey ? await ctx.hub.tender(next, "CANCEL") : [];
    return { load: next, transmissions };
  });

  // ---------------------------------------------------------------- load board & bids

  app.post("/v1/loads/:id/post", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    if (!canShip(ctx, account.id, load)) throw new HttpError(403, "FORBIDDEN", "Only the shipper or broker can post this load");
    const { closesAt } = parse(z.object({ closesAt: z.string().optional() }), req.body ?? {});
    if (load.carrierOrgId || load.externalCarrierKey) throw new HttpError(409, "HAS_CARRIER", "Load already has a carrier");
    const postedBy = load.brokerOrgId ?? load.shipperOrgId;
    const next = { ...transition(load, "POSTED", ctx.now().toISOString()), board: { postedByOrgId: postedBy, postedAt: ctx.now().toISOString(), closesAt } };
    return saveLoad(ctx, next);
  });

  app.get("/v1/board", auth, async (req) => {
    const account = me(ctx, req);
    if (!capsOf(ctx, account.id).all.has("BID")) throw new HttpError(403, "FORBIDDEN", "Register a carrier company to see the load board");
    const q = req.query as { originState?: string; destinationState?: string; equipment?: string; team?: string };
    const mine = new Set(ctx.store.membershipsOf(account.id).map((m) => m.orgId));
    return [...ctx.store.loads.values()]
      .filter((l) => l.status === "POSTED" && !mine.has(l.board!.postedByOrgId))
      .filter((l) => !q.originState || l.stops.find((s) => s.type === "PICKUP")?.address.state === q.originState)
      .filter((l) => !q.destinationState || l.stops[l.stops.length - 1]!.address.state === q.destinationState)
      .filter((l) => !q.equipment || l.equipment.type === q.equipment)
      .filter((l) => q.team === undefined || (q.team === "true") === (l.service === "TEAM_EXPEDITED" || l.teamRequired));
  });

  app.post("/v1/loads/:id/bids", auth, async (req, reply) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    const body = parse(z.object({ carrierOrgId: z.string(), amount: Money, plan: z.enum(["SOLO", "TEAM", "RELAY", "CONSOLIDATED"]).default("SOLO"), transitHours: z.number().positive().optional(), notes: z.string().max(500).optional() }), req.body);
    requireOrgCap(ctx, account.id, body.carrierOrgId, "BID");
    const existing = [...ctx.store.bids.values()].find((b) => b.loadId === load.id && b.carrierOrgId === body.carrierOrgId && b.status === "OPEN");
    if (existing) ctx.store.bids.set(existing.id, { ...existing, status: "WITHDRAWN" });
    const bid = placeBid(load, { ...body, bidderAccountId: account.id }, ctx.now().toISOString());
    ctx.store.bids.set(bid.id, bid);
    reply.code(201);
    return bid;
  });

  app.get("/v1/loads/:id/bids", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    const all = [...ctx.store.bids.values()].filter((b) => b.loadId === load.id);
    if (canShip(ctx, account.id, load)) {
      // Show each bidder's record overall and with this business specifically.
      const business = load.brokerOrgId ?? load.shipperOrgId;
      return all
        .sort((a, b) => a.amount.amount - b.amount.amount)
        .map((b) => {
          const p = carrierProfile(ctx.store, b.carrierOrgId, business);
          return { ...b, carrierName: ctx.store.orgs.get(b.carrierOrgId)?.name, reliability: { overall: p.overall, withYou: p.forBusiness, truckers: p.truckers } };
        });
    }
    const mine = new Set(ctx.store.membershipsOf(account.id).map((m) => m.orgId));
    return all.filter((b) => mine.has(b.carrierOrgId));
  });

  app.post("/v1/loads/:id/bids/:bidId/award", auth, async (req) => {
    const account = me(ctx, req);
    const { id, bidId } = req.params as { id: string; bidId: string };
    const load = getLoad(ctx, account.id, id);
    if (!canShip(ctx, account.id, load)) throw new HttpError(403, "FORBIDDEN", "Only the poster can award bids");
    const { load: next, bids } = awardBid(load, [...ctx.store.bids.values()], bidId, ctx.now().toISOString());
    bids.forEach((b) => ctx.store.bids.set(b.id, b));
    saveLoad(ctx, next);
    postMessage(ctx, next, { senderAccountId: account.id, kind: "SYSTEM", body: `Load awarded to ${ctx.store.orgs.get(next.carrierOrgId!)?.name ?? "carrier"} at $${next.rate?.amount}` });
    return { load: next, transmissions: await ctx.hub.tender(next, "ORIGINAL") };
  });

  /** Tender directly to an on-platform carrier, or to an external carrier through a partner profile. */
  app.post("/v1/loads/:id/tender", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    if (!canShip(ctx, account.id, load)) throw new HttpError(403, "FORBIDDEN", "Only the shipper or broker can tender");
    const body = parse(z.object({ carrierOrgId: z.string().optional(), partnerKey: z.string().optional(), rate: Money.optional() }).refine((b) => !!b.carrierOrgId !== !!b.partnerKey, "Give exactly one of carrierOrgId or partnerKey"), req.body);
    if (body.carrierOrgId && !ctx.store.orgs.get(body.carrierOrgId)?.kinds.includes("CARRIER")) throw new HttpError(404, "NOT_FOUND", "Carrier not found");
    const next: Load = {
      ...transition(load, "TENDERED", ctx.now().toISOString()),
      carrierOrgId: body.carrierOrgId,
      externalCarrierKey: body.partnerKey,
      rate: body.rate ?? load.rate,
      board: undefined,
    };
    if (body.partnerKey && !ctx.store.profile(next.brokerOrgId ?? next.shipperOrgId, body.partnerKey)) {
      throw new HttpError(409, "PARTNER_NOT_CONFIGURED", `Set up partner "${body.partnerKey}" under Integrations first`);
    }
    saveLoad(ctx, next);
    return { load: next, transmissions: await ctx.hub.tender(next, "ORIGINAL") };
  });

  app.post("/v1/loads/:id/tender-response", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    requireOrgCap(ctx, account.id, load.carrierOrgId, "DISPATCH");
    if (load.status !== "TENDERED") throw new HttpError(409, "NOT_TENDERED", "Load is not waiting on a tender response");
    const body = parse(z.object({ decision: z.enum(["ACCEPT", "DECLINE"]), reason: z.string().max(30).optional(), pro: z.string().max(30).optional() }), req.body);
    const now = ctx.now().toISOString();
    const next: Load =
      body.decision === "ACCEPT"
        ? { ...transition(load, "BOOKED", now), references: { ...load.references, pro: body.pro ?? load.references.pro } }
        : { ...transition(load, "DRAFT", now), carrierOrgId: undefined };
    saveLoad(ctx, next);
    postMessage(ctx, body.decision === "ACCEPT" ? next : load, { senderAccountId: account.id, kind: "SYSTEM", body: body.decision === "ACCEPT" ? "Carrier accepted the tender" : `Carrier declined the tender${body.reason ? `: ${body.reason}` : ""}` });
    return { load: next, transmissions: await ctx.hub.tenderResponse(body.decision === "ACCEPT" ? next : load, body.decision, body.reason) };
  });
}
