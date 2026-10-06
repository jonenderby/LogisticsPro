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
