import { expect, test } from "@playwright/test";
import { bookedLoad, call, drove, signIn, visible, world } from "./helpers";

test.describe("driver", () => {
  test("sees legal driving time, miles this shift, and the duty log @phone", async ({ page }) => {
    const w = await world();
    const load = await bookedLoad(w);
    await call("POST", `/v1/loads/${load.id}/status`, { code: "LOADED" }, w.driver.token);
    await drove(w.driver, -136, -16);
    await signIn(page, w.driver);

    const card = page.locator("body");
    await expect(visible(page, /left to drive until your 30-minute break/)).toBeVisible();
    await expect(card).toContainText(/\d+ mi\s*driven this shift/);
    await expect(card).toContainText(/about \d+ mi\s*more you can drive at \d+ mph, your pace/);

    await page.getByText("Hours, limits and duty log").click();
    await expect(visible(page, "Duty log, last 8 days")).toBeVisible();
    for (const meter of ["Driving (11 h)", "Shift window (14 h)", "Until a 30-minute break (8 h)", "Cycle (70 h in 8 days)"]) await expect(visible(page, meter)).toBeVisible();
    await expect(visible(page, "Auto", true)).toHaveCount(2);

    await page.getByRole("tab", { name: "Off duty" }).filter({ visible: true }).click();
    await expect.poll(async () => (await call("GET", "/v1/me/hos", undefined, w.driver.token)).status).toBe("OFF_DUTY");
  });

  test("opens a message from its notification", async ({ page }) => {
    const w = await world();
    const load = await bookedLoad(w);
    await call("POST", `/v1/loads/${load.id}/messages`, { body: "Receiving closes at 5. Use door 4." }, w.shipper.token);
    await signIn(page, w.driver);
    await page.goto("/notifications");
    await expect(visible(page, "Notify me about")).toBeVisible();
    await expect(visible(page, "Tenders", true)).toHaveCount(0);
    await visible(page, `Sam Shipper · ${load.loadNumber}`).click();
    await expect(visible(page, "Receiving closes at 5. Use door 4.")).toBeVisible();
  });
});
