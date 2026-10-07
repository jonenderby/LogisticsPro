import { expect, test } from "@playwright/test";
import { IntegrationEngine } from "@logisticspro/integration";
import { BASE, call, signIn, visible, world } from "./helpers";

test("a shipper tests a carrier's EDI connection and sees the 997 come back", async ({ page }) => {
  const w = await world();
  await call("PUT", `/v1/orgs/${w.acme.id}/partners/rl-carriers`, {
    name: "R+L Carriers",
    kind: "CARRIER",
    scac: "RLCA",
    channels: { LOAD_TENDER: { method: "EDI_X12", transport: "VAN" } },
    edi: { receiverQualifier: "02", receiverId: "RLCA", usage: "T", ackRequested: true },
  }, w.shipper.token);

  await signIn(page, w.shipper);
  await page.goto(`/integrations/${w.acme.id}/rl-carriers`);
  await expect(visible(page, "Onboarding", true)).toBeVisible();
  await expect(visible(page, "Test: Load tenders (204)", true)).toBeVisible();
  await page.getByRole("button", { name: "Send test messages" }).filter({ visible: true }).click();
  await expect(visible(page, "Test sent; waiting for the partner's 997", true)).toBeVisible();

  // R+L's system acknowledges the test interchange.
  const tx = (await call<Array<{ payload: string; refs: { test?: string } }>>("GET", `/v1/orgs/${w.acme.id}/transmissions`, undefined, w.shipper.token)).find((t) => t.refs.test === "true")!;
  const ack = new IntegrationEngine({ transports: {}, secrets: () => undefined }).parseEdi(tx.payload).ack997!;
  const { inboundToken } = await call("POST", `/v1/orgs/${w.acme.id}/partners/rl-carriers/inbound-token`, {}, w.shipper.token);
  const res = await fetch(`${BASE}/v1/inbound/${w.acme.id}/rl-carriers/edi`, { method: "POST", headers: { "content-type": "application/edi-x12", "x-lp-inbound-token": inboundToken }, body: ack });
  expect(res.status).toBe(200);

  await page.reload();
  await expect(visible(page, "Test acknowledged with a 997", true)).toBeVisible();
  await page.getByRole("button", { name: "Go live" }).filter({ visible: true }).click();
  await expect(visible(page, "Live. Real messages go in production mode.", true)).toBeVisible();
});
