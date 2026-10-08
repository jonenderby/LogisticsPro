import { expect, test } from "@playwright/test";
import { PASSWORD, freshCode, user } from "./helpers";

/**
 * The website on a shared domain, e.g. https://example.com/logistics behind
 * an existing nginx. CI builds the site with EXPO_PUBLIC_BASE_PATH=/logistics
 * and runs this with E2E_BASE_PATH=/logistics; the normal run skips it.
 */
const BASE_PATH = process.env.E2E_BASE_PATH ?? "";

test("the website works under a path on a shared domain", async ({ page, context }) => {
  test.skip(!BASE_PATH, "Needs a website built for a base path (E2E_BASE_PATH)");
  const u = await user("Path Shipper", "BUSINESS");

  await page.goto(`${BASE_PATH}/`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Email").fill(u.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Password").press("Enter");
  await page.getByLabel("Code").fill(await freshCode(u.secret));
  await page.getByLabel("Code").press("Enter");
  await expect(page.getByText("Needs your attention")).toBeVisible();

  // The session cookie belongs to this app's path, not the whole domain.
  const cookie = (await context.cookies()).find((c) => c.name === "lp_rt");
  expect(cookie?.path).toBe(`${BASE_PATH}/v1/auth`);

  // Screens keep the path in their address, and deep links and reloads work.
  await page.goto(`${BASE_PATH}/loads`);
  await expect(page).toHaveURL(new RegExp(`${BASE_PATH}/loads$`));
  await expect(page.getByText("Needs your attention")).toBeHidden();
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`${BASE_PATH}/loads$`));
  await page.goto(`${BASE_PATH}/`);
  await expect(page.getByText("Needs your attention")).toBeVisible();
  await page.getByRole("tab", { name: "Loads" }).filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE_PATH}/loads$`));

  // Server pages link within the path too.
  await page.goto(`${BASE_PATH}/privacy`);
  await expect(page.getByRole("heading", { name: "Privacy policy" })).toBeVisible();
});
