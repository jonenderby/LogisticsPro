import { Address, DomainError, Factoring, type Invoice, PayerTerms, PaymentMethod, aging, agingBucket, amountOwed, amountPaid, balance, decideQuickPay, dueDate, isOpen, recordPayment, requestQuickPay, setInvoiceStatus, DEFAULT_PAYER_TERMS } from "@logisticspro/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, hasOrgCap, me, parse, postMessage, requireOrgCap } from "../http.js";
import { acceptTotpCode } from "../security/stepup.js";
import { MOVING } from "../services/tracking.js";
import { documentViews } from "./documents.js";

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Getting paid: the payer's terms and quick-pay offer, the carrier's
 * factoring company, the invoice from sent to paid, and aging for both sides.
 */
export function paymentRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };
  const today = () => ctx.now().toISOString().slice(0, 10);
  const orgName = (id?: string) => (id ? (ctx.store.orgs.get(id)?.name ?? id) : undefined);

  const isPayer = (accountId: string, inv: Invoice) => hasOrgCap(ctx, accountId, inv.billTo.orgId, "PAY");
  const isBiller = (accountId: string, inv: Invoice) => hasOrgCap(ctx, accountId, inv.carrierOrgId, "PAY") || inv.createdByAccountId === accountId;
  const find = (accountId: string, id: string) => {
    const inv = ctx.store.invoices.get(id);
    if (!inv || (!isPayer(accountId, inv) && !isBiller(accountId, inv) && !ctx.store.membershipsOf(accountId).some((m) => m.orgId === inv.carrierOrgId || m.orgId === inv.billTo.orgId))) throw new HttpError(404, "NOT_FOUND", "Invoice not found");
    return inv;
  };

  /** An invoice with what is owed, paid and due worked out. */
  const view = (inv: Invoice) => {
    const due = dueDate(inv);
    const late = Math.floor((Date.parse(today()) - Date.parse(due)) / 86_400_000);
    return {
      ...inv,
      dueDate: due,
      owed: amountOwed(inv),
      paid: amountPaid(inv),
      balance: balance(inv),
      daysLate: isOpen(inv) && late > 0 ? late : 0,
      bucket: isOpen(inv) ? agingBucket(due, today()) : undefined,
      carrierName: orgName(inv.carrierOrgId),
      billToName: orgName(inv.billTo.orgId) ?? inv.billTo.address.name,
      documents: documentViews(ctx, (ctx.store.loads.get(inv.loadId)?.documents ?? []).filter((d) => inv.documentIds?.includes(d.id) || ["BOL", "POD", "LUMPER_RECEIPT", "SCALE_TICKET"].includes(d.kind))),
    };
  };
  const save = (inv: Invoice) => {
    ctx.store.invoices.set(inv.id, inv);
    return view(inv);
  };
  const tellCarrier = (inv: Invoice, title: string, body: string) => ctx.notifier.payment(inv.carrierOrgId, [inv.createdByAccountId], { title, body, loadId: inv.loadId, invoiceId: inv.id });
  const tellPayer = (inv: Invoice, title: string, body: string) => ctx.notifier.payment(inv.billTo.orgId, [], { title, body, loadId: inv.loadId, invoiceId: inv.id });
  const domain = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof DomainError) throw new HttpError(e.status, e.code, e.message);
      throw e;
    }
  };

  // ------------------------------------------------------------ terms and remit-to

  app.put("/v1/orgs/:orgId/payer-terms", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "PAY");
    const org = ctx.store.orgs.get(orgId)!;
    if (!org.kinds.some((k) => k === "SHIPPER" || k === "BROKER_3PL")) throw new HttpError(400, "INVALID_REQUEST", "Payment terms are for shippers and brokers");
    const terms = parse(PayerTerms, req.body);
    ctx.store.orgs.set(orgId, { ...org, payerTerms: terms });
    return terms;
  });

  app.get("/v1/orgs/:orgId/payer-terms", auth, async (req) => {
    const { orgId } = req.params as { orgId: string };
    me(ctx, req);
    const org = ctx.store.orgs.get(orgId);
    if (!org) throw new HttpError(404, "NOT_FOUND", "Organization not found");
    return org.payerTerms ?? DEFAULT_PAYER_TERMS;
  });

  /**
   * Who a carrier's invoices are paid to. Redirecting payments is how
   * freight fraud gets paid, so a change needs a fresh authenticator code,
   * and every customer with open business is told, as is the carrier's own
   * owner and billing.
   */
  app.put("/v1/orgs/:orgId/factoring", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "MANAGE_ORG");
    const org = ctx.store.orgs.get(orgId)!;
    if (!org.kinds.includes("CARRIER")) throw new HttpError(400, "INVALID_REQUEST", "Factoring is for carriers");
    const body = parse(z.object({ company: z.string().trim().min(1).max(120).nullable(), email: z.string().email().max(254).optional(), address: Address.optional(), code: z.string().min(6).max(8) }), req.body);
    if (!acceptTotpCode(ctx, account.id, account.mfa.totpSecret, body.code)) throw new HttpError(400, "BAD_CODE", "That authenticator code did not match");
    const factoring = body.company ? Factoring.parse({ company: body.company, email: body.email, address: body.address, since: ctx.now().toISOString(), setByAccountId: account.id }) : undefined;
    ctx.store.orgs.set(orgId, { ...org, factoring });
    const now = factoring ? `${factoring.company}` : org.name;
    const title = `${org.name} changed where it gets paid`;
    const body2 = `New invoices are paid to ${now}${factoring ? " (factoring)" : ""}. Invoices already sent keep their remit-to. If you didn't expect this, call ${org.name} at a number you already have before paying.`;
    const payers = new Set<string>();
    for (const inv of ctx.store.invoicesOfParty(orgId)) if (inv.carrierOrgId === orgId && isOpen(inv) && inv.billTo.orgId) payers.add(inv.billTo.orgId);
    for (const l of ctx.store.loadsOfParty(orgId)) if (l.carrierOrgId === orgId && ["BOOKED", ...MOVING, "DELIVERED"].includes(l.status)) {
      payers.add(l.billTo.orgId ?? l.brokerOrgId ?? l.shipperOrgId);
      postMessage(ctx, l, { senderAccountId: account.id, kind: "SYSTEM", body: `${title}: ${now}.` });
    }
    for (const p of payers) ctx.notifier.payment(p, [], { title, body: body2 });
    ctx.notifier.payment(orgId, [], { title: "Remit-to changed", body: `${account.name} set payments to go to ${now}. If this wasn't your team, change it back and contact support.` });
    return { factoring: factoring ?? null, customersNotified: payers.size };
  });

  // ------------------------------------------------------------ invoices

  app.get("/v1/invoices", auth, async (req) => {
    const account = me(ctx, req);
    const mine = new Set(ctx.store.membershipsOf(account.id).map((m) => m.orgId));
    return ctx.store
      .invoicesOfParty(...mine, account.id)
      .filter((i) => mine.has(i.carrierOrgId) || (i.billTo.orgId && mine.has(i.billTo.orgId)) || i.createdByAccountId === account.id)
      .map(view)
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  });

  app.get("/v1/invoices/:id", auth, async (req) => {
    const account = me(ctx, req);
    const inv = find(account.id, (req.params as { id: string }).id);
    return { ...view(inv), canPay: isPayer(account.id, inv), canBill: isBiller(account.id, inv), quickPayOffer: (inv.billTo.orgId && ctx.store.orgs.get(inv.billTo.orgId)?.payerTerms?.quickPay) || undefined };
  });

  /** The payer marks an invoice received, approved, disputed or rejected. "PAID" records the balance as paid in one go. */
  app.post("/v1/invoices/:id/status", auth, async (req) => {
    const account = me(ctx, req);
    const inv = find(account.id, (req.params as { id: string }).id);
    if (!isPayer(account.id, inv)) throw new HttpError(403, "FORBIDDEN", "Only the customer's billing team updates this invoice");
    const { status, note } = parse(z.object({ status: z.enum(["ACKNOWLEDGED", "APPROVED", "DISPUTED", "REJECTED", "PAID"]), note: z.string().max(500).optional() }), req.body);
    const now = ctx.now().toISOString();
    if (status === "PAID") {
      const next = domain(() => recordPayment(inv, { amount: balance(inv), paidOn: today(), method: "OTHER", reference: note }, account.id, now));
      tellCarrier(next, `Paid: ${inv.invoiceNumber}`, `${orgName(inv.billTo.orgId)} paid ${money(balance(inv))} on load ${inv.loadNumber}.`);
      return save(next);
    }
    const next = domain(() => setInvoiceStatus(inv, status, account.id, now, note));
    if (status === "APPROVED") tellCarrier(next, `Approved: ${inv.invoiceNumber}`, `${orgName(inv.billTo.orgId)} approved ${money(amountOwed(next))} for payment by ${dueDate(next)}.`);
    if (status === "DISPUTED" || status === "REJECTED") tellCarrier(next, `${status === "DISPUTED" ? "Disputed" : "Rejected"}: ${inv.invoiceNumber}`, `${orgName(inv.billTo.orgId)}: ${note}`);
    return save(next);
  });

  app.post("/v1/invoices/:id/payments", auth, async (req, reply) => {
    const account = me(ctx, req);
    const inv = find(account.id, (req.params as { id: string }).id);
    if (!isPayer(account.id, inv)) throw new HttpError(403, "FORBIDDEN", "Only the customer's billing team records payments");
    const body = parse(z.object({ amount: z.number().positive(), paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), method: PaymentMethod.default("ACH"), reference: z.string().max(60).optional() }), req.body);
    if ((body.paidOn ?? today()) > today()) throw new HttpError(400, "INVALID_REQUEST", "Payment date is in the future");
    const next = domain(() => recordPayment(inv, { ...body, paidOn: body.paidOn ?? today() }, account.id, ctx.now().toISOString()));
    tellCarrier(next, next.status === "PAID" ? `Paid: ${inv.invoiceNumber}` : `Part paid: ${inv.invoiceNumber}`, `${orgName(inv.billTo.orgId)} paid ${money(body.amount)} by ${body.method}${body.reference ? ` (ref ${body.reference})` : ""}.${next.status === "PAID" ? "" : ` ${money(balance(next))} still owed.`}`);
    reply.code(201);
    return save(next);
  });

  app.post("/v1/invoices/:id/quick-pay", auth, async (req) => {
    const account = me(ctx, req);
    const inv = find(account.id, (req.params as { id: string }).id);
    if (!isBiller(account.id, inv)) throw new HttpError(403, "FORBIDDEN", "Only the carrier's billing asks for quick pay");
    const offer = inv.billTo.orgId ? ctx.store.orgs.get(inv.billTo.orgId)?.payerTerms?.quickPay : undefined;
    const next = domain(() => requestQuickPay(inv, offer, account.id, ctx.now().toISOString()));
    tellPayer(next, `Quick pay requested: ${inv.invoiceNumber}`, `${orgName(inv.carrierOrgId)} asks to be paid ${money(next.quickPay!.netAmount)} in ${offer!.days} days (${offer!.feePct}% fee) for load ${inv.loadNumber}.`);
    return save(next);
  });

  app.post("/v1/invoices/:id/quick-pay/decision", auth, async (req) => {
    const account = me(ctx, req);
    const inv = find(account.id, (req.params as { id: string }).id);
    if (!isPayer(account.id, inv)) throw new HttpError(403, "FORBIDDEN", "Only the customer's billing team decides quick pay");
    const { approve } = parse(z.object({ approve: z.boolean() }), req.body);
    const next = domain(() => decideQuickPay(inv, approve, account.id, ctx.now().toISOString()));
    tellCarrier(next, approve ? `Quick pay approved: ${inv.invoiceNumber}` : `Quick pay declined: ${inv.invoiceNumber}`, approve ? `${money(next.quickPay!.netAmount)} will be paid by ${dueDate(next)}.` : `It will be paid on the usual terms, by ${dueDate(next)}.`);
    return save(next);
  });

  // ------------------------------------------------------------ aging

  /** Open balances by age: receivables for a carrier, payables for a shipper or broker. */
  app.get("/v1/orgs/:orgId/aging", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "PAY");
    const all = ctx.store.invoicesOfParty(orgId);
    const receivable = all.filter((i) => i.carrierOrgId === orgId);
    const payable = all.filter((i) => i.billTo.orgId === orgId);
    const byParty = (list: Invoice[], key: (i: Invoice) => string | undefined) => {
      const m = new Map<string, Invoice[]>();
      for (const i of list.filter(isOpen)) m.set(key(i) ?? "other", [...(m.get(key(i) ?? "other") ?? []), i]);
      return [...m].map(([id, l]) => ({ orgId: id, name: orgName(id) ?? id, ...aging(l, today()) })).sort((a, b) => b.open - a.open);
    };
    return {
      today: today(),
      receivable: receivable.length ? { ...aging(receivable, today()), customers: byParty(receivable, (i) => i.billTo.orgId) } : undefined,
      payable: payable.length ? { ...aging(payable, today()), carriers: byParty(payable, (i) => i.carrierOrgId) } : undefined,
    };
  });
}
