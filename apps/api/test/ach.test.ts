import { describe, expect, it } from "vitest";
import { totp } from "../src/security/totp.js";
import { NYC, api, harness, loadBody, signUp } from "./helpers.js";

describe("paying carriers by ACH", () => {
  it("takes the carrier's bank details with a fresh code and pays approved invoices in a NACHA file", async () => {
    let now = Date.parse("2026-10-05T15:00:00Z");
    const h = await harness({ now: () => new Date(now) });
    const pat = await signUp(h, "BUSINESS", "Payables Pat");
    const S = api(h, pat);
    const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
    const olga = await signUp(h, "CARRIER", "Owner Olga");
    const F = api(h, olga);
    const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"], scac: "BIGF" })).org;
    const code = (who: { totpSecret: string }) => {
      now += 30_000; // each code works once
      return totp(who.totpSecret, now);
    };
    const delivered = async () => {
      const load = await S.post("/v1/loads", loadBody(acme.id), 201);
      await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
      await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
      for (const c of ["LOADED", "DELIVERED"]) await F.post(`/v1/loads/${load.id}/status`, { code: c });
      return load;
    };

    // An invoice sent before bank details can't be paid by ACH.
    const early = (await F.post(`/v1/loads/${(await delivered()).id}/invoices`, { invoiceNumber: "INV-EARLY" }, 201)).invoice;
    expect(early.remitTo.bank).toBeUndefined();

    // Bank details: valid numbers and a fresh code.
    await F.put(`/v1/orgs/${fleet.id}/payout-account`, { holderName: "Big Fleet LLC", routingNumber: "121000248", accountNumber: "000123456789", accountType: "CHECKING", code: "000000" }, 400);
    await F.put(`/v1/orgs/${fleet.id}/payout-account`, { holderName: "Big Fleet LLC", routingNumber: "121000249", accountNumber: "000123456789", accountType: "CHECKING", code: code(olga) }, 400);
    const set = await F.put(`/v1/orgs/${fleet.id}/payout-account`, { holderName: "Big Fleet LLC", routingNumber: "121000248", accountNumber: "000123456789", accountType: "CHECKING", code: code(olga) });
    expect(set.payoutAccount).toMatchObject({ last4: "6789", routingNumber: "121000248" });
    expect(set.payoutAccount.accountNumber).toBeUndefined();
    expect(JSON.stringify(h.ctx.store.orgs.get(fleet.id))).not.toContain("000123456789");
    expect(JSON.stringify([...h.ctx.store.bankAccounts.values()])).not.toContain("000123456789");
    // Acme has open business with Big Fleet, so it is told.
    expect(set.customersNotified).toBe(1);
    expect((await S.get("/v1/me/notifications")).items[0].title).toBe("Big Fleet changed where it gets paid");

    const inv = (await F.post(`/v1/loads/${(await delivered()).id}/invoices`, { invoiceNumber: "INV-ACH" }, 201)).invoice;
    expect(inv.remitTo.bank).toMatchObject({ last4: "6789", holderName: "Big Fleet LLC" });

    // The payer sets up its bank, then sees what it can pay.
    await S.put(`/v1/orgs/${acme.id}/ach-originator`, { companyName: "Acme Foods", companyId: "1123456789", bankRoutingNumber: "021000021", bankName: "JPMorgan Chase" });
    let runs = await S.get(`/v1/orgs/${acme.id}/payment-runs`);
    expect(runs.invoices.find((i: { id: string }) => i.id === inv.id).notPayable).toBe("Approve it first");
    await S.post(`/v1/invoices/${inv.id}/status`, { status: "APPROVED" });
    await S.post(`/v1/invoices/${early.id}/status`, { status: "APPROVED" });
    runs = await S.get(`/v1/orgs/${acme.id}/payment-runs`);
    expect(runs.invoices.find((i: { id: string }) => i.id === inv.id).notPayable).toBeUndefined();
    expect(runs.invoices.find((i: { id: string }) => i.id === early.id).notPayable).toBe("The carrier hasn't given bank details for ACH");

    // Only the payer, with a fresh code.
    await F.post(`/v1/orgs/${acme.id}/payment-runs`, { invoiceIds: [inv.id], code: code(olga) }, 403);
    await S.post(`/v1/orgs/${acme.id}/payment-runs`, { invoiceIds: [early.id], code: code(pat) }, 409);
    const made = await S.post(`/v1/orgs/${acme.id}/payment-runs`, { invoiceIds: [inv.id], code: code(pat) }, 201);
    expect(made.run).toMatchObject({ status: "CREATED", total: 5200, effectiveDate: "2026-10-06", entries: [{ invoiceNumber: "INV-ACH", last4: "6789", amount: 5200 }] });
    expect(made.run.sealedFile).toBeUndefined();
    const lines = made.file.content.trimEnd().split("\n");
    expect(lines[2]).toContain("000123456789");
    expect(lines[2].slice(29, 39)).toBe("0000520000");
    expect(lines[3]).toContain("RMR*IV*INV-ACH**5200.00");
    // Not twice.
    await S.post(`/v1/orgs/${acme.id}/payment-runs`, { invoiceIds: [inv.id], code: code(pat) }, 409);
    // Downloading again needs a code.
    await S.post(`/v1/payment-runs/${made.run.id}/file`, { code: "000000" }, 400);
    expect((await S.post(`/v1/payment-runs/${made.run.id}/file`, { code: code(pat) })).content).toBe(made.file.content);

    // Sent to the bank: the payment is recorded and the carrier told.
    const sent = await S.post(`/v1/payment-runs/${made.run.id}/sent`);
    expect(sent.run.status).toBe("SENT");
    const paid = await S.get(`/v1/invoices/${inv.id}`);
    expect(paid).toMatchObject({ status: "PAID", balance: 0 });
    expect(paid.payments[0]).toMatchObject({ method: "ACH", reference: made.run.entries[0].traceNumber, paidOn: "2026-10-06" });
    expect((await F.get("/v1/me/notifications")).items[0].title).toBe("ACH sent: INV-ACH");
    await S.post(`/v1/payment-runs/${made.run.id}/sent`, {}, 409);

    // Changing factoring drops the bank account, which belonged to the old payee.
    const fact = await F.put(`/v1/orgs/${fleet.id}/factoring`, { company: "Fast Factor LLC", code: code(olga) });
    expect(fact.bankCleared).toBe(true);
    expect(h.ctx.store.orgs.get(fleet.id)!.payoutAccount).toBeUndefined();
  });
});

