import type { GeoPoint } from "@logisticspro/domain";

export interface Maneuver {
  /** Index into Route.geometry where the maneuver happens. */
  shapeIndex: number;
  instruction: string;
  type: "depart" | "turn-left" | "turn-right" | "keep-left" | "keep-right" | "merge" | "exit" | "continue" | "arrive" | "u-turn" | "other";
  streetName?: string;
}

export interface Route {
  geometry: GeoPoint[];
  distanceM: number;
  durationS: number;
  maneuvers: Maneuver[];
  /** Which provider built it and with what truck profile. */
  source: string;
}

export interface TruckProfile {
  heightIn: number;
  widthIn: number;
  lengthIn: number;
  grossWeightLb: number;
  axles?: number;
  hazmat?: boolean;
}

/** Standard legal envelope for a US tractor-trailer (no permit needed). */
export const LEGAL_TRUCK: TruckProfile = { heightIn: 162, widthIn: 102, lengthIn: 840, grossWeightLb: 80_000, axles: 5 };

export function isOversize(t: TruckProfile): boolean {
  return t.heightIn > 162 || t.widthIn > 102 || t.lengthIn > 900 || t.grossWeightLb > 80_000;
}

export interface RoutingProvider {
  /** `language`: a locale such as "es-US" for the turn instructions. */
  route(waypoints: GeoPoint[], truck: TruckProfile, opts?: { departAt?: string; avoid?: GeoPoint[]; language?: string }): Promise<Route>;
}
