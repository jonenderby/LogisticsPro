import { z } from "zod";
import { DetentionTerms } from "./detention.js";
import { Factoring, PayerTerms } from "./payments.js";
import { VettingPolicy } from "./vetting.js";
import { Address, GeoPoint } from "./common.js";

/**
 * An organization can be several kinds at once: an owner-operator is both a
 * CARRIER and (through its owner's account) a driver; a 3PL may also run trucks.
 */
export const OrgKind = z.enum(["CARRIER", "BROKER_3PL", "SHIPPER"]);
export type OrgKind = z.infer<typeof OrgKind>;

export const DistributionCenter = z.object({
  id: z.string(),
  name: z.string(),
  address: Address,
  geo: GeoPoint,
  /** 3-digit ZIP prefixes this DC serves for consolidation and final mile. */
  serviceZip3: z.array(z.string().length(3)).default([]),
});
export type DistributionCenter = z.infer<typeof DistributionCenter>;

export const Organization = z.object({
  id: z.string(),
  name: z.string().min(1),
  kinds: z.array(OrgKind).min(1),
  scac: z.string().min(2).max(4).optional(),
  mcNumber: z.string().optional(),
  dotNumber: z.string().optional(),
  address: Address.optional(),
  distributionCenters: z.array(DistributionCenter).default([]),
  /** A carrier's detention terms; the platform default applies when unset. */
  detention: DetentionTerms.optional(),
  /** A shipper's or broker's payment terms and quick-pay offer. */
  payerTerms: PayerTerms.optional(),
  /** A carrier's factoring company; invoices are paid to it. */
  factoring: Factoring.optional(),
  /** A shipper's or broker's carrier vetting rules; the defaults apply when unset. */
  vetting: VettingPolicy.optional(),
  createdAt: z.string(),
});
export type Organization = z.infer<typeof Organization>;

export const MemberRole = z.enum(["OWNER", "ADMIN", "DISPATCHER", "DRIVER", "BILLING", "INTEGRATIONS"]);
export type MemberRole = z.infer<typeof MemberRole>;

export const Membership = z.object({
  accountId: z.string(),
  orgId: z.string(),
  roles: z.array(MemberRole).min(1),
});
export type Membership = z.infer<typeof Membership>;
