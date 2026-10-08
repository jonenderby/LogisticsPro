import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 8099);
/** For e2e/basepath.spec.ts: the path the site was built for, and that build's folder. */
const BASE_PATH = process.env.E2E_BASE_PATH ?? "";
const WEB_DIR = process.env.E2E_WEB_DIR ?? `${process.cwd()}/dist/web`;

/**
 * Browser tests against the real API serving the website build. Build the
 * site first (`npm run build:web`), then `npm run test:e2e`. Each test seeds
 * its own companies and users through the API.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    // Use a preinstalled Chromium when one is given (cloud sandboxes); CI installs its own.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } }, grep: /@phone/ },
  ],
  webServer: {
    command: "npm run start:api",
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { PORT: String(PORT), LP_WEB_DIR: WEB_DIR, LP_PUBLIC_URL: `http://localhost:${PORT}${BASE_PATH}`, LP_PUSH: "off", LP_ALERT_INTERVAL_SECONDS: "5" },
  },
});
