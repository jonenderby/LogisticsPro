import { expect, test } from "@playwright/test";
import { bookedLoad, call, drove, newLoad, signIn, user, visible, world } from "./helpers";

test.describe("carrier", () => {
  test("approves a trucker who asked to join with the join code", async ({ page }) => {
    const w = await world();
    const { code } = await call("GET", `/v1/orgs/${w.fleet.id}/join-code`, undefined, w.owner.token);
    const terry = await user("Terry Trucker", "TRUCKER");
    await call("POST", "/v1/carriers/join", { code }, terry.token);
    await signIn(page, w.owner);
    await expect(visible(page, `Terry Trucker wants to drive for ${w.fleet.name}`)).toBeVisible();
    await page.getByRole("button", { name: "Review request" }).first().click();
    await page.getByRole("button", { name: "Approve" }).filter({ visible: true }).click();
    await expect(visible(page, `${terry.email} · Driver`)).toBeVisible();
  });

  test("sees every truck on the fleet map and gets tender notifications", async ({ page }) => {
    const w = await world();
    await bookedLoad(w);
    await call("POST", "/v1/me/location", { lat: 33.5, lng: -90.1, speedMps: 25 }, w.driver.token);
    await signIn(page, w.owner);
    await page.goto("/track");
    await expect(visible(page, w.driver.name).first()).toBeVisible();
    await expect(page.locator("path.leaflet-interactive")).toHaveCount(1);
    await page.goto("/notifications");
    await expect(visible(page, /^New tender LP-\d+$/)).toBeVisible();
  });

  test("sees board loads its driver can reach in time", async ({ page }) => {
    const w = await world();
    const load = await newLoad(w, [1, 4], [6, 12]);
    await call("POST", `/v1/loads/${load.id}/post`, {}, w.shipper.token);
    await call("POST", "/v1/me/location", { lat: 32.35, lng: -90.2, speedMps: 0 }, w.driver.token);
    await signIn(page, w.owner);
    await page.goto("/board");
    await expect(visible(page, `Suggested for ${w.driver.name}`)).toBeVisible();
    await expect(visible(page, "Jackson, MS → Memphis, TN").first()).toBeVisible();
    await expect(visible(page, new RegExp(`${load.loadNumber} · \\d+ mi empty · \\d+ mi loaded`))).toBeVisible();
  });

  test("gets stop times from the trail and files fuel for the IFTA report", async ({ page }) => {
    const w = await world();
    const load = await bookedLoad(w);
    await drove(w.driver, -90, -20);
    await signIn(page, w.owner);
    await page.goto(`/loads/load/${load.id}`);
    await expect(visible(page, /Arrived \w+ [\d:]+ [AP]M · left \w+ [\d:]+ [AP]M · Arrived after the appointment/).first()).toBeVisible();

    await page.goto("/fuel-tax");
    await expect(visible(page, "IFTA", false).first()).toBeVisible();
    await page.getByLabel("State or province").filter({ visible: true }).fill("MS");
    await page.getByLabel("Gallons").filter({ visible: true }).fill("10");
    await page.getByRole("button", { name: `${w.driver.name}'s truck` }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "Add fuel purchase" }).filter({ visible: true }).click();
    await expect(visible(page, "10 gal · MS")).toBeVisible();
    await expect(visible(page, `${w.driver.name}'s truck`, true).first()).toBeVisible();
    await expect(visible(page, /^\d+ mi · 10 gal$/)).toBeVisible();
    await expect(visible(page, "Even", true)).toBeVisible();
    await expect(visible(page, "Mississippi", true)).toBeVisible();
    await expect(visible(page, /^\d+ mi · taxable 10 gal · paid 10 gal$/)).toBeVisible();
  });
});
