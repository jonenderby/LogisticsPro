import { expect, test } from "@playwright/test";
import { bookedLoad, call, signIn, visible, world } from "./helpers";

test.describe("shipper", () => {
  test("tracks every undelivered shipment with ETA and arrival status @phone", async ({ page }) => {
    const w = await world();
    const onTime = await bookedLoad(w, [-6, -4], [2, 6]);
    await call("POST", `/v1/loads/${onTime.id}/status`, { code: "LOADED" }, w.driver.token);
    await call("POST", "/v1/me/location", { lat: 35.15 - 100 / 69.05, lng: -90.05, speedMps: 25 }, w.driver.token);
    // Never picked up, and the delivery window is nearly over: late.
    const late = await bookedLoad(w, [-26, -24], [-2, 1]);

    await signIn(page, w.shipper);
    await expect(visible(page, `${late.loadNumber} will be late`)).toBeVisible();
    await page.goto("/track");
    await expect(visible(page, "Undelivered shipments")).toBeVisible();
    const body = page.locator("body");
    await expect(body).toContainText(onTime.loadNumber);
    const text = await body.innerText();
    expect(text.indexOf(late.loadNumber)).toBeLessThan(text.indexOf(onTime.loadNumber));
    await expect(visible(page, "Late", true).first()).toBeVisible();
    await expect(visible(page, "On time", true).first()).toBeVisible();
    // No sideways scrolling at phone width.
    expect(await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")).toBeLessThanOrEqual(0);
  });

  test("turns on arrival alerts and sees the carrier's reliability on a load", async ({ page }) => {
    const w = await world();
    const load = await bookedLoad(w);
    await signIn(page, w.shipper);
    await page.goto("/alerts");
    await expect(visible(page, "Alerts are off")).toBeVisible();
    await page.getByRole("button", { name: "Turn on alerts" }).filter({ visible: true }).click();
    await expect(visible(page, "Save changes")).toBeVisible();
    expect((await call("GET", "/v1/me/alert-preferences", undefined, w.shipper.token)).enabled).toBe(true);

    await page.goto(`/loads/load/${load.id}`);
    await expect(visible(page, "Carrier reliability")).toBeVisible();
    await expect(visible(page, w.fleet.name, true)).toBeVisible();
  });
});
