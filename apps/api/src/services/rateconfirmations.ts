import { DEFAULT_PAYER_TERMS, type Load, type RateConParty, type RateConSignature, type RateConfirmation, canonicalJson, newId, rateConChanges, rateConContent } from "@logisticspro/domain";
import { type AppContext, HttpError, canShip, postMessage } from "../http.js";
import { sha256 } from "../security/tokens.js";
import { detentionTerms } from "./stops.js";

const ACTIVE = ["BOOKED", "DISPATCHED", "AT_PICKUP", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED", "INVOICED"];

export function rateConfirmationsOf(ctx: AppContext, loadId: string): RateConfirmation[] {
  return ctx.store.rateConfirmations.get(loadId) ?? [];
}

/** The version in force or waiting on the carrier (not superseded or void). */
export function currentRateConfirmation(ctx: AppContext, loadId: string): RateConfirmation | undefined {
  const last = rateConfirmationsOf(ctx, loadId).at(-1);
  return last && (last.status === "SIGNED" || last.status === "AWAITING_CARRIER") ? last : undefined;
}

function orgParty(ctx: AppContext, orgId: string): RateConParty {
  const o = ctx.store.orgs.get(orgId);
  return { orgId, name: o?.name ?? orgId, scac: o?.scac, mcNumber: o?.mcNumber, dotNumber: o?.dotNumber };
}

function carrierParty(ctx: AppContext, load: Load): RateConParty {
  if (load.carrierOrgId) return orgParty(ctx, load.carrierOrgId);
  const tendering = load.brokerOrgId ?? load.shipperOrgId;
  const profile = load.externalCarrierKey ? ctx.store.profile(tendering, load.externalCarrierKey) : undefined;
  return { partnerKey: load.externalCarrierKey, name: profile?.name ?? load.externalCarrierKey ?? "Carrier", scac: profile?.scac };
}

function content(ctx: AppContext, load: Load, version: number) {
  const tendering = load.brokerOrgId ?? load.shipperOrgId;
  const payer = ctx.store.orgs.get(load.billTo.orgId ?? tendering);
  const terms = payer?.payerTerms ?? DEFAULT_PAYER_TERMS;
  return rateConContent(load, {
    version,
    tendering: orgParty(ctx, tendering),
    carrier: carrierParty(ctx, load),
    detention: detentionTerms(ctx, load),
    payment: { days: terms.termsDays, quickPay: terms.quickPay },
  });
}

const nameOf = (ctx: AppContext, accountId?: string) => (accountId ? (ctx.store.accounts.get(accountId)?.name ?? "Unknown") : undefined);

function save(ctx: AppContext, loadId: string, versions: RateConfirmation[]) {
  ctx.store.rateConfirmations.set(loadId, versions);
}

/**
 * Called on every load save. Writes the rate confirmation when the carrier
 * accepts, voids it when the carrier is released or the load cancelled,
 * and starts a new version (waiting on the carrier) when the shipper changes
 * what the carrier agreed to.
 */
export function rateConOnSave(ctx: AppContext, prior: Load | undefined, next: Load, actorAccountId?: string): void {
  const versions = rateConfirmationsOf(ctx, next.id);
  const last = versions.at(-1);
  const now = ctx.now().toISOString();
  const live = last && (last.status === "SIGNED" || last.status === "AWAITING_CARRIER");
  const carrierGone = !next.carrierOrgId && !next.externalCarrierKey;
  if (live && (carrierGone || next.status === "CANCELLED" || (last.carrier.orgId ?? last.carrier.partnerKey) !== (next.carrierOrgId ?? next.externalCarrierKey))) {
    save(ctx, next.id, [...versions.slice(0, -1), { ...last, status: "VOID" }]);
    return;
  }
  if (prior?.status === "TENDERED" && next.status === "BOOKED") {
    issue(ctx, next, versions, now);
    return;
  }
  // Only the shipping side changes the agreement; the carrier's own updates never reopen it.
  if (live && ACTIVE.includes(next.status) && prior && prior.version !== next.version && actorAccountId && canShip(ctx, actorAccountId, next)) {
    const c = content(ctx, next, last.version + 1);
    const { hash: _h, signatures: _s, status: _st, id: _id, createdAt: _c, changes: _ch, ...prevContent } = last;
    const changes = rateConChanges(prevContent, c);
    if (!changes.length) return;
    const signer = actorAccountId;
    const rc: RateConfirmation = {
      ...c,
      id: newId("rc"),
      status: "AWAITING_CARRIER",
      hash: sha256(canonicalJson(c)),
      signatures: [{ side: "TENDERING", name: nameOf(ctx, signer)!, accountId: signer, at: now, method: "SIGNED" }],
      changes,
      createdAt: now,
    };
    save(ctx, next.id, [...versions.slice(0, -1), { ...last, status: "SUPERSEDED" }, rc]);
    postMessage(ctx, next, { senderAccountId: signer, kind: "SYSTEM", body: `Rate confirmation v${rc.version} needs the carrier's signature. Changed: ${changes.join(", ")}.` });
  }
}

function issue(ctx: AppContext, load: Load, versions: RateConfirmation[], now: string) {
  const version = (versions.at(-1)?.version ?? 0) + 1;
  const c = content(ctx, load, version);
  const t = load.tender;
  const signatures: RateConSignature[] = [
    { side: "TENDERING", name: nameOf(ctx, t?.byAccountId) ?? c.tendering.name, accountId: t?.byAccountId, at: t?.at ?? now, method: "TENDER" },
    t?.via === "PARTNER" || !load.carrierOrgId
      ? { side: "CARRIER", name: c.carrier.name, at: t?.acceptedAt ?? now, method: "PARTNER_RESPONSE" }
      : { side: "CARRIER", name: nameOf(ctx, t?.acceptedByAccountId) ?? c.carrier.name, accountId: t?.acceptedByAccountId, at: t?.acceptedAt ?? now, method: "ACCEPTANCE" },
  ];
  const rc: RateConfirmation = { ...c, id: newId("rc"), status: "SIGNED", hash: sha256(canonicalJson(c)), signatures, changes: [], createdAt: now };
  const prev = versions.map((v) => (v.status === "SIGNED" || v.status === "AWAITING_CARRIER" ? { ...v, status: "VOID" as const } : v));
  save(ctx, load.id, [...prev, rc]);
  postMessage(ctx, load, { senderAccountId: t?.acceptedByAccountId ?? "system", kind: "SYSTEM", body: `Rate confirmation v${version} signed by both sides: ${c.rate.currency} ${c.rate.amount.toFixed(2)}.` });
}

/** The carrier signs the version waiting on it. */
export function signRateConfirmation(ctx: AppContext, load: Load, accountId: string): RateConfirmation {
  const versions = rateConfirmationsOf(ctx, load.id);
  const last = versions.at(-1);
  if (last?.status !== "AWAITING_CARRIER") throw new HttpError(409, "NOTHING_TO_SIGN", "Nothing is waiting on the carrier's signature");
  const now = ctx.now().toISOString();
  const signed: RateConfirmation = { ...last, status: "SIGNED", signatures: [...last.signatures, { side: "CARRIER", name: nameOf(ctx, accountId)!, accountId, at: now, method: "SIGNED" }] };
  save(ctx, load.id, [...versions.slice(0, -1), signed]);
  postMessage(ctx, load, { senderAccountId: accountId, kind: "SYSTEM", body: `Carrier signed rate confirmation v${signed.version}.` });
  return signed;
}
