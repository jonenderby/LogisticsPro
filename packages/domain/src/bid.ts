import { z } from "zod";
import { DomainError, Money, newId } from "./common.js";
import type { Load } from "./load.js";

export const BidStatus = z.enum(["OPEN", "AWARDED", "REJECTED", "WITHDRAWN"]);

export const Bid = z.object({
  id: z.string(),
  loadId: z.string(),
  carrierOrgId: z.string(),
  bidderAccountId: z.string(),
  amount: Money,
  /** How the carrier intends to run it: solo, team, relay, or through a DC. */
  plan: z.enum(["SOLO", "TEAM", "RELAY", "CONSOLIDATED"]).default("SOLO"),
  transitHours: z.number().positive().optional(),
  notes: z.string().optional(),
  status: BidStatus,
  createdAt: z.string(),
});
export type Bid = z.infer<typeof Bid>;

export function placeBid(load: Load, input: Omit<Bid, "id" | "status" | "createdAt" | "loadId">, now = new Date().toISOString()): Bid {
  if (load.status !== "POSTED" || !load.board) throw new DomainError("NOT_POSTED", "Load is not open for bids", 409);
  if (load.board.closesAt && load.board.closesAt < now) throw new DomainError("BIDDING_CLOSED", "Bidding has closed", 409);
  if (input.carrierOrgId === load.shipperOrgId || input.carrierOrgId === load.brokerOrgId) {
    throw new DomainError("SELF_BID", "You cannot bid on your own load", 403);
  }
  if ((load.service === "TEAM_EXPEDITED" || load.teamRequired) && input.plan === "SOLO") {
    throw new DomainError("TEAM_REQUIRED", "This load requires a team; bid with a TEAM or RELAY plan");
  }
  return { ...input, id: newId("bid"), loadId: load.id, status: "OPEN", createdAt: now };
}

/** Award one bid; the rest are rejected and the load books to the winning carrier. */
export function awardBid(load: Load, bids: Bid[], bidId: string, now = new Date().toISOString()): { load: Load; bids: Bid[] } {
  const winner = bids.find((b) => b.id === bidId && b.loadId === load.id);
  if (!winner) throw new DomainError("BID_NOT_FOUND", "Bid not found", 404);
  if (winner.status !== "OPEN") throw new DomainError("BID_CLOSED", "Bid is no longer open", 409);
  if (load.status !== "POSTED") throw new DomainError("NOT_POSTED", "Load is not open for bids", 409);
  const updatedBids = bids.map((b) =>
    b.loadId !== load.id ? b : b.id === bidId ? { ...b, status: "AWARDED" as const } : b.status === "OPEN" ? { ...b, status: "REJECTED" as const } : b,
  );
  const next: Load = {
    ...load,
    status: "TENDERED",
    carrierOrgId: winner.carrierOrgId,
    rate: winner.amount,
    teamRequired: load.teamRequired || winner.plan === "TEAM",
    board: undefined,
    version: load.version + 1,
    updatedAt: now,
  };
  return { load: next, bids: updatedBids };
}
