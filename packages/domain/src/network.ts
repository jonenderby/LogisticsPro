import { z } from "zod";

/**
 * Join codes let a trucker ask to join a carrier's network. A code only
 * creates a request; the carrier still approves it, so a leaked code cannot
 * add anyone by itself. Codes expire and can be rotated at any time.
 */
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
export const DEFAULT_JOIN_CODE_TTL_HOURS = 24 * 7;

export function formatJoinCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export function normalizeJoinCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export const JoinRequestStatus = z.enum(["PENDING", "APPROVED", "DECLINED", "CANCELLED"]);

export const JoinRequest = z.object({
  id: z.string(),
  carrierOrgId: z.string(),
  accountId: z.string(),
  status: JoinRequestStatus,
  message: z.string().max(500).optional(),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
  decidedByAccountId: z.string().optional(),
});
export type JoinRequest = z.infer<typeof JoinRequest>;

export interface JoinCode {
  carrierOrgId: string;
  code: string;
  createdAt: string;
  expiresAt: string;
}
