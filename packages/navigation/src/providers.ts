import { type GeoPoint, haversineMeters } from "@logisticspro/domain";
import { decodePolyline } from "./geometry.js";
import type { Maneuver, Route, RoutingProvider, TruckProfile } from "./route.js";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const IN_TO_M = 0.0254;
const LB_TO_T = 0.00045359237;

interface ValhallaManeuver {
  instruction: string;
  begin_shape_index: number;
  type: number;
  street_names?: string[];
}
interface ValhallaResponse {
  trip: { legs: Array<{ shape: string; maneuvers: ValhallaManeuver[] }>; summary: { length: number; time: number } };
}

/** No legal route exists for this truck (height, weight, length, hazmat or closures). */
export class NoRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoRouteError";
  }
}

/** Valhalla maneuver type ids -> our maneuver types. */
function maneuverType(t: number): Maneuver["type"] {
  if ([1, 2, 3].includes(t)) return "depart";
  if ([4, 5, 6].includes(t)) return "arrive";
  if ([9, 10, 11].includes(t)) return "turn-right";
  if ([14, 15, 16].includes(t)) return "turn-left";
  if ([12, 13].includes(t)) return "u-turn";
  if ([18, 19, 20, 21].includes(t)) return "exit";
  if (t === 23) return "keep-right";
  if (t === 24) return "keep-left";
  if ([25, 37, 38].includes(t)) return "merge";
  if ([7, 8, 17, 22].includes(t)) return "continue";
  return "other";
}

/**
 * Truck routing through a Valhalla server (open source; self-hosted or a
 * hosted provider). Valhalla's truck costing honors height, width, length,
 * weight, axle load and hazmat restrictions from the map data.
 */
export class ValhallaProvider implements RoutingProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: { fetch?: FetchLike; headers?: Record<string, string> } = {},
  ) {}

  async route(waypoints: GeoPoint[], truck: TruckProfile): Promise<Route> {
    const body = {
      locations: waypoints.map((p) => ({ lat: p.lat, lon: p.lng })),
      costing: "truck",
      costing_options: {
        truck: {
          height: +(truck.heightIn * IN_TO_M).toFixed(2),
          width: +(truck.widthIn * IN_TO_M).toFixed(2),
          length: +(truck.lengthIn * IN_TO_M).toFixed(2),
          weight: +(truck.grossWeightLb * LB_TO_T).toFixed(2),
          axle_count: truck.axles ?? 5,
          hazmat: !!truck.hazmat,
        },
      },
      directions_options: { units: "kilometers" },
    };
    const doFetch = this.opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const res = await doFetch(`${this.baseUrl.replace(/\/$/, "")}/route`, { method: "POST", headers: { "content-type": "application/json", ...this.opts.headers }, body: JSON.stringify(body) });
    if (!res.ok) {
      // Valhalla answers 400 with error_code 442 when no legal route exists for this truck.
      const body = (await res.json().catch(() => ({}))) as { error_code?: number; error?: string };
      if (body.error_code === 442 || body.error_code === 171) throw new NoRouteError(body.error ?? "No route found");
      throw new Error(`routing failed: HTTP ${res.status}${body.error ? ` (${body.error})` : ""}`);
    }
    const data = (await res.json()) as ValhallaResponse;
    const geometry: GeoPoint[] = [];
    const maneuvers: Maneuver[] = [];
    for (const leg of data.trip.legs) {
      const offset = geometry.length === 0 ? 0 : geometry.length - 1;
      const shape = decodePolyline(leg.shape, 6);
      geometry.push(...(geometry.length === 0 ? shape : shape.slice(1)));
      for (const m of leg.maneuvers) {
        maneuvers.push({ shapeIndex: m.begin_shape_index + offset, instruction: m.instruction, type: maneuverType(m.type), streetName: m.street_names?.[0] });
      }
    }
    return { geometry, distanceM: data.trip.summary.length * 1000, durationS: data.trip.summary.time, maneuvers, source: "valhalla:truck" };
  }
}

/** Straight lines between waypoints. For tests, demos and permit routes already drawn by the state. */
export class StaticProvider implements RoutingProvider {
  constructor(private readonly mph = 50) {}
  async route(waypoints: GeoPoint[], _truck?: TruckProfile): Promise<Route> {
    let d = 0;
    for (let i = 1; i < waypoints.length; i++) d += haversineMeters(waypoints[i - 1]!, waypoints[i]!);
    const maneuvers: Maneuver[] = [{ shapeIndex: 0, instruction: "Depart", type: "depart" }];
    for (let i = 1; i < waypoints.length - 1; i++) maneuvers.push({ shapeIndex: i, instruction: "Continue to next waypoint", type: "continue" });
    maneuvers.push({ shapeIndex: waypoints.length - 1, instruction: "Arrive at destination", type: "arrive" });
    return { geometry: waypoints, distanceM: d, durationS: d / (this.mph * 0.44704), maneuvers, source: "static" };
  }
}
