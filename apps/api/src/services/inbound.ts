import type { IntegrationMethod, InboundEdiResult, TransactionType, TransportKind } from "@logisticspro/integration";

type AckResult = InboundEdiResult["acks"][number];
import { newId } from "@logisticspro/domain";
import type { AppContext } from "../http.js";
import type { StoredProfile } from "../store.js";

export function recordInbound(
  ctx: AppContext,
  p: Pick<StoredProfile, "key" | "ownerOrgId">,
  tx: TransactionType,
  method: IntegrationMethod,
  transport: TransportKind,
  payload: string,
  status: "RECEIVED" | "REJECTED",
  error?: string,
  refs: Record<string, string> = {},
) {
  ctx.store.transmissions.push({
    id: newId("rx"),
    partnerKey: p.key,
    ownerOrgId: p.ownerOrgId,
    transaction: tx,
    method,
    transport,
    direction: "INBOUND",
    status,
    contentType: method === "EDI_X12" ? "application/edi-x12" : method === "API_XML" ? "application/xml" : "application/json",
    payload,
    error,
    refs,
    createdAt: ctx.now().toISOString(),
  });
}

export interface AppliedDoc {
  set: string;
  transaction: TransactionType;
  orgId?: string;
  loadId?: string;
  invoiceId?: string;
  action?: string;
  error?: string;
}

/**
 * Apply every transaction set of a parsed interchange. `profileFor` picks the
 * business (and partner profile) each document belongs to; it may differ per
 * document when one partner trades with several businesses on the platform.
 */
export async function applyEdi(
  ctx: AppContext,
  raw: string,
  result: InboundEdiResult,
  profileFor: (doc: { transaction: TransactionType; doc: unknown }) => StoredProfile | { error: string },
  transport: TransportKind,
): Promise<AppliedDoc[]> {
  const applied: AppliedDoc[] = [];
  for (const d of result.documents) {
    const p = profileFor(d);
    if ("error" in p) {
      applied.push({ set: d.setControl, transaction: d.transaction, error: p.error });
      continue;
    }
    // A partner answering our test messages: recorded for onboarding, never applied to real freight.
    if (isTestDoc(d.doc)) {
      recordInbound(ctx, p, d.transaction, "EDI_X12", transport, raw, "RECEIVED", undefined, { test: "true", control: d.setControl });
      applied.push({ set: d.setControl, transaction: d.transaction, orgId: p.ownerOrgId, action: "test received" });
      continue;
    }
    try {
      const r = await ctx.hub.applyInbound(p.ownerOrgId, p.key, d.transaction, d.doc, "EDI");
      recordInbound(ctx, p, d.transaction, "EDI_X12", transport, raw, "RECEIVED", undefined, { ...(r.loadId ? { loadId: r.loadId } : {}), control: d.setControl });
      applied.push({ set: d.setControl, transaction: d.transaction, orgId: p.ownerOrgId, ...r });
    } catch (e) {
      recordInbound(ctx, p, d.transaction, "EDI_X12", transport, raw, "REJECTED", (e as Error).message);
      applied.push({ set: d.setControl, transaction: d.transaction, orgId: p.ownerOrgId, error: (e as Error).message });
    }
  }
  return applied;
}

/** Onboarding test traffic refers to TEST- shipments and invoices (see services/onboarding.ts). */
export function isTestDoc(doc: unknown): boolean {
  const d = doc as { shipmentId?: string; invoiceNumber?: string; invoices?: Array<{ invoiceNumber?: string }> };
  return !!(d.shipmentId?.startsWith("TEST-") || d.invoiceNumber?.startsWith("TEST-") || (d.invoices?.length && d.invoices.every((i) => i.invoiceNumber?.startsWith("TEST-"))));
}

/** The shipment id a document refers to, used to find which business it belongs to. */
export function shipmentIdOf(doc: unknown): string | undefined {
  return (doc as { shipmentId?: string }).shipmentId;
}

/**
 * Match 997 acknowledgments to what we sent: a group's control number names
 * one outbound interchange (control numbers never repeat), and only messages
 * sent to the partners `ours` allows can be acknowledged by this sender.
 */
export function applyAcks(ctx: AppContext, acks: AckResult[], ours: (t: { ownerOrgId: string; partnerKey: string }) => boolean): number {
  let matched = 0;
  for (const ack of acks) {
    const t = ctx.store.transmissions.find((x) => x.direction === "OUTBOUND" && x.method === "EDI_X12" && x.groupControl === ack.groupControl && ours(x));
    if (!t) continue;
    const rejected = !ack.accepted || ack.transactions.some((s) => !s.accepted);
    t.status = rejected ? "REJECTED" : "ACKNOWLEDGED";
    if (rejected) t.error = ack.transactions.find((s) => s.error)?.error ?? "Rejected by the partner's 997";
    t.refs = { ...t.refs, acknowledgedAt: ctx.now().toISOString() };
    ctx.store.transmissions.touch(t);
    matched++;
  }
  return matched;
}
