import type { EldClock, EldDriver, EldVehicleLocation } from "@logisticspro/domain";
import { describe, expect, it } from "vitest";
import { type EldCredentials, eldClient } from "../src/services/eldClients.js";

/**
 * Contract tests against real ELD accounts. They run only when credentials
 * are set, and only read: drivers, hours clocks and truck locations.
 *
 *   LP_TEST_MOTIVE_KEY=...    LP_TEST_SAMSARA_TOKEN=...
 *   LP_TEST_GEOTAB_SERVER=my.geotab.com LP_TEST_GEOTAB_DATABASE=... LP_TEST_GEOTAB_USER=... LP_TEST_GEOTAB_PASSWORD=...
 *   npm run test:eld-live
 *
 * They check that each API still answers in the shape the adapters read, so a
 * provider changing its API shows up here before it shows up as missing hours.
 */
const env = process.env;
const accounts: Array<[string, "MOTIVE" | "SAMSARA" | "GEOTAB", EldCredentials | undefined]> = [
  ["Motive", "MOTIVE", env.LP_TEST_MOTIVE_KEY ? { apiKey: env.LP_TEST_MOTIVE_KEY } : undefined],
  ["Samsara", "SAMSARA", env.LP_TEST_SAMSARA_TOKEN ? { apiKey: env.LP_TEST_SAMSARA_TOKEN } : undefined],
  [
    "Geotab",
    "GEOTAB",
    env.LP_TEST_GEOTAB_DATABASE && env.LP_TEST_GEOTAB_USER && env.LP_TEST_GEOTAB_PASSWORD
      ? { server: env.LP_TEST_GEOTAB_SERVER ?? "my.geotab.com", database: env.LP_TEST_GEOTAB_DATABASE, userName: env.LP_TEST_GEOTAB_USER, password: env.LP_TEST_GEOTAB_PASSWORD }
      : undefined,
  ],
];

const DAY = 86_400_000;
const recent = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= Date.now() + 5 * 60_000 && t > Date.now() - 365 * DAY;
};
const minutes = (n: number | undefined, max: number) => n === undefined || (Number.isFinite(n) && n >= 0 && n <= max);

for (const [name, provider, creds] of accounts) {
  describe.skipIf(!creds)(`${name} live account`, () => {
    const client = creds ? eldClient(provider, creds) : undefined;
    let drivers: EldDriver[] = [];

    it("lists drivers", { timeout: 60_000 }, async () => {
      drivers = await client!.drivers();
      expect(Array.isArray(drivers)).toBe(true);
      for (const d of drivers) {
        expect(typeof d.externalId).toBe("string");
        expect(d.externalId.length).toBeGreaterThan(0);
        expect(typeof d.name).toBe("string");
      }
    });

    it("reads hours clocks in minutes, for known drivers", { timeout: 60_000 }, async () => {
      const clocks: EldClock[] = await client!.clocks();
      const ids = new Set(drivers.map((d) => d.externalId));
      for (const c of clocks) {
        // 11 hours of driving, 14-hour shift, 70-hour cycle (with room for provider rounding).
        expect(minutes(c.driveLeftMin, 11 * 60 + 5)).toBe(true);
        expect(minutes(c.shiftLeftMin, 14 * 60 + 5)).toBe(true);
        expect(minutes(c.cycleLeftMin, 70 * 60 + 5)).toBe(true);
        expect(minutes(c.breakLeftMin, 8 * 60 + 5)).toBe(true);
        expect(recent(c.asOf)).toBe(true);
        if (drivers.length) expect(ids.has(c.externalDriverId)).toBe(true);
      }
    });

    it("reads truck locations", { timeout: 60_000 }, async () => {
      const locations: EldVehicleLocation[] = await client!.locations();
      for (const l of locations) {
        expect(Math.abs(l.lat)).toBeLessThanOrEqual(90);
        expect(Math.abs(l.lng)).toBeLessThanOrEqual(180);
        expect(l.lat !== 0 || l.lng !== 0).toBe(true);
        expect(recent(l.at)).toBe(true);
        if (l.speedMps !== undefined) expect(l.speedMps).toBeGreaterThanOrEqual(0);
        expect(typeof l.name).toBe("string");
      }
    });
  });
}
