import { z } from "zod";
import { StatusCode } from "./load.js";

export const Message = z.object({
  id: z.string(),
  /** One thread per load; general threads use `org:<id>`. */
  threadId: z.string(),
  loadId: z.string().optional(),
  senderAccountId: z.string(),
  senderOrgId: z.string().optional(),
  kind: z.enum(["TEXT", "STATUS", "SYSTEM"]),
  body: z.string().min(1).max(4000),
  statusCode: StatusCode.optional(),
  /** Orgs whose members can read this message (the load's parties). */
  visibleToOrgIds: z.array(z.string()),
  createdAt: z.string(),
});
export type Message = z.infer<typeof Message>;

const STATUS_TEXT: Record<StatusCode, string> = {
  DISPATCHED: "Dispatched",
  EN_ROUTE_TO_PICKUP: "En route to pickup",
  ARRIVED_PICKUP: "Arrived at pickup",
  LOADED: "Loaded and departed pickup",
  IN_TRANSIT: "In transit",
  ARRIVED_RELAY: "Arrived at relay point",
  RELAY_HANDOFF: "Relay handoff complete",
  ARRIVED_TERMINAL: "Arrived at terminal",
  DEPARTED_TERMINAL: "Departed terminal",
  DELAYED: "Delayed",
  ETA_UPDATE: "ETA updated",
  ARRIVED_DELIVERY: "Arrived at delivery",
  DELIVERED: "Delivered",
};

export function statusText(code: StatusCode): string {
  return STATUS_TEXT[code];
}
