import type { GeoPoint } from "@logisticspro/domain";
import { NoRouteError } from "./providers.js";
import type { TruckProfile } from "./route.js";

type GetLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const IN_TO_CM = 2.54;
const LB_TO_KG = 0.45359237;

/** Driving time over waypoints for a truck, with live traffic. */
export interface TravelTime {
  distanceM: number;
  /** With today's traffic. */
  durationS: number;
  /** How much traffic adds over a free-flowing road. */
  trafficDelayS: number;
  source: string;
}

export interface TrafficProvider {
  readonly name: string;
  travelTime(waypoints: GeoPoint[], truck: TruckProfile, departAt: string): Promise<TravelTime>;
}

const latlng = (p: GeoPoint) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/**
 * HERE Routing API v8, truck mode, with live and predicted traffic for the
 * departure time. `duration` includes traffic; `baseDuration` doesn't.
 */
export class HereTrafficProvider implements TrafficProvider {
  readonly name = "here";
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: GetLike = fetch as unknown as GetLike,
    private readonly base = "https://router.hereapi.com/v8/routes",
  ) {}

  async travelTime(waypoints: GeoPoint[], truck: TruckProfile, departAt: string): Promise<TravelTime> {
    if (waypoints.length < 2) throw new Error("Need at least two points");
    const q = new URLSearchParams({
      transportMode: "truck",
      origin: latlng(waypoints[0]!),
      destination: latlng(waypoints[waypoints.length - 1]!),
      departureTime: departAt,
      return: "summary",
      "truck[grossWeight]": String(Math.round(truck.grossWeightLb * LB_TO_KG)),
      "truck[height]": String(Math.round(truck.heightIn * IN_TO_CM)),
      "truck[width]": String(Math.round(truck.widthIn * IN_TO_CM)),
      "truck[length]": String(Math.round(truck.lengthIn * IN_TO_CM)),
      ...(truck.axles ? { "truck[axleCount]": String(truck.axles) } : {}),
      apikey: this.apiKey,
    });
    for (const v of waypoints.slice(1, -1)) q.append("via", latlng(v));
    const res = await this.fetchFn(`${this.base}?${q}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HERE routing failed (${res.status})`);
    const body = (await res.json()) as { routes?: Array<{ sections: Array<{ summary: { duration: number; baseDuration?: number; length: number } }> }> };
    const sections = body.routes?.[0]?.sections;
    if (!sections?.length) throw new NoRouteError("HERE found no truck route");
    const sum = sections.reduce((a, s) => ({ d: a.d + s.summary.duration, b: a.b + (s.summary.baseDuration ?? s.summary.duration), l: a.l + s.summary.length }), { d: 0, b: 0, l: 0 });
    return { distanceM: sum.l, durationS: sum.d, trafficDelayS: Math.max(0, sum.d - sum.b), source: "here" };
  }
}

/**
 * TomTom Routing API, truck travel mode with traffic. `travelTimeInSeconds`
 * includes traffic; `trafficDelayInSeconds` is what traffic adds.
 */
export class TomTomTrafficProvider implements TrafficProvider {
  readonly name = "tomtom";
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: GetLike = fetch as unknown as GetLike,
    private readonly base = "https://api.tomtom.com/routing/1/calculateRoute",
  ) {}

  async travelTime(waypoints: GeoPoint[], truck: TruckProfile, departAt: string): Promise<TravelTime> {
    if (waypoints.length < 2) throw new Error("Need at least two points");
    const q = new URLSearchParams({
      key: this.apiKey,
      travelMode: "truck",
      traffic: "true",
      routeType: "fastest",
      // TomTom wants a departure in the future; "now" means right away.
      departAt: Date.parse(departAt) > Date.now() + 60_000 ? departAt : "now",
      vehicleWeight: String(Math.round(truck.grossWeightLb * LB_TO_KG)),
      vehicleHeight: (truck.heightIn * 0.0254).toFixed(2),
      vehicleWidth: (truck.widthIn * 0.0254).toFixed(2),
      vehicleLength: (truck.lengthIn * 0.0254).toFixed(2),
      vehicleCommercial: "true",
      ...(truck.hazmat ? { vehicleLoadType: "USHazmatClass9" } : {}),
    });
    const res = await this.fetchFn(`${this.base}/${waypoints.map(latlng).join(":")}/json?${q}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`TomTom routing failed (${res.status})`);
    const body = (await res.json()) as { routes?: Array<{ summary: { lengthInMeters: number; travelTimeInSeconds: number; trafficDelayInSeconds?: number } }> };
    const s = body.routes?.[0]?.summary;
    if (!s) throw new NoRouteError("TomTom found no truck route");
    return { distanceM: s.lengthInMeters, durationS: s.travelTimeInSeconds, trafficDelayS: Math.max(0, s.trafficDelayInSeconds ?? 0), source: "tomtom" };
  }
}
