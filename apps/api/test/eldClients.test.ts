import { describe, expect, it } from "vitest";
import { EldError, GeotabClient, MotiveClient, SamsaraClient, timeSpanMinutes } from "../src/services/eldClients.js";

const NOW = () => new Date("2026-10-06T15:00:00Z");
type Route = (url: URL, init: RequestInit) => unknown;
function fakeFetch(routes: Record<string, Route>, seen: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
  return (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    seen.push({ url: String(input), init });
    const key = Object.keys(routes).find((k) => `${url.host}${url.pathname}`.endsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    const body = routes[key]!(url, init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("ELD adapters", () => {
  it("reads Motive drivers, clocks (seconds) and truck locations", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const m = new MotiveClient(
      "mk_live_1234",
      fakeFetch(
        {
          "/v1/users": (u) => (u.searchParams.get("page_no") === "1" ? { users: [{ user: { id: 11, first_name: "Ana", last_name: "Alvarez", email: "ana@fleet.example", drivers_license_number: "TN123" } }], pagination: { per_page: 100, page_no: 1, total: 1 } } : { users: [] }),
          "/v1/available_time": () => ({ users: [{ user: { id: 11, duty_status: "driving", available_time: { drive: 18000, shift: 25200, cycle: 144000, break: 7200 } } }], pagination: { total: 1, per_page: 100 } }),
          "/v1/vehicle_locations": () => ({ vehicles: [{ vehicle: { id: 501, number: "112", current_location: { lat: 35.1, lon: -90.0, located_at: "2026-10-06T14:58:00Z", speed: 60, bearing: 270 }, current_driver: { id: 11 } } }, { vehicle: { id: 502, number: "113", current_location: null } }], pagination: { total: 2, per_page: 100 } }),
        },
        seen,
      ),
      undefined,
      NOW,
    );
    expect(await m.drivers()).toEqual([{ externalId: "11", name: "Ana Alvarez", email: "ana@fleet.example", phone: undefined, licenseNumber: "TN123" }]);
    expect(await m.clocks()).toEqual([{ externalDriverId: "11", status: "DRIVING", driveLeftMin: 300, shiftLeftMin: 420, cycleLeftMin: 2400, breakLeftMin: 120, asOf: "2026-10-06T15:00:00.000Z" }]);
    const [loc] = await m.locations();
    expect(loc).toMatchObject({ externalVehicleId: "501", name: "112", lat: 35.1, lng: -90, headingDeg: 270, at: "2026-10-06T14:58:00Z", externalDriverId: "11" });
    expect(loc!.speedMps).toBeCloseTo(26.82, 1);
    expect((seen[0]!.init.headers as Record<string, string>)["X-Api-Key"]).toBe("mk_live_1234");
  });

  it("reads Samsara across pages, with clocks in milliseconds and driver assignments", async () => {
    const s = new SamsaraClient(
      "samsara_api_token",
      fakeFetch({
        "/fleet/drivers": (u) => (u.searchParams.get("after") ? { data: [{ id: "d2", name: "Ben Brown", username: "ben" }], pagination: { hasNextPage: false } } : { data: [{ id: "d1", name: "Ana Alvarez", username: "ana@fleet.example", licenseNumber: "TN123" }], pagination: { endCursor: "c1", hasNextPage: true } }),
        "/fleet/hos/clocks": () => ({ data: [{ driver: { id: "d1" }, currentDutyStatus: { hosStatusType: "onDuty" }, clocks: { break: { timeUntilBreakDurationMs: 3_600_000 }, drive: { driveRemainingDurationMs: 36_000_000 }, shift: { shiftRemainingDurationMs: 43_200_000 }, cycle: { cycleRemainingDurationMs: 180_000_000 } } }], pagination: { hasNextPage: false } }),
        "/fleet/vehicles/locations": () => ({ data: [{ id: "v1", name: "Truck 7", location: { latitude: 36.1, longitude: -86.7, heading: 90, speed: 0, time: "2026-10-06T14:59:00Z" } }], pagination: { hasNextPage: false } }),
        "/fleet/driver-vehicle-assignments": () => ({ data: [{ driver: { id: "d1" }, vehicle: { id: "v1" }, startTime: "2026-10-06T10:00:00Z" }], pagination: { hasNextPage: false } }),
      }),
      undefined,
      NOW,
    );
    expect((await s.drivers()).map((d) => [d.externalId, d.name, d.email])).toEqual([["d1", "Ana Alvarez", "ana@fleet.example"], ["d2", "Ben Brown", undefined]]);
    expect(await s.clocks()).toEqual([{ externalDriverId: "d1", status: "ON_DUTY", driveLeftMin: 600, shiftLeftMin: 720, cycleLeftMin: 3000, breakLeftMin: 60, asOf: "2026-10-06T15:00:00.000Z" }]);
    expect(await s.locations()).toEqual([{ externalVehicleId: "v1", name: "Truck 7", lat: 36.1, lng: -86.7, speedMps: 0, headingDeg: 90, at: "2026-10-06T14:59:00Z", externalDriverId: "d1" }]);
  });

  it("signs in to Geotab and reads users, availability and device status", async () => {
    const calls: string[] = [];
    const g = new GeotabClient(
      { server: "my.geotab.com", database: "bigfleet", userName: "svc@bigfleet.example", password: "pw" },
      fakeFetch({
        "/apiv1": (_u, init) => {
          const body = JSON.parse(String(init.body)) as { method: string; params: { typeName?: string; credentials?: unknown } };
          calls.push(body.params.typeName ?? body.method);
          if (body.method === "Authenticate") return { result: { credentials: { sessionId: "s1" }, path: "my3.geotab.com" } };
          if (!body.params.credentials) return { error: { message: "no session" } };
          switch (body.params.typeName) {
            case "User":
              return { result: [{ id: "b1", name: "ana@fleet.example", firstName: "Ana", lastName: "Alvarez" }] };
            case "DutyStatusAvailability":
              return { result: [{ driving: "05:30:00", duty: "08:00:00", cycle: "2.03:00:00", rest: "01:15:00" }] };
            case "DeviceStatusInfo":
              return { result: [{ device: { id: "g1" }, driver: { id: "b1" }, latitude: 34.0, longitude: -92.0, speed: 100, bearing: 45, dateTime: "2026-10-06T14:57:00Z" }, { device: { id: "g2" }, driver: "UnknownDriverId", latitude: 34.1, longitude: -92.1, speed: 0, dateTime: "2026-10-06T14:57:00Z" }] };
            case "Device":
              return { result: [{ id: "g1", name: "Unit 44" }, { id: "g2", name: "Unit 45" }] };
          }
          return { result: [] };
        },
      }),
      NOW,
    );
    expect(await g.drivers()).toEqual([{ externalId: "b1", name: "Ana Alvarez", email: "ana@fleet.example", licenseNumber: undefined }]);
    expect(await g.clocks()).toEqual([{ externalDriverId: "b1", driveLeftMin: 330, shiftLeftMin: 480, cycleLeftMin: 3060, breakLeftMin: 75, asOf: "2026-10-06T15:00:00.000Z" }]);
    const locs = await g.locations();
    expect(locs[0]).toMatchObject({ externalVehicleId: "g1", name: "Unit 44", externalDriverId: "b1" });
    expect(locs[0]!.speedMps).toBeCloseTo(27.78, 1);
    expect(locs[1]!.externalDriverId).toBeUndefined();
    expect(calls.filter((c) => c === "Authenticate")).toHaveLength(1);
  });

  it("reports rejected credentials plainly", async () => {
    const m = new MotiveClient("bad", fakeFetch({ "/v1/users": () => new Response("{}", { status: 401 }) }));
    await expect(m.drivers()).rejects.toThrow(EldError);
    await expect(m.drivers()).rejects.toThrow("The ELD account rejected the credentials");
    expect(timeSpanMinutes("11:00:00")).toBe(660);
    expect(timeSpanMinutes("1.02:30:00")).toBe(1590);
    expect(timeSpanMinutes("-00:15:00")).toBe(-15);
  });
});
