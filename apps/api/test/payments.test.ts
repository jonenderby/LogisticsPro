import { describe, expect, it } from "vitest";
import { totp } from "../src/security/totp.js";
import { NYC, api, harness, loadBody, signUp } from "./helpers.js";

const DAY = 86_400_000;

describe("getting paid", () => {
  it("runs an invoice from sent to paid, with quick pay, factoring and aging", async () => {
    let now = Date.parse("2026-10-05T15:00:00Z");
    const h = await harness({ now: () => new Date(now) });
    const S = api(h, await signUp(h, "BUSINESS", "Payables Pat"));
    const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
    await S.put(`/v1/orgs/${acme.id}/payer-terms`, { termsDays: 30, quickPay: { days: 2, feePct: 3 } });
    const olga = await signUp(h, "CARRIER", "Owner Olga");
    const F = api(h, olga);
    const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"], scac: "BIGF" })).org;
    await F.put(`/v1/orgs/${fleet.id}/payer-terms`, { termsDays: 5 }, 400);
    const ana = await signUp(h, "TRUCKER", "Ana");
    await F.post(`/v1/orgs/${fleet.id}/members`, { email: ana.email, roles: ["DRIVER"] }, 201);
    const A = api(h, ana);
    const outsider = api(h, await signUp(h, "BUSINESS", "Nosy Ned"));

    const deliveredLoad = async () => {
      const load = await S.post("/v1/loads", loadBody(acme.id), 201);
      await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
      await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
      await F.post(`/v1/loads/${load.id}/legs/first/assign`, { driverAccountIds: [ana.accountId] });
      for (const code of ["ARRIVED_PICKUP", "LOADED", "ARRIVED_DELIVERY", "DELIVERED"]) await A.post(`/v1/loads/${load.id}/status`, { code });
      return load;
    };

    // Payments go to a factoring company only with a fresh authenticator code.
    const first = await deliveredLoad();
    now += 30_000; // the code from sign-up was used; wait for the next one
    await F.put(`/v1/orgs/${fleet.id}/factoring`, { company: "Fast Factor LLC", email: "ar@fastfactor.example", code: "000000" }, 400);
    await A.post(`/v1/orgs/${fleet.id}/factoring`, {}, 404);
    const set = await F.put(`/v1/orgs/${fleet.id}/factoring`, { company: "Fast Factor LLC", email: "ar@fastfactor.example", code: totp(olga.totpSecret, now) });
    expect(set).toMatchObject({ factoring: { company: "Fast Factor LLC" }, customersNotified: 1 });
    await F.put(`/v1/orgs/${fleet.id}/factoring`, { company: "Other LLC", code: totp(olga.totpSecret, now) }, 400); // a code works once
    const told = (await S.get("/v1/me/notifications")).items;
    expect(told[0]).toMatchObject({ kind: "PAYMENT", title: "Big Fleet changed where it gets paid" });
    expect(told[0].body).toContain("call Big Fleet at a number you already have");

    // The invoice: remit to the factor, net 30 from the payer's terms, payer told.
    const { invoice } = await A.post(`/v1/loads/${first.id}/invoices`, {}, 201);
    expect(invoice).toMatchObject({ status: "SENT", terms: "NET30", termsDays: 30, remitTo: { kind: "FACTOR", name: "Fast Factor LLC" }, total: 5200 });
    expect((await S.get("/v1/me/notifications")).items[0]).toMatchObject({ kind: "PAYMENT", target: "INVOICE", invoiceId: invoice.id, title: `Invoice ${invoice.invoiceNumber}: $5200.00` });
    let view = await S.get(`/v1/invoices/${invoice.id}`);
    expect(view).toMatchObject({ dueDate: "2026-11-04", owed: 5200, balance: 5200, canPay: true, canBill: false, quickPayOffer: { days: 2, feePct: 3 } });
    await outsider.get(`/v1/invoices/${invoice.id}`, 404);

    // A later remit-to change doesn't redirect money already invoiced.
    now += 60_000;
    await F.put(`/v1/orgs/${fleet.id}/factoring`, { company: null, code: totp(olga.totpSecret, now + 30_000) });
    expect((await S.get(`/v1/invoices/${invoice.id}`)).remitTo.name).toBe("Fast Factor LLC");

    // Quick pay: asked by the driver who invoiced, approved by the payer.
    await S.post(`/v1/invoices/${invoice.id}/quick-pay`, {}, 403);
    const asked = await A.post(`/v1/invoices/${invoice.id}/quick-pay`);
    expect(asked.quickPay).toMatchObject({ status: "REQUESTED", fee: 156, netAmount: 5044 });
    expect((await S.get("/v1/me/notifications")).items[0].title).toBe(`Quick pay requested: ${invoice.invoiceNumber}`);
    await A.post(`/v1/invoices/${invoice.id}/quick-pay`, {}, 409);
    expect((await S.get("/v1/me")).feed).toEqual(expect.arrayContaining([expect.objectContaining({ id: `qp:${invoice.id}`, invoiceId: invoice.id, cta: { label: "Decide", action: "open-invoice" } })]));
    now += DAY;
    view = await S.post(`/v1/invoices/${invoice.id}/quick-pay/decision`, { approve: true });
    expect(view).toMatchObject({ status: "APPROVED", owed: 5044, dueDate: "2026-10-08" });
    expect((await A.get("/v1/me/notifications")).items[0]).toMatchObject({ title: `Quick pay approved: ${invoice.invoiceNumber}`, body: "$5,044.00 will be paid by 2026-10-08." });

    // Payments: only the payer records them; part, too much, then the rest.
    await F.post(`/v1/invoices/${invoice.id}/payments`, { amount: 100 }, 403);
    view = await S.post(`/v1/invoices/${invoice.id}/payments`, { amount: 3000, method: "ACH", reference: "ACH-1" }, 201);
    expect(view).toMatchObject({ status: "PARTIALLY_PAID", paid: 3000, balance: 2044 });
    await S.post(`/v1/invoices/${invoice.id}/payments`, { amount: 2500 }, 400);
    view = await S.post(`/v1/invoices/${invoice.id}/payments`, { amount: 2044, method: "CHECK", reference: "CHK 88" }, 201);
    expect(view).toMatchObject({ status: "PAID", balance: 0 });
    expect(view.history.map((x: { status: string }) => x.status)).toEqual(["SENT", "QUICK_PAY_REQUESTED", "QUICK_PAY_APPROVED", "PARTIALLY_PAID", "PAID"]);
    expect((await F.get("/v1/me/notifications")).items[0].title).toBe(`Paid: ${invoice.invoiceNumber}`);

    // Disputes need a reason; aging shows what's late.
    const second = await deliveredLoad();
    const inv2 = (await F.post(`/v1/loads/${second.id}/invoices`, { invoiceNumber: "INV-2" }, 201)).invoice;
    expect(inv2.remitTo).toMatchObject({ kind: "CARRIER", name: "Big Fleet" });
    await S.post(`/v1/invoices/${inv2.id}/status`, { status: "DISPUTED" }, 400);
    expect(await S.post(`/v1/invoices/${inv2.id}/status`, { status: "DISPUTED", note: "Detention not on rate con" })).toMatchObject({ status: "DISPUTED", disputeReason: "Detention not on rate con" });
    expect((await F.get("/v1/me")).feed).toEqual(expect.arrayContaining([expect.objectContaining({ id: `dispute:${inv2.id}`, subtitle: "Detention not on rate con" })]));
    expect(await S.post(`/v1/invoices/${inv2.id}/status`, { status: "APPROVED" })).toMatchObject({ status: "APPROVED" });
    now += 45 * DAY;
    const aging = await F.get(`/v1/orgs/${fleet.id}/aging`);
    expect(aging.receivable).toMatchObject({ open: 5200, overdue: 5200, averageDaysToPay: 1, buckets: { DAYS_1_30: { count: 1, amount: 5200 } } });
    expect(aging.receivable.customers).toEqual([expect.objectContaining({ orgId: acme.id, name: "Acme Foods", open: 5200 })]);
    expect(aging.payable).toBeUndefined();
    expect((await S.get(`/v1/orgs/${acme.id}/aging`)).payable).toMatchObject({ open: 5200, carriers: [expect.objectContaining({ name: "Big Fleet" })] });
    await A.get(`/v1/orgs/${fleet.id}/aging`, 403);
    expect((await S.get(`/v1/invoices/${inv2.id}`)).daysLate).toBe(15);
    expect((await F.get("/v1/me")).feed).toEqual(expect.arrayContaining([expect.objectContaining({ id: `overdue:${inv2.id}`, title: "Invoice INV-2 is overdue" })]));
    expect((await S.get("/v1/me")).feed).toEqual(expect.arrayContaining([expect.objectContaining({ id: `late:${inv2.id}` })]));
  });
});
