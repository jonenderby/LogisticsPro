import { expect, test } from "@playwright/test";
import { bookedLoad, call, signIn, user, visible, world } from "./helpers";

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
});
