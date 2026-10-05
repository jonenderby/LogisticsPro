import type { IntegrationMethod, InboundEdiResult, TransactionType, TransportKind } from "@logisticspro/integration";
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

/** The shipment id a document refers to, used to find which business it belongs to. */
export function shipmentIdOf(doc: unknown): string | undefined {
  return (doc as { shipmentId?: string }).shipmentId;
}
