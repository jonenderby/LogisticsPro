import { DEFAULT_VETTING_POLICY, type FmcsaRecord, type Load, type VettingResult, nameKey, vetCarrier } from "@logisticspro/domain";
import { type AppContext, HttpError, postMessage } from "../http.js";

const FRESH_MS = 24 * 3_600_000;
const HISTORY = 10;

const identity = (r: FmcsaRecord) => [r.phone?.replace(/\D/g, ""), r.email?.toLowerCase(), r.address?.street?.toLowerCase(), r.address?.postalCode, nameKey(r.legalName)].join("|");

/** FMCSA facts for a USDOT number, looked up at most once a day unless forced. */
export async function fmcsaRecord(ctx: AppContext, dotNumber: string, force = false): Promise<FmcsaRecord | undefined> {
  const dot = dotNumber.replace(/\D/g, "");
  const cached = ctx.store.fmcsa.get(dot);
  if (!ctx.fmcsa) return cached?.current;
  if (cached && !force && ctx.now().getTime() - Date.parse(cached.current.fetchedAt) < FRESH_MS) return cached.current;
  let rec: FmcsaRecord | undefined;
  try {
    rec = await ctx.fmcsa.lookup(dot);
  } catch {
    // FMCSA is down: keep using what we had.
    return cached?.current;
  }
  if (!rec) return undefined;
  const changed = cached && identity(cached.current) !== identity(rec);
  const history = changed ? [...cached!.history, { ...cached!.current, fetchedAt: rec.fetchedAt }].slice(-HISTORY) : (cached?.history ?? []);
  ctx.store.fmcsa.set(dot, { current: rec, history, lastVerdict: cached?.lastVerdict });
  return rec;
}

/** How a carrier looks to a shipper or broker under its own rules. */
export async function vettingFor(ctx: AppContext, carrierOrgId: string, payerOrgId?: string, force = false): Promise<VettingResult & { record?: FmcsaRecord }> {
  if (!ctx.fmcsa) return { verdict: "NOT_CHECKED", checks: [] };
  const org = ctx.store.orgs.get(carrierOrgId);
  if (!org) throw new HttpError(404, "NOT_FOUND", "Carrier not found");
  const dot = org.dotNumber?.replace(/\D/g, "");
  const record = dot ? await fmcsaRecord(ctx, dot, force) : undefined;
  const admins = ctx.store.memberships.filter((m) => m.orgId === carrierOrgId && (m.roles.includes("OWNER") || m.roles.includes("ADMIN")));
  const otherOrgsWithDot = dot ? [...ctx.store.orgs.values()].filter((o) => o.id !== carrierOrgId && o.dotNumber?.replace(/\D/g, "") === dot).length : 0;
  const result = vetCarrier({
    org,
    record,
    history: dot ? ctx.store.fmcsa.get(dot)?.history : undefined,
    contactEmails: admins.map((m) => ctx.store.accounts.get(m.accountId)?.email).filter((e): e is string => !!e),
    otherOrgsWithDot,
    policy: (payerOrgId && ctx.store.orgs.get(payerOrgId)?.vetting) || DEFAULT_VETTING_POLICY,
    now: ctx.now().toISOString(),
  });
  return { ...result, record };
}

export const approvalKey = (payerOrgId: string, carrierOrgId: string) => `${payerOrgId}|${carrierOrgId}`;

/**
 * Before tendering or awarding: a carrier that fails is refused; one that
 * needs review goes through only once someone at the shipper or broker has
 * looked and approved it.
 */
export async function requireEligible(ctx: AppContext, payerOrgId: string, carrierOrgId: string): Promise<void> {
  const v = await vettingFor(ctx, carrierOrgId, payerOrgId);
  if (v.verdict === "NOT_CHECKED" || v.verdict === "PASS") return;
  const problems = v.checks.filter((c) => c.result === v.verdict).map((c) => c.title);
  if (v.verdict === "FAIL") throw new HttpError(409, "CARRIER_NOT_ELIGIBLE", `This carrier can't be used: ${problems.join("; ")}.`);
  if (!ctx.store.carrierApprovals.get(approvalKey(payerOrgId, carrierOrgId))) throw new HttpError(409, "CARRIER_NEEDS_REVIEW", `Review this carrier first: ${problems.join("; ")}. Approve it from the carrier check.`);
}

/**
 * Job: re-check, once a day, carriers holding loads that haven't delivered.
 * If one stops passing (authority revoked, insurance lapsed, put out of
 * service), tell the shipper or broker on each of its loads, once.
 */
export async function recheckCarriers(ctx: AppContext): Promise<number> {
  if (!ctx.fmcsa) return 0;
  const active = [...ctx.store.loads.values()].filter((l) => l.carrierOrgId && ["BOOKED", "DISPATCHED", "AT_PICKUP", "IN_TRANSIT", "AT_DELIVERY"].includes(l.status));
  const carriers = new Set(active.map((l) => l.carrierOrgId!));
  let alerts = 0;
  for (const carrierOrgId of carriers) {
    const dot = ctx.store.orgs.get(carrierOrgId)?.dotNumber?.replace(/\D/g, "");
    if (!dot) continue;
    const v = await vettingFor(ctx, carrierOrgId);
    const entry = ctx.store.fmcsa.get(dot);
    if (!entry || entry.lastVerdict === v.verdict) continue;
    ctx.store.fmcsa.set(dot, { ...entry, lastVerdict: v.verdict });
    if (v.verdict !== "FAIL" || entry.lastVerdict === undefined) continue;
    const why = v.checks.filter((c) => c.result === "FAIL").map((c) => c.title).join("; ");
    for (const l of active.filter((x) => x.carrierOrgId === carrierOrgId)) {
      postMessage(ctx, l, { senderAccountId: "system", kind: "SYSTEM", body: `Carrier check failed: ${why}. Consider releasing the carrier.` });
      ctx.notifier.carrierAlert(l, `Carrier check failed: ${l.loadNumber}`, `${ctx.store.orgs.get(carrierOrgId)?.name}: ${why}.`);
      alerts++;
    }
  }
  return alerts;
}

/** Whether the carrier's own driver's phone was at the pickup when the freight was loaded. */
export function pickupCheck(ctx: AppContext, load: Load): { status: "VERIFIED" | "UNVERIFIED" | "PENDING"; detail: string } {
  const pickup = [...load.stops].sort((a, b) => a.sequence - b.sequence).find((s) => s.type === "PICKUP");
  const visit = load.visits?.find((v) => v.stopId === pickup?.id && v.source === "GEOFENCE");
  if (visit) return { status: "VERIFIED", detail: `A ${ctx.store.orgs.get(load.carrierOrgId ?? "")?.name ?? "carrier"} driver's phone was at the pickup.` };
  if (!load.pickedUpAt) return { status: "PENDING", detail: "Checked when the truck reaches the pickup." };
  return { status: "UNVERIFIED", detail: "Picked up without the carrier's driver location at the dock. Confirm the truck and driver belong to the carrier you booked." };
}
