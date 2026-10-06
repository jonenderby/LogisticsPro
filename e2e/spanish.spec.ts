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

test("a new account is in English unless Spanish is picked during setup", async ({ page }) => {
  await page.goto("/");
  // English is the default before and during sign-up.
  await expect(visible(page, "Every load, every partner, one app. Drive, dispatch, ship and invoice, with your ERP connected by API or EDI.", true)).toBeVisible();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(visible(page, "Full name", true)).toBeVisible();

  await page.getByText("Español", { exact: true }).filter({ visible: true }).click();
  await expect(visible(page, "Nombre completo", true)).toBeVisible();
  await page.getByLabel("Nombre completo").fill("Rosa Ruiz");
  await page.getByLabel("Correo electrónico").fill(`rosa.${Date.now()}@example.com`);
  await page.getByLabel("Contraseña").fill(PASSWORD);
  await page.getByRole("button", { name: "Crear cuenta" }).filter({ visible: true }).click();

  await expect(visible(page, "Protege tu cuenta", true)).toBeVisible();
  const key = (await page.getByText(/^[A-Z2-7]{4}( [A-Z2-7]{1,4})+$/).filter({ visible: true }).innerText()).replace(/\s/g, "");
  await page.getByLabel("Código de 6 dígitos").fill(await freshCode(key));
  await page.getByRole("button", { name: "Activar verificación en dos pasos" }).filter({ visible: true }).click();
  await page.getByRole("button", { name: "Ya los guardé" }).filter({ visible: true }).click();
  await expect(visible(page, "Requiere tu atención", true)).toBeVisible();
  await expect(visible(page, "Únete a tu transportista", true)).toBeVisible();
});
