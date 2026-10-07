import { expect, test } from "@playwright/test";
import { bookedLoad, call, signIn, visible, world } from "./helpers";

// A 2x2 PNG; the app turns it into a JPEG before upload.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");

test.describe("documents", () => {
  test("the driver scans the BOL and gets the receiver's signature", async ({ page }) => {
    const w = await world();
    const load = await bookedLoad(w);
    for (const code of ["ARRIVED_PICKUP", "LOADED", "ARRIVED_DELIVERY"]) await call("POST", `/v1/loads/${load.id}/status`, { code }, w.driver.token);
    await signIn(page, w.driver);
    await page.goto(`/load/${load.id}`);

    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Take or upload a photo" }).filter({ visible: true }).click();
    await (await chooser).setFiles({ name: "bol.png", mimeType: "image/png", buffer: PNG });
    await expect.poll(async () => (await call("GET", `/v1/loads/${load.id}`, undefined, w.driver.token)).documents).toEqual([expect.objectContaining({ kind: "BOL", name: "BOL", contentType: "image/jpeg" })]);
    await expect(visible(page, /^Bill of lading · /)).toBeVisible();

    await page.getByRole("button", { name: "Get delivery signature" }).filter({ visible: true }).click();
    await page.getByLabel("Receiver's name").filter({ visible: true }).fill("Jane Dock");
    await page.getByLabel("Shortage, damage or other exceptions").filter({ visible: true }).fill("1 carton torn");
    const pad = page.getByLabel("Signature box").filter({ visible: true });
    const box = (await pad.boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + 100);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) await page.mouse.move(box.x + 30 + i * 12, box.y + 100 + Math.sin(i / 2) * 30);
    await page.mouse.up();
    page.on("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Save signed receipt" }).filter({ visible: true }).click();
    await expect(visible(page, "Delivery receipt signed by Jane Dock").first()).toBeVisible();
    await expect.poll(async () => (await call("GET", `/v1/loads/${load.id}`, undefined, w.shipper.token)).status).toBe("DELIVERED");
    const pod = (await call("GET", `/v1/loads/${load.id}`, undefined, w.shipper.token)).documents.find((d: { kind: string }) => d.kind === "POD");
    expect(pod).toMatchObject({ signedBy: "Jane Dock", contentType: "image/svg+xml" });
    const svg = await (await fetch(`http://localhost:${process.env.E2E_PORT ?? 8099}${pod.viewUrl}`)).text();
    expect(svg).toContain("Exceptions: 1 carton torn");
  });
});
