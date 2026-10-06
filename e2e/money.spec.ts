import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { bookedLoad, call, freshCode, signIn, visible, world } from "./helpers";

test.describe("rate confirmations and getting paid", () => {
  test("the carrier opens the signed rate confirmation from the load", async ({ page }) => {
    const w = await world();
    const load = await bookedLoad(w);
    await signIn(page, w.owner);
    await page.goto(`/loads/load/${load.id}`);
    await page.getByText("Rate confirmation", { exact: true }).filter({ visible: true }).click();
    await expect(visible(page, `${load.loadNumber} · version 1`)).toBeVisible();
    await expect(visible(page, "Signed", true).first()).toBeVisible();
    await expect(visible(page, "$1,800.00").first()).toBeVisible();
    await expect(visible(page, w.shipper.name, true)).toBeVisible();
    await expect(visible(page, w.owner.name, true)).toBeVisible();
    await expect(page.getByRole("button", { name: "Print or save as PDF" }).filter({ visible: true })).toBeVisible();
  });

  test("the shipper approves quick pay and records the payment", async ({ page }) => {
    const w = await world();
    await call("PUT", `/v1/orgs/${w.acme.id}/payer-terms`, { termsDays: 30, quickPay: { days: 2, feePct: 2 } }, w.shipper.token);
    const load = await bookedLoad(w);
    for (const code of ["ARRIVED_PICKUP", "LOADED", "ARRIVED_DELIVERY", "DELIVERED"]) await call("POST", `/v1/loads/${load.id}/status`, { code }, w.driver.token);
    const { invoice } = await call("POST", `/v1/loads/${load.id}/invoices`, {}, w.owner.token);
    await call("POST", `/v1/invoices/${invoice.id}/quick-pay`, {}, w.owner.token);

    await signIn(page, w.shipper);
    await expect(visible(page, `Quick pay requested on ${invoice.invoiceNumber}`)).toBeVisible();
    await page.getByRole("button", { name: "Decide" }).filter({ visible: true }).first().click();
    await expect(visible(page, "Quick pay requested", true)).toBeVisible();
    page.on("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Approve", exact: true }).filter({ visible: true }).first().click();
    await expect(visible(page, "Quick-pay fee 2%")).toBeVisible();
    await expect(page.getByLabel("Amount (USD)").filter({ visible: true })).toHaveValue("1764");
    await page.getByLabel("Reference").filter({ visible: true }).fill("ACH-77");
    await page.getByRole("button", { name: "Record payment" }).filter({ visible: true }).click();
    await expect(visible(page, "Paid", true).first()).toBeVisible();
    await expect(visible(page, /ACH · ACH-77$/)).toBeVisible();

    await page.goto("/money");
    await expect(visible(page, new RegExp(`^${invoice.invoiceNumber} · \\$1,800\\.00$`))).toBeVisible();
  });
  test("the shipper pays an approved invoice by ACH with a bank file", async ({ page }) => {
    const w = await world();
    await call("PUT", `/v1/orgs/${w.fleet.id}/payout-account`, { holderName: "Blue Line LLC", routingNumber: "121000248", accountNumber: "5550001234", accountType: "CHECKING", code: await freshCode(w.owner.secret) }, w.owner.token);
    await call("PUT", `/v1/orgs/${w.acme.id}/ach-originator`, { companyName: "Acme Foods", companyId: "1123456789", bankRoutingNumber: "021000021", bankName: "JPMorgan Chase" }, w.shipper.token);
    const load = await bookedLoad(w);
    for (const code of ["ARRIVED_PICKUP", "LOADED", "ARRIVED_DELIVERY", "DELIVERED"]) await call("POST", `/v1/loads/${load.id}/status`, { code }, w.driver.token);
    const { invoice } = await call("POST", `/v1/loads/${load.id}/invoices`, {}, w.owner.token);
    await call("POST", `/v1/invoices/${invoice.id}/status`, { status: "APPROVED" }, w.shipper.token);

    await signIn(page, w.shipper);
    page.on("dialog", (d) => void d.accept());
    await page.goto("/money");
    await page.getByText("Pay by ACH", { exact: true }).filter({ visible: true }).first().click();
    await expect(visible(page, "Approved and ready to pay", true)).toBeVisible();
    await page.getByRole("switch", { name: `${invoice.invoiceNumber} · $1,800.00` }).filter({ visible: true }).click();
    await page.getByLabel("Authenticator code").filter({ visible: true }).fill(await freshCode(w.shipper.secret));
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Make payment file" }).filter({ visible: true }).click();
    const file = readFileSync(await (await download).path(), "utf8");
    expect(file).toContain("5550001234");
    expect(file).toContain(`RMR*IV*${invoice.invoiceNumber}**1800.00`);

    await page.getByText(/^\$1,800\.00 · effective /).filter({ visible: true }).click();
    await page.getByRole("button", { name: "Mark sent to the bank" }).filter({ visible: true }).click();
    await expect(visible(page, "Sent", true).first()).toBeVisible();
    expect((await call("GET", `/v1/invoices/${invoice.id}`, undefined, w.shipper.token)).status).toBe("PAID");
  });
});
