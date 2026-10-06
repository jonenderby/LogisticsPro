import { AchOriginator, BankAccountInput, type Invoice, type Organization, balance, buildNachaFile, isOpen, newId, nextBusinessDay, recordPayment, rmrAddenda } from "@logisticspro/domain";
import { tx } from "@logisticspro/workspace";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, hasOrgCap, me, parse, requireOrgCap } from "../http.js";
import { seal, unseal } from "../security/sealed.js";
import { acceptTotpCode } from "../security/stepup.js";
import { announceRemitChange } from "../services/remit.js";
import type { PaymentRun } from "../store.js";

const BANK = "bank-account";
const FILE = "ach-file";
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PAYABLE = ["APPROVED", "PARTIALLY_PAID"];

/**
 * Paying carriers by ACH. A carrier gives the bank account it is paid to
 * (a fresh authenticator code, and every customer is told). A shipper or
 * broker picks approved invoices and gets a NACHA file to upload to its bank;
 * once uploaded, marking it sent records the payments.
 */
export function achRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };
  const key = () => ctx.cfg.dataKey ?? ctx.cfg.jwtSecret;
  const stepUp = (account: { id: string; mfa: { totpSecret?: string } }, code: string) => {
    if (!acceptTotpCode(ctx, account.id, account.mfa.totpSecret, code)) throw new HttpError(400, "BAD_CODE", "That authenticator code did not match");
  };
  const org = (id: string): Organization => {
    const o = ctx.store.orgs.get(id);
    if (!o) throw new HttpError(404, "NOT_FOUND", "Organization not found");
    return o;
  };

  // ------------------------------------------------------------ the carrier's bank account

  app.put("/v1/orgs/:orgId/payout-account", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "MANAGE_ORG");
    const carrier = org(orgId);
    if (!carrier.kinds.includes("CARRIER")) throw new HttpError(400, "INVALID_REQUEST", "Bank accounts for ACH are for carriers");
    const body = parse(z.union([BankAccountInput.extend({ code: z.string().min(6).max(8) }), z.object({ remove: z.literal(true), code: z.string().min(6).max(8) })]), req.body);
    stepUp(account, body.code);
    if ("remove" in body) {
      ctx.store.orgs.set(orgId, { ...carrier, payoutAccount: undefined });
      const notified = announceRemitChange(ctx, carrier, account, "Bank details for ACH were removed.");
      return { payoutAccount: null, customersNotified: notified };
    }
    const id = newId("bank");
    ctx.store.bankAccounts.set(id, { orgId, sealed: seal(key(), BANK, JSON.stringify({ routingNumber: body.routingNumber, accountNumber: body.accountNumber })), createdAt: ctx.now().toISOString() });
    const payoutAccount = { id, holderName: body.holderName, routingNumber: body.routingNumber, last4: body.accountNumber.slice(-4), accountType: body.accountType, setAt: ctx.now().toISOString(), setByAccountId: account.id };
    ctx.store.orgs.set(orgId, { ...carrier, payoutAccount });
    const notified = announceRemitChange(ctx, carrier, account, `ACH payments now go to ${body.holderName}, account ending ${payoutAccount.last4}.`);
    return { payoutAccount, customersNotified: notified };
  });

  // ------------------------------------------------------------ the payer's bank

  app.put("/v1/orgs/:orgId/ach-originator", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "PAY");
    const payer = org(orgId);
    if (!payer.kinds.some((k) => k === "SHIPPER" || k === "BROKER_3PL")) throw new HttpError(400, "INVALID_REQUEST", "ACH payment files are for shippers and brokers");
    const achOriginator = parse(AchOriginator, req.body);
    ctx.store.orgs.set(orgId, { ...payer, achOriginator });
    return achOriginator;
  });

  // ------------------------------------------------------------ payment runs

  const inOpenRun = (invoiceId: string) => ctx.store.paymentRuns.where("invoice", invoiceId).some((r) => r.status === "CREATED");
  const runView = (r: PaymentRun) => {
    const { sealedFile: _, ...rest } = r;
    return rest;
  };
  const myRun = (accountId: string, id: string) => {
    const r = ctx.store.paymentRuns.get(id);
    if (!r || !hasOrgCap(ctx, accountId, r.orgId, "PAY")) throw new HttpError(404, "NOT_FOUND", "Payment run not found");
    return r;
  };

  /** Invoices this payer can pay by ACH now, those it can't yet (and why), and earlier files. */
  app.get("/v1/orgs/:orgId/payment-runs", auth, async (req) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "PAY");
    const owed = ctx.store.invoicesOfParty(orgId).filter((i) => i.billTo.orgId === orgId && isOpen(i) && balance(i) > 0);
    const reason = (i: Invoice) =>
      // English here; the app translates it.
      !PAYABLE.includes(i.status) ? tx("Approve it first") : !i.remitTo?.bank ? tx("The carrier hasn't given bank details for ACH") : inOpenRun(i.id) ? tx("Already in a payment file") : undefined;
    return {
      originator: org(orgId).achOriginator ?? null,
      invoices: owed.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, loadNumber: i.loadNumber, carrierName: ctx.store.orgs.get(i.carrierOrgId)?.name ?? i.remitTo?.name, payee: i.remitTo?.name, last4: i.remitTo?.bank?.last4, balance: balance(i), status: i.status, notPayable: reason(i) })),
      runs: ctx.store.paymentRuns
        .where("org", orgId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(runView),
    };
  });

  /** A NACHA file paying the chosen invoices' balances. Needs a fresh authenticator code: it holds account numbers and moves money. */
  app.post("/v1/orgs/:orgId/payment-runs", auth, async (req, reply) => {
    const account = me(ctx, req);
    const { orgId } = req.params as { orgId: string };
    requireOrgCap(ctx, account.id, orgId, "PAY");
    const payer = org(orgId);
    const body = parse(z.object({ invoiceIds: z.array(z.string()).min(1).max(500), effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), code: z.string().min(6).max(8) }), req.body);
    if (!payer.achOriginator) throw new HttpError(409, "NO_ORIGINATOR", "Add your bank's ACH details first");
    stepUp(account, body.code);
    const today = ctx.now().toISOString().slice(0, 10);
    const effectiveDate = nextBusinessDay(body.effectiveDate && body.effectiveDate > today ? body.effectiveDate : new Date(ctx.now().getTime() + 86_400_000).toISOString().slice(0, 10));

    const credits = [...new Set(body.invoiceIds)].map((id) => {
      const inv = ctx.store.invoices.get(id);
      if (!inv || inv.billTo.orgId !== orgId) throw new HttpError(404, "NOT_FOUND", `Invoice ${id} not found`);
      if (!PAYABLE.includes(inv.status) || balance(inv) <= 0) throw new HttpError(409, "NOT_PAYABLE", `Invoice ${inv.invoiceNumber} isn't approved for payment`);
      if (inOpenRun(inv.id)) throw new HttpError(409, "ALREADY_IN_RUN", `Invoice ${inv.invoiceNumber} is already in a payment file`);
      const bank = inv.remitTo?.bank;
      const stored = bank && ctx.store.bankAccounts.get(bank.accountRef);
      if (!bank || !stored) throw new HttpError(409, "NO_BANK", `${inv.remitTo?.name ?? "The carrier"} hasn't given bank details for invoice ${inv.invoiceNumber}`);
      const numbers = JSON.parse(unseal(key(), BANK, stored.sealed)) as { routingNumber: string; accountNumber: string };
      const amount = balance(inv);
      return { inv, amount, credit: { name: bank.holderName, routingNumber: numbers.routingNumber, accountNumber: numbers.accountNumber, accountType: bank.accountType, amountCents: Math.round(amount * 100), id: inv.invoiceNumber, addenda: rmrAddenda(inv.invoiceNumber, amount) } };
    });
    const file = buildNachaFile({ originator: payer.achOriginator, credits: credits.map((c) => c.credit), effectiveDate, createdAt: ctx.now().toISOString(), fileIdModifier: String.fromCharCode(65 + (ctx.store.paymentRuns.where("org", orgId).length % 26)) });
    const run: PaymentRun = {
      id: newId("run"),
      orgId,
      status: "CREATED",
      effectiveDate,
      entries: credits.map((c, i) => ({ invoiceId: c.inv.id, invoiceNumber: c.inv.invoiceNumber, carrierOrgId: c.inv.carrierOrgId, payeeName: c.credit.name, last4: c.inv.remitTo!.bank!.last4, amount: c.amount, traceNumber: file.traceNumbers[i]! })),
      total: file.totalCents / 100,
      fileName: `ach-${effectiveDate}-${payer.name.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}.txt`,
      sealedFile: seal(key(), FILE, file.text),
      createdAt: ctx.now().toISOString(),
      createdByAccountId: account.id,
    };
    ctx.store.paymentRuns.set(run.id, run);
    reply.code(201);
    return { run: runView(run), file: { name: run.fileName, content: file.text } };
  });

  /** Download the file again. Needs a fresh authenticator code. */
  app.post("/v1/payment-runs/:id/file", auth, async (req) => {
    const account = me(ctx, req);
    const run = myRun(account.id, (req.params as { id: string }).id);
    const { code } = parse(z.object({ code: z.string().min(6).max(8) }), req.body);
    stepUp(account, code);
    return { name: run.fileName, content: unseal(key(), FILE, run.sealedFile) };
  });

  /** The file went to the bank: record each payment and tell each carrier. */
  app.post("/v1/payment-runs/:id/sent", auth, async (req) => {
    const account = me(ctx, req);
    const run = myRun(account.id, (req.params as { id: string }).id);
    if (run.status !== "CREATED") throw new HttpError(409, "NOT_OPEN", `This payment file is already ${run.status.toLowerCase()}`);
    const now = ctx.now().toISOString();
    const skipped: string[] = [];
    for (const e of run.entries) {
      const inv = ctx.store.invoices.get(e.invoiceId);
      // Paid some other way meanwhile: the carrier gets the ACH too, so say so rather than hide it.
      if (!inv || !isOpen(inv) || balance(inv) + 0.005 < e.amount) {
        skipped.push(e.invoiceNumber);
        continue;
      }
      const next = recordPayment(inv, { amount: e.amount, paidOn: run.effectiveDate, method: "ACH", reference: e.traceNumber }, account.id, now);
      ctx.store.invoices.set(next.id, next);
      ctx.notifier.payment(inv.carrierOrgId, [inv.createdByAccountId], { title: `ACH sent: ${inv.invoiceNumber}`, body: `${ctx.store.orgs.get(run.orgId)?.name} sent ${money(e.amount)} by ACH to the account ending ${e.last4}, effective ${run.effectiveDate}. Trace ${e.traceNumber}.`, loadId: inv.loadId, invoiceId: inv.id });
    }
    const sent = { ...run, status: "SENT" as const, sentAt: now, sentByAccountId: account.id };
    ctx.store.paymentRuns.set(run.id, sent);
    return { run: runView(sent), skipped };
  });

  app.post("/v1/payment-runs/:id/cancel", auth, async (req) => {
    const account = me(ctx, req);
    const run = myRun(account.id, (req.params as { id: string }).id);
    if (run.status !== "CREATED") throw new HttpError(409, "NOT_OPEN", `This payment file is already ${run.status.toLowerCase()}`);
    const cancelled = { ...run, status: "CANCELLED" as const, cancelledAt: ctx.now().toISOString() };
    ctx.store.paymentRuns.set(run.id, cancelled);
    return runView(cancelled);
  });
}
