import { expect, test } from "@playwright/test";
import { bookedLoad, call, signIn, visible, world } from "./helpers";

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
});
