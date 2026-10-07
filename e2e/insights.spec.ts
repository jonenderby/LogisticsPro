import { expect, test } from "@playwright/test";
import { bookedLoad, call, signIn, visible, world } from "./helpers";

test("a shipper sees on-time by carrier, cost per mile and lanes", async ({ page }) => {
  const w = await world();
  for (let i = 0; i < 2; i++) {
    const load = await bookedLoad(w);
    for (const code of ["ARRIVED_PICKUP", "LOADED", "ARRIVED_DELIVERY", "DELIVERED"]) await call("POST", `/v1/loads/${load.id}/status`, { code }, w.driver.token);
  }
  await signIn(page, w.shipper);
  await page.goto("/insights");
  await expect(visible(page, "Loads delivered", true)).toBeVisible();
  await expect(visible(page, "On-time delivery by carrier", true)).toBeVisible();
  await expect(visible(page, w.fleet.name, true).first()).toBeVisible();
  await expect(visible(page, "Jackson, MS → Memphis, TN", true)).toBeVisible();
  await page.getByRole("button", { name: "Show as table" }).filter({ visible: true }).first().click();
  await expect(visible(page, "On-time pickup", true)).toBeVisible();
  await page.getByText("12 months", { exact: true }).filter({ visible: true }).click();
  await expect(visible(page, "Cost per mile by week", true)).toBeVisible();
});
