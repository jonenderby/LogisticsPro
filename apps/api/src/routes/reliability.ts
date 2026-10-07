import {
  type AppointmentMiss,
  AppointmentMissKind,
  DRIVER_BUSINESS_WINDOW,
  ExceptionType,
  type Load,
  type LoadException,
  ON_TIME_GRACE_MINUTES,
  type Stop,
  carrierKeyOf,
  carrierWindows,
  loadParties,
  newId,
  partnerCarrierKey,
  reliabilityByBusiness,
} from "@logisticspro/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, capsOf, getLoad, hasOrgCap, isDriverOn, me, parse, postMessage } from "../http.js";
import { carrierProfile, driverProfile, recordOutcome } from "../services/reliability.js";
import { driverCount } from "../store.js";

/**
 * Reliability profiles: on-time pickup, on-time delivery and damage-free rates.
 *
 * Truckers: last 1,000 shipments overall and the last 100 per business.
 * Carriers: the same depth per truck, so 100 x truckers per business and
 * 1,000 x truckers overall. A carrier with ten truckers is judged on its last
 * 1,000 shipments for one business and its last 10,000 overall.
 */
export function reliabilityRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };
  const name = (orgId: string) => ctx.store.orgs.get(orgId)?.name ?? orgId;
  const withNames = <T extends { businessOrgId: string }>(rows: T[]) => rows.slice(0, 20).map((r) => ({ ...r, businessName: name(r.businessOrgId) }));

  /** Report over/short/damage after pickup. Damage counts against the carrier and its drivers. */
  app.post("/v1/loads/:id/exceptions", auth, async (req, reply) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    const shipperSide = hasOrgCap(ctx, account.id, load.shipperOrgId, "SHIP") || hasOrgCap(ctx, account.id, load.brokerOrgId, "BROKER");
    if (!shipperSide && !isDriverOn(load, account.id) && !hasOrgCap(ctx, account.id, load.carrierOrgId, "DISPATCH")) {
      throw new HttpError(403, "FORBIDDEN", "Only parties to this load can report exceptions");
    }
    if (!load.pickedUpAt) throw new HttpError(409, "NOT_PICKED_UP", "Exceptions are reported after pickup");
    const body = parse(z.object({ type: ExceptionType, note: z.string().trim().min(1).max(1000), pieces: z.number().int().positive().optional() }), req.body);
    const orgId = ctx.store.membershipsOf(account.id).find((m) => loadParties(load).includes(m.orgId))?.orgId;
    const ex: LoadException = { id: newId("exc"), loadId: load.id, ...body, reportedByAccountId: account.id, reportedByOrgId: orgId, at: ctx.now().toISOString() };
    ctx.store.exceptions.set(load.id, [...(ctx.store.exceptions.get(load.id) ?? []), ex]);
    recordOutcome(ctx.store, load);
    postMessage(ctx, load, { senderAccountId: account.id, senderOrgId: orgId, kind: "SYSTEM", body: `${body.type.toLowerCase()} reported${body.pieces ? ` (${body.pieces} pieces)` : ""}: ${body.note}` });
    reply.code(201);
    return ex;
  });

  /** Drivers on the leg that serves this stop when it was missed. */
  const driversFor = (load: Load, stop: Stop): string[] => {
    const legs = [...load.legs].sort((a, b) => a.sequence - b.sequence);
    const leg = stop.type === "PICKUP" ? (legs.find((l) => l.fromStopId === stop.id) ?? legs[0]) : (legs.find((l) => l.toStopId === stop.id) ?? legs[legs.length - 1]);
    return leg?.driverAccountIds ?? [];
  };
  const carrierName = (m: Pick<AppointmentMiss, "carrierOrgId" | "externalCarrierKey">) => (m.carrierOrgId ? name(m.carrierOrgId) : (m.externalCarrierKey ?? "the carrier"));
  const missView = (m: AppointmentMiss) => {
    const load = ctx.store.loads.get(m.loadId);
    const stop = load?.stops.find((x) => x.id === m.stopId);
    return { ...m, carrierName: carrierName(m), businessName: name(m.reportedByOrgId), stopCity: stop ? `${stop.address.city}, ${stop.address.state}` : undefined };
  };
  const findMiss = (id: string) => {
    for (const list of ctx.store.appointmentMisses.values()) {
      const m = list.find((x) => x.id === id);
      if (m) return m;
    }
    throw new HttpError(404, "NOT_FOUND", "Missed appointment not found");
  };
  const touch = (m: AppointmentMiss) => {
    const load = ctx.store.loads.get(m.loadId);
    if (load) recordOutcome(ctx.store, load);
    return load;
  };

  /**
   * A shipper or broker reports that the carrier missed a pickup or delivery
   * appointment. The ding goes to the carrier hauling the load now (and the
   * drivers on that leg), and stays with that carrier if the load moves on.
   */
  app.post("/v1/loads/:id/appointment-misses", auth, async (req, reply) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    const orgId = hasOrgCap(ctx, account.id, load.brokerOrgId, "BROKER") ? load.brokerOrgId! : hasOrgCap(ctx, account.id, load.shipperOrgId, "SHIP") ? load.shipperOrgId : undefined;
    if (!orgId) throw new HttpError(403, "FORBIDDEN", "Only the shipper or broker can report a missed appointment");
    const key = carrierKeyOf(load);
    if (!key) throw new HttpError(409, "NO_CARRIER", "This load has no carrier to hold accountable");
    const body = parse(z.object({ stopId: z.string(), kind: AppointmentMissKind, minutesLate: z.number().int().positive().max(10_080).optional(), note: z.string().trim().max(1000).default("") }), req.body);
    const stop = load.stops.find((x) => x.id === body.stopId);
    if (!stop || (stop.type !== "PICKUP" && stop.type !== "DELIVERY")) throw new HttpError(404, "NOT_FOUND", "Pickup or delivery stop not found");
    const appointmentAt = stop.window.end;
    if (ctx.now().getTime() < Date.parse(appointmentAt) + ON_TIME_GRACE_MINUTES * 60_000) throw new HttpError(409, "TOO_EARLY", "You can report a missed appointment once its window has closed");
    if (Date.parse(load.carrierSince ?? load.createdAt) > Date.parse(appointmentAt)) {
      throw new HttpError(409, "NOT_THEIR_APPOINTMENT", "The current carrier took this load after that appointment, so it is not theirs to miss");
    }
    const list = ctx.store.appointmentMisses.get(load.id) ?? [];
    if (list.some((m) => m.stopId === stop.id && m.carrierKey === key && !m.withdrawnAt)) throw new HttpError(409, "ALREADY_REPORTED", "This missed appointment is already reported");
    const miss: AppointmentMiss = {
      id: newId("miss"),
      loadId: load.id,
      loadNumber: load.loadNumber,
      stopId: stop.id,
      stopType: stop.type,
      appointmentAt,
      kind: body.kind,
      minutesLate: body.kind === "LATE" ? body.minutesLate : undefined,
      note: body.note,
      carrierKey: key,
      carrierOrgId: load.carrierOrgId,
      externalCarrierKey: load.carrierOrgId ? undefined : load.externalCarrierKey,
      driverIds: driversFor(load, stop),
      businessOrgIds: [load.shipperOrgId, load.brokerOrgId].filter((x): x is string => !!x),
      reportedByAccountId: account.id,
      reportedByOrgId: orgId,
      at: ctx.now().toISOString(),
    };
    ctx.store.appointmentMisses.set(load.id, [...list, miss]);
    recordOutcome(ctx.store, load);
    const what = `${stop.type === "PICKUP" ? "pickup" : "delivery"} appointment at ${stop.address.city}`;
    postMessage(ctx, load, { senderAccountId: account.id, senderOrgId: orgId, kind: "SYSTEM", body: `${name(orgId)} reported a missed ${what} by ${carrierName(miss)}: ${body.kind === "NO_SHOW" ? "no-show" : `late${miss.minutesLate ? ` by ${miss.minutesLate} min` : ""}`}${body.note ? `. ${body.note}` : ""}` });
    reply.code(201);
    return missView(miss);
  });

  app.get("/v1/loads/:id/appointment-misses", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    return (ctx.store.appointmentMisses.get(load.id) ?? []).map(missView);
  });

  /** The business that reported it can take it back; the carrier's score recovers. */
  app.post("/v1/appointment-misses/:id/withdraw", auth, async (req) => {
    const account = me(ctx, req);
    const miss = findMiss((req.params as { id: string }).id);
    if (!hasOrgCap(ctx, account.id, miss.reportedByOrgId, "SHIP") && !hasOrgCap(ctx, account.id, miss.reportedByOrgId, "BROKER")) throw new HttpError(403, "FORBIDDEN", "Only the business that reported it can withdraw it");
    if (miss.withdrawnAt) return missView(miss);
    miss.withdrawnAt = ctx.now().toISOString();
    ctx.store.appointmentMisses.touch(miss.loadId);
    const load = touch(miss);
    if (load) postMessage(ctx, load, { senderAccountId: account.id, senderOrgId: miss.reportedByOrgId, kind: "SYSTEM", body: `${name(miss.reportedByOrgId)} withdrew the missed ${miss.stopType === "PICKUP" ? "pickup" : "delivery"} appointment report` });
    return missView(miss);
  });

  /** The carrier charged with it can respond. It still counts until the business withdraws it. */
  app.post("/v1/appointment-misses/:id/dispute", auth, async (req) => {
    const account = me(ctx, req);
    const miss = findMiss((req.params as { id: string }).id);
    if (!hasOrgCap(ctx, account.id, miss.carrierOrgId, "DISPATCH")) throw new HttpError(403, "FORBIDDEN", "Only the carrier charged with it can dispute it");
    const body = parse(z.object({ note: z.string().trim().min(1).max(1000) }), req.body);
    miss.dispute = { note: body.note, accountId: account.id, at: ctx.now().toISOString() };
    ctx.store.appointmentMisses.touch(miss.loadId);
    const load = ctx.store.loads.get(miss.loadId);
    if (load && loadParties(load).includes(miss.carrierOrgId!)) postMessage(ctx, load, { senderAccountId: account.id, senderOrgId: miss.carrierOrgId, kind: "SYSTEM", body: `${name(miss.carrierOrgId!)} disputed the missed appointment: ${body.note}` });
    return missView(miss);
  });

  app.get("/v1/loads/:id/exceptions", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    return ctx.store.exceptions.get(load.id) ?? [];
  });

  app.get("/v1/reliability/drivers/:accountId", auth, async (req) => {
    const account = me(ctx, req);
    const { accountId } = req.params as { accountId: string };
    const { businessOrgId } = req.query as { businessOrgId?: string };
    const driver = ctx.store.accounts.get(accountId);
    if (!driver) throw new HttpError(404, "NOT_FOUND", "Driver not found");
    const theirCarriers = ctx.store.memberships.filter((m) => m.accountId === accountId && m.roles.includes("DRIVER")).map((m) => m.orgId);
    const allowed = account.id === accountId || theirCarriers.some((c) => hasOrgCap(ctx, account.id, c, "DISPATCH") || hasOrgCap(ctx, account.id, c, "MANAGE_ORG"));
    if (!allowed) throw new HttpError(403, "FORBIDDEN", "Only the driver and their carriers can see this profile");
    // A carrier sees the driver's overall score, but only its own shipments in detail:
    // a driver shared with another carrier never exposes that carrier's customers.
    const self = account.id === accountId;
    const viewerCarrier = self ? undefined : theirCarriers.find((c) => hasOrgCap(ctx, account.id, c, "DISPATCH") || hasOrgCap(ctx, account.id, c, "MANAGE_ORG"));
    const all = [...ctx.store.outcomes.values()].filter((o) => o.driverIds.includes(accountId));
    const outcomes = viewerCarrier ? all.filter((o) => (o.carrierKey ?? o.carrierOrgId) === viewerCarrier) : all;
    const pick = { pickup: (o: (typeof outcomes)[number]) => o.pickupDriverIds.includes(accountId), delivery: (o: (typeof outcomes)[number]) => o.deliveryDriverIds.includes(accountId) };
    const carriers = [...new Set(all.map((o) => o.carrierKey ?? o.carrierOrgId).filter((k): k is string => !!k && !k.startsWith("partner:")))];
    return {
      accountId,
      name: driver.name,
      windows: { overall: 1000, perBusiness: DRIVER_BUSINESS_WINDOW },
      ...driverProfile(ctx.store, accountId, businessOrgId, viewerCarrier),
      byBusiness: withNames(reliabilityByBusiness(outcomes, DRIVER_BUSINESS_WINDOW, pick)),
      byCarrier: self && carriers.length > 1 ? carriers.map((c) => ({ ...driverProfile(ctx.store, accountId, undefined, c).forCarrier!, carrierName: name(c) })) : undefined,
    };
  });

  /**
   * Carrier members see everything. A shipper or broker sees the carrier's
   * overall score and its score with *their own* business only.
   */
  app.get("/v1/reliability/carriers/:orgId", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    const { businessOrgId } = req.query as { businessOrgId?: string };
    const carrier = ctx.store.orgs.get(orgId);
    if (!carrier?.kinds.includes("CARRIER")) throw new HttpError(404, "NOT_FOUND", "Carrier not found");
    const member = ctx.store.memberships.some((m) => m.accountId === account.id && m.orgId === orgId);
    if (member) {
      const outcomes = [...ctx.store.outcomes.values()].filter((o) => o.carrierOrgId === orgId);
      const w = carrierWindows(driverCount(ctx.store, orgId));
      const misses = [...ctx.store.appointmentMisses.values()].flat().filter((m) => m.carrierOrgId === orgId).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20).map(missView);
      return { carrierOrgId: orgId, name: carrier.name, ...carrierProfile(ctx.store, orgId, businessOrgId), byBusiness: withNames(reliabilityByBusiness(outcomes, w.perBusiness)), appointmentMisses: misses };
    }
    const caps = capsOf(ctx, account.id);
    const myBusinesses = [...caps.byOrg].filter(([, s]) => s.has("SHIP") || s.has("BROKER")).map(([id]) => id);
    if (!myBusinesses.length) throw new HttpError(403, "FORBIDDEN", "Shippers, brokers and the carrier's own team can see carrier reliability");
    const biz = businessOrgId ?? myBusinesses[0]!;
    if (!myBusinesses.includes(biz)) throw new HttpError(403, "FORBIDDEN", "You can only see a carrier's record with your own business");
    return { carrierOrgId: orgId, name: carrier.name, ...carrierProfile(ctx.store, orgId, biz) };
  });

  /** Carriers a business reaches only by API or EDI are scored too, on that business's own shipments with them. */
  app.get("/v1/reliability/partners/:partnerKey", auth, async (req) => {
    const account = me(ctx, req);
    const { partnerKey } = req.params as { partnerKey: string };
    const { orgId } = req.query as { orgId?: string };
    const caps = capsOf(ctx, account.id);
    const owner = orgId ?? [...caps.byOrg].find(([id, s]) => (s.has("SHIP") || s.has("BROKER")) && ctx.store.profile(id, partnerKey))?.[0];
    if (!owner || !(hasOrgCap(ctx, account.id, owner, "SHIP") || hasOrgCap(ctx, account.id, owner, "BROKER") || hasOrgCap(ctx, account.id, owner, "MANAGE_ORG"))) throw new HttpError(403, "FORBIDDEN", "Not your partner");
    const profile = ctx.store.profile(owner, partnerKey);
    if (!profile) throw new HttpError(404, "NOT_FOUND", "Partner not found");
    const key = partnerCarrierKey(owner, partnerKey);
    const misses = [...ctx.store.appointmentMisses.values()].flat().filter((m) => m.carrierKey === key).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20).map(missView);
    return { partnerKey, name: profile.name ?? partnerKey, ...carrierProfile(ctx.store, key, owner), appointmentMisses: misses };
  });
}