describe("remittance advice (EDI 820)", () => {
  it("records payments a payer's system reports, and sends 820s to carriers that take them", async () => {
    const h = await harness();
    const S = api(h, await signUp(h, "BUSINESS", "AP Annie"));
    const acme = (await S.post("/v1/orgs", { name: "Acme Foods", kinds: ["SHIPPER"], address: NYC })).org;
    const F = api(h, await signUp(h, "CARRIER", "Owner Otto"));
    const fleet = (await F.post("/v1/orgs", { name: "Big Fleet", kinds: ["CARRIER"], scac: "BIGF" })).org;
    // The carrier's own accounting system takes remittance advice as EDI.
    await F.put(`/v1/orgs/${fleet.id}/receiving`, { channels: { PAYMENT_ADVICE: { method: "EDI_X12", transport: "VAN" } }, edi: { senderQualifier: "ZZ", senderId: "LOGISTICSPRO", receiverQualifier: "ZZ", receiverId: "BIGFLEETAR", usage: "T", ackRequested: false } });
    const invoiceFor = async (number: string) => {
      const load = await S.post("/v1/loads", loadBody(acme.id), 201);
      await S.post(`/v1/loads/${load.id}/tender`, { carrierOrgId: fleet.id });
      await F.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT" });
      for (const c of ["LOADED", "DELIVERED"]) await F.post(`/v1/loads/${load.id}/status`, { code: c });
      const inv = (await F.post(`/v1/loads/${load.id}/invoices`, { invoiceNumber: number }, 201)).invoice;
      await S.post(`/v1/invoices/${inv.id}/status`, { status: "APPROVED" });
      return inv;
    };
    const one = await invoiceFor("INV-820-1");
    const two = await invoiceFor("INV-820-2");

    // Acme's ERP posts its remittance to Logistics Pro.
    await S.put(`/v1/orgs/${acme.id}/partners/acme-erp`, { name: "Acme ERP", kind: "SHIPPER", channels: {} });
    const { inboundToken } = await S.post(`/v1/orgs/${acme.id}/partners/acme-erp/inbound-token`);
    const advice = {
      paymentRef: "CHK 10442", paymentDate: "2026-10-06", method: "CHECK", currency: "USD", totalAmount: 7200, payerName: "Acme Foods", payeeName: "Big Fleet",
      invoices: [{ invoiceNumber: "INV-820-1", amountPaid: 5200 }, { invoiceNumber: "INV-820-2", amountPaid: 2000 }, { invoiceNumber: "NOT-OURS", amountPaid: 1 }],
    };
    const before = h.van.sent.length;
    const res = await h.app.inject({ method: "POST", url: `/v1/inbound/${acme.id}/acme-erp/payment_advice`, payload: advice, headers: { "x-lp-inbound-token": inboundToken } });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().action).toBe("payment recorded on INV-820-1, INV-820-2; no open invoice for NOT-OURS");
    expect(await S.get(`/v1/invoices/${one.id}`)).toMatchObject({ status: "PAID", payments: [{ method: "CHECK", reference: "CHK 10442", paidOn: "2026-10-06" }] });
    expect(await S.get(`/v1/invoices/${two.id}`)).toMatchObject({ status: "PARTIALLY_PAID", balance: 3200 });
    expect((await F.get("/v1/me/notifications")).items.map((n: { title: string }) => n.title)).toEqual(expect.arrayContaining(["Paid: INV-820-1", "Part paid: INV-820-2"]));
    // Nothing matching is an error the ERP sees.
    const none = await h.app.inject({ method: "POST", url: `/v1/inbound/${acme.id}/acme-erp/payment_advice`, payload: { ...advice, invoices: [{ invoiceNumber: "NOT-OURS", amountPaid: 1 }] }, headers: { "x-lp-inbound-token": inboundToken } });
    expect(none.statusCode).toBe(404);

    // Paying the rest in the app sends the carrier's system an 820.
    await S.post(`/v1/invoices/${two.id}/payments`, { amount: 3200, method: "WIRE", reference: "FW-88" }, 201);
    const edi = h.van.sent.slice(before).map((m) => m.body).find((b) => b.includes("ST*820"));
    expect(edi).toBeDefined();
    expect(edi).toContain("BPR*C*3200.00*C*FWT");
    expect(edi).toContain("TRN*1*FW-88");
    expect(edi).toContain("RMR*IV*INV-820-2*PI*3200.00*5200.00");
  });
});
