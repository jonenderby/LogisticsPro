import { z } from "zod";
import { randomUUID } from "node:crypto";

/** Prefixed, sortable-enough identifiers (e.g. `load_3f2c...`). */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export const GeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

export const Address = z.object({
  name: z.string().min(1),
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(2).max(3),
  postalCode: z.string().min(3),
  country: z.string().length(2).default("US"),
  geo: GeoPoint.optional(),
  /** Location code agreed with the trading partner (N104 in X12). */
  locationCode: z.string().optional(),
});
export type Address = z.infer<typeof Address>;

export const Contact = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().optional(),
});
export type Contact = z.infer<typeof Contact>;

/** A time window in ISO-8601 (local wall-clock times carry an offset). */
export const TimeWindow = z.object({
  start: z.string().min(1),
  end: z.string().min(1),
});
export type TimeWindow = z.infer<typeof TimeWindow>;

export const Money = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().length(3).default("USD"),
});
export type Money = z.infer<typeof Money>;

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
