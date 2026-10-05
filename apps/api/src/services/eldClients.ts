import type { DutyStatus, EldClock, EldDriver, EldProvider, EldVehicleLocation } from "@logisticspro/domain";

/** One carrier's ELD account. */
export interface EldClient {
  readonly provider: EldProvider;
  drivers(): Promise<EldDriver[]>;
  clocks(): Promise<EldClock[]>;
  locations(): Promise<EldVehicleLocation[]>;
}

export type EldCredentials = { apiKey: string } | { server: string; database: string; userName: string; password: string };
export type Fetch = typeof fetch;

export class EldError extends Error {}

const MPH_TO_MPS = 0.44704;
const KPH_TO_MPS = 1 / 3.6;
const str = (v: unknown) => (v === null || v === undefined || String(v).trim() === "" ? undefined : String(v).trim());
const num = (v: unknown) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));

async function json(fetcher: Fetch, url: string, init: RequestInit): Promise<unknown> {
  const res = await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403) throw new EldError("The ELD account rejected the credentials");
  if (!res.ok) throw new EldError(`The ELD service answered ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- Motive

const MOTIVE_STATUS: Record<string, DutyStatus> = { off_duty: "OFF_DUTY", sleeper: "SLEEPER", driving: "DRIVING", on_duty: "ON_DUTY", yard_move: "ON_DUTY", personal_conveyance: "OFF_DUTY" };

/** Motive (formerly KeepTruckin), with an API key from Motive's admin settings. */
export class MotiveClient implements EldClient {
  readonly provider = "MOTIVE" as const;
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetch = fetch,
    private readonly base = "https://api.gomotive.com",
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async pages<T>(path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const body = (await json(this.fetcher, `${this.base}${path}${path.includes("?") ? "&" : "?"}per_page=100&page_no=${page}`, { headers: { "X-Api-Key": this.apiKey, accept: "application/json" } })) as Record<string, unknown>;
      const items = (body[key] as T[] | undefined) ?? [];
      out.push(...items);
      const p = body.pagination as { total?: number; per_page?: number } | undefined;
      if (!items.length || !p?.total || page * (p.per_page ?? 100) >= p.total) break;
    }
    return out;
  }

  async drivers(): Promise<EldDriver[]> {
    const users = await this.pages<{ user: Record<string, unknown> }>("/v1/users?role=driver&status=active", "users");
    return users.map(({ user: u }) => ({ externalId: String(u.id), name: [u.first_name, u.last_name].filter(Boolean).join(" "), email: str(u.email), phone: str(u.phone), licenseNumber: str(u.drivers_license_number) }));
  }

  async clocks(): Promise<EldClock[]> {
    const users = await this.pages<{ user: Record<string, unknown> }>("/v1/available_time", "users");
    const at = this.now().toISOString();
    return users.flatMap(({ user: u }) => {
      const t = u.available_time as Record<string, unknown> | undefined;
      if (!t) return [];
      // Motive reports seconds left on each clock.
      const min = (v: unknown) => Math.round((num(v) ?? 0) / 60);
      return [{ externalDriverId: String(u.id), status: MOTIVE_STATUS[String(u.duty_status ?? "")], driveLeftMin: min(t.drive), shiftLeftMin: min(t.shift), cycleLeftMin: min(t.cycle), breakLeftMin: t.break !== undefined ? min(t.break) : undefined, asOf: str(u.last_hos_status_at) ?? at }];
    });
  }

  async locations(): Promise<EldVehicleLocation[]> {
    const vehicles = await this.pages<{ vehicle: Record<string, unknown> }>("/v1/vehicle_locations", "vehicles");
    return vehicles.flatMap(({ vehicle: v }) => {
      const loc = v.current_location as Record<string, unknown> | undefined;
      const lat = num(loc?.lat);
      const lng = num(loc?.lon);
      if (!loc || lat === undefined || lng === undefined) return [];
      const driver = v.current_driver as Record<string, unknown> | undefined;
      return [{ externalVehicleId: String(v.id), name: str(v.number) ?? String(v.id), lat, lng, speedMps: num(loc.speed) !== undefined ? num(loc.speed)! * MPH_TO_MPS : undefined, headingDeg: num(loc.bearing), at: str(loc.located_at) ?? this.now().toISOString(), externalDriverId: driver?.id !== undefined ? String(driver.id) : undefined }];
    });
  }
}

// ---------------------------------------------------------------- Samsara

const SAMSARA_STATUS: Record<string, DutyStatus> = { offDuty: "OFF_DUTY", sleeperBed: "SLEEPER", driving: "DRIVING", onDuty: "ON_DUTY", yardMove: "ON_DUTY", personalConveyance: "OFF_DUTY", waitingTime: "ON_DUTY" };

/** Samsara, with an API token that can read drivers, vehicles and hours of service. */
export class SamsaraClient implements EldClient {
  readonly provider = "SAMSARA" as const;
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetch = fetch,
    private readonly base = "https://api.samsara.com",
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async pages<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let i = 0; i < 50; i++) {
      const sep = path.includes("?") ? "&" : "?";
      const body = (await json(this.fetcher, `${this.base}${path}${after ? `${sep}after=${encodeURIComponent(after)}` : ""}`, { headers: { authorization: `Bearer ${this.token}`, accept: "application/json" } })) as { data?: T[]; pagination?: { endCursor?: string; hasNextPage?: boolean } };
      out.push(...(body.data ?? []));
      if (!body.pagination?.hasNextPage || !body.pagination.endCursor) break;
      after = body.pagination.endCursor;
    }
    return out;
  }

  async drivers(): Promise<EldDriver[]> {
    const rows = await this.pages<Record<string, unknown>>("/fleet/drivers?driverActivationStatus=active");
    return rows.map((d) => ({ externalId: String(d.id), name: str(d.name) ?? String(d.id), email: str(d.email) ?? (String(d.username ?? "").includes("@") ? str(d.username) : undefined), phone: str(d.phone), licenseNumber: str(d.licenseNumber) }));
  }

  async clocks(): Promise<EldClock[]> {
    const rows = await this.pages<Record<string, unknown>>("/fleet/hos/clocks");
    const at = this.now().toISOString();
    const min = (ms: unknown) => Math.round((num(ms) ?? 0) / 60_000);
    return rows.flatMap((r) => {
      const driver = r.driver as { id?: unknown } | undefined;
      const c = r.clocks as Record<string, Record<string, unknown>> | undefined;
      if (!driver?.id || !c) return [];
      const status = (r.currentDutyStatus as { hosStatusType?: string } | undefined)?.hosStatusType;
      return [{ externalDriverId: String(driver.id), status: status ? SAMSARA_STATUS[status] : undefined, driveLeftMin: min(c.drive?.driveRemainingDurationMs), shiftLeftMin: min(c.shift?.shiftRemainingDurationMs), cycleLeftMin: min(c.cycle?.cycleRemainingDurationMs), breakLeftMin: c.break?.timeUntilBreakDurationMs !== undefined ? min(c.break.timeUntilBreakDurationMs) : undefined, asOf: at }];
    });
  }

  async locations(): Promise<EldVehicleLocation[]> {
    const [rows, assignments] = await Promise.all([
      this.pages<Record<string, unknown>>("/fleet/vehicles/locations"),
      this.pages<{ driver?: { id?: unknown }; vehicle?: { id?: unknown }; endTime?: string }>("/fleet/driver-vehicle-assignments?filterBy=vehicles").catch(() => []),
    ]);
    const driverOf = new Map(assignments.filter((a) => a.vehicle?.id && a.driver?.id && !a.endTime).map((a) => [String(a.vehicle!.id), String(a.driver!.id)]));
    return rows.flatMap((v) => {
      const loc = v.location as Record<string, unknown> | undefined;
      const lat = num(loc?.latitude);
      const lng = num(loc?.longitude);
      if (!loc || lat === undefined || lng === undefined) return [];
      return [{ externalVehicleId: String(v.id), name: str(v.name) ?? String(v.id), lat, lng, speedMps: num(loc.speed) !== undefined ? num(loc.speed)! * MPH_TO_MPS : undefined, headingDeg: num(loc.heading), at: str(loc.time) ?? this.now().toISOString(), externalDriverId: driverOf.get(String(v.id)) }];
    });
  }
}

// ---------------------------------------------------------------- Geotab

/** "1.02:30:00" (a .NET TimeSpan) to minutes. */
export function timeSpanMinutes(v: unknown): number {
  const m = /^(-)?(?:(\d+)\.)?(\d+):(\d+)(?::(\d+(?:\.\d+)?))?$/.exec(String(v ?? ""));
  if (!m) return 0;
  const total = Number(m[2] ?? 0) * 1440 + Number(m[3]) * 60 + Number(m[4]) + Number(m[5] ?? 0) / 60;
  return Math.round(m[1] ? -total : total);
}

/** Geotab (MyGeotab), with a service account's database, user name and password. */
export class GeotabClient implements EldClient {
  readonly provider = "GEOTAB" as const;
  private session?: { credentials: unknown; server: string };
  constructor(
    private readonly creds: { server: string; database: string; userName: string; password: string },
    private readonly fetcher: Fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private url(server: string) {
    const host = server.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return `https://${host}/apiv1`;
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.session) {
      const auth = (await json(this.fetcher, this.url(this.creds.server), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "Authenticate", params: { database: this.creds.database, userName: this.creds.userName, password: this.creds.password } }) })) as { result?: { credentials: unknown; path?: string }; error?: { message?: string } };
      if (!auth.result) throw new EldError(auth.error?.message ?? "Geotab sign-in failed");
      this.session = { credentials: auth.result.credentials, server: auth.result.path && auth.result.path !== "ThisServer" ? auth.result.path : this.creds.server };
    }
    const body = (await json(this.fetcher, this.url(this.session.server), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: { ...params, credentials: this.session.credentials } }) })) as { result?: T; error?: { message?: string } };
    if (body.error) throw new EldError(body.error.message ?? "Geotab call failed");
    return body.result as T;
  }

  async drivers(): Promise<EldDriver[]> {
    const users = await this.call<Array<Record<string, unknown>>>("Get", { typeName: "User", search: { isDriver: true } });
    return users.map((u) => ({ externalId: String(u.id), name: [u.firstName, u.lastName].filter(Boolean).join(" ") || String(u.name), email: String(u.name ?? "").includes("@") ? str(u.name) : undefined, licenseNumber: str(u.licenseNumber) }));
  }

  async clocks(): Promise<EldClock[]> {
    const drivers = await this.drivers();
    const at = this.now().toISOString();
    const out: EldClock[] = [];
    for (const d of drivers) {
      const [a] = await this.call<Array<Record<string, unknown>>>("Get", { typeName: "DutyStatusAvailability", search: { userSearch: { id: d.externalId } } }).catch(() => []);
      if (!a) continue;
      out.push({ externalDriverId: d.externalId, driveLeftMin: timeSpanMinutes(a.driving), shiftLeftMin: timeSpanMinutes(a.duty), cycleLeftMin: timeSpanMinutes(a.cycle), breakLeftMin: a.rest !== undefined ? timeSpanMinutes(a.rest) : undefined, asOf: at });
    }
    return out;
  }

  async locations(): Promise<EldVehicleLocation[]> {
    const [statuses, devices] = await Promise.all([this.call<Array<Record<string, unknown>>>("Get", { typeName: "DeviceStatusInfo" }), this.call<Array<Record<string, unknown>>>("Get", { typeName: "Device" })]);
    const names = new Map(devices.map((d) => [String(d.id), str(d.name)]));
    return statuses.flatMap((s) => {
      const lat = num(s.latitude);
      const lng = num(s.longitude);
      const device = String((s.device as { id?: unknown } | undefined)?.id ?? "");
      if (lat === undefined || lng === undefined || !device) return [];
      const driver = (s.driver as { id?: unknown } | string | undefined) ?? undefined;
      const driverId = typeof driver === "object" && driver?.id ? String(driver.id) : undefined;
      return [{ externalVehicleId: device, name: names.get(device) ?? device, lat, lng, speedMps: num(s.speed) !== undefined ? num(s.speed)! * KPH_TO_MPS : undefined, headingDeg: num(s.bearing), at: str(s.dateTime) ?? this.now().toISOString(), externalDriverId: driverId && driverId !== "UnknownDriverId" ? driverId : undefined }];
    });
  }
}

export function eldClient(provider: EldProvider, creds: EldCredentials, fetcher: Fetch = fetch, now: () => Date = () => new Date()): EldClient {
  if (provider === "GEOTAB") {
    if (!("server" in creds)) throw new EldError("Geotab needs a server, database, user name and password");
    return new GeotabClient(creds, fetcher, now);
  }
  if (!("apiKey" in creds)) throw new EldError("This ELD needs an API key");
  return provider === "MOTIVE" ? new MotiveClient(creds.apiKey, fetcher, undefined, now) : new SamsaraClient(creds.apiKey, fetcher, undefined, now);
}
