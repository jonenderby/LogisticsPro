import { isOpen, type Organization } from "@logisticspro/domain";
import { type AppContext, postMessage } from "../http.js";
import { MOVING } from "./tracking.js";

/**
 * Tell everyone who pays a carrier, and the carrier's own office, that where
 * it gets paid changed. Redirected payments are how freight fraud gets paid,
 * so nobody should learn of a change only from the next invoice.
 */
export function announceRemitChange(ctx: AppContext, org: Organization, byAccount: { id: string; name: string }, what: string): number {
  const title = `${org.name} changed where it gets paid`;
  const body = `${what} Invoices already sent keep their remit-to. If you didn't expect this, call ${org.name} at a number you already have before paying.`;
  const payers = new Set<string>();
  for (const inv of ctx.store.invoicesOfParty(org.id)) if (inv.carrierOrgId === org.id && isOpen(inv) && inv.billTo.orgId) payers.add(inv.billTo.orgId);
  for (const l of ctx.store.loadsOfParty(org.id)) {
    if (l.carrierOrgId !== org.id || !["BOOKED", ...MOVING, "DELIVERED"].includes(l.status)) continue;
    payers.add(l.billTo.orgId ?? l.brokerOrgId ?? l.shipperOrgId);
    postMessage(ctx, l, { senderAccountId: byAccount.id, kind: "SYSTEM", body: `${title}. ${what}` });
  }
  for (const p of payers) ctx.notifier.payment(p, [], { title, body });
  ctx.notifier.payment(org.id, [], { title: "Remit-to changed", body: `${byAccount.name}: ${what} If this wasn't your team, change it back and contact support.` });
  return payers.size;
}
