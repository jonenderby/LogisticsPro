import { expect, test } from "@playwright/test";
import { bookedLoad, call, freshCode, PASSWORD, visible, world } from "./helpers";

test("a driver switches the app to Spanish @phone", async ({ page }) => {
  const w = await world();
  const load = await bookedLoad(w);
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Email").fill(w.driver.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Password").press("Enter");
  await page.getByLabel("Code").fill(await freshCode(w.driver.secret));
  await page.getByLabel("Code").press("Enter");
  await expect(page.getByText("Needs your attention")).toBeVisible();

  await page.goto("/more");
  await page.getByRole("button", { name: "Español" }).filter({ visible: true }).click();
  await expect(visible(page, "Idioma", true)).toBeVisible();
  await page.goto("/");
  await expect(visible(page, "Requiere tu atención", true)).toBeVisible();
  await expect(visible(page, `Siguiente carga ${load.loadNumber}`, true)).toBeVisible();
  await expect(page.getByRole("button", { name: "Llegué a la recogida" }).filter({ visible: true })).toBeVisible();
  await expect(visible(page, "Horas de servicio", true).first()).toBeVisible();
  expect((await call("GET", "/v1/me", undefined, w.driver.token)).account.language).toBe("es");
});
