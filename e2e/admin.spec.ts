import { expect, test } from "@playwright/test";
import { ADMIN_EMAIL, signIn, user, visible } from "./helpers";

test("an admin makes test accounts and switches between them to see each kind of app", async ({ page }) => {
  const admin = await user("E2E Admin", "BUSINESS", ADMIN_EMAIL);
  await signIn(page, admin);

  await page.goto("/more");
  await visible(page, "Admin", true).click();
  await expect(page.getByText("No test accounts yet")).toBeVisible();

  // A test carrier with its company, then a test driver who drives for it.
  await page.getByLabel("Name").fill("Test Carrier Casey");
  await page.getByLabel("Company").fill("E2E Test Trucking");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(visible(page, "Carrier · E2E Test Trucking")).toBeVisible();

  await page.getByLabel("Name").fill("Test Driver Dana");
  await page.getByLabel("Company").fill("");
  await visible(page, "Trucker", true).first().click();
  await page.getByText("E2E Test Trucking", { exact: true }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(visible(page, "Trucker · E2E Test Trucking")).toBeVisible();

  // Switch into the driver: the driver's app, with a bar to get back.
  await visible(page, "Test Driver Dana", true).click();
  await expect(page.getByText("Viewing as Test Driver Dana · Trucker")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Navigate" }).filter({ visible: true })).toBeVisible();
  // A reload stays in the test account.
  await page.reload();
  await expect(page.getByText("Viewing as Test Driver Dana · Trucker")).toBeVisible();

  // Back to the admin's own account.
  await page.getByRole("button", { name: "Back to my account" }).click();
  await expect(page.getByText("Viewing as")).toBeHidden();
  await page.goto("/more");
  await expect(visible(page, "Admin", true)).toBeVisible();
});
