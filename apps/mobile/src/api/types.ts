import type { Bid, DutyEvent, HosClock, Invoice, Load, Message, PublicAccount, Organization, MemberRole } from "@logisticspro/domain";
import type { ActionItem, Workspace } from "@logisticspro/workspace";

export type { Bid, Invoice, Load, Message, ActionItem, Workspace };

export interface MeResponse {
  account: PublicAccount;
  orgs: Array<Organization & { roles: MemberRole[] }>;
  capabilities: string[];
  ownerOperator: boolean;
  /** Runs this deployment (LP_ADMIN_EMAILS) and can see its setup status. */
  platformAdmin?: boolean;
  /** A platform admin is using the app as this test account. */
  actingAs?: { adminName: string };
  workspace: Workspace;
  feed: ActionItem[];
  /** Drivers only: hours of service right now. */
  hos?: HosView;
}

export interface HosView extends HosClock {
  milesThisShift: number;
  milesLeft: number;
  avgMph: number;
  avgMphSource: "SHIFT" | "DEFAULT";
  log?: DutyEvent[];
  /** On a team truck the drivers set Driving themselves, so either can be the passenger. */
  teamTruck?: boolean;
  /** ELD: the clock comes from the carrier's ELD, the legal record. */
  source?: "ELD" | "PHONE";
  eld?: { provider: "MOTIVE" | "SAMSARA" | "GEOTAB"; asOf: string };
}

export interface Transmission {
  id: string;
  partnerKey: string;
  transaction: string;
  method: "API_JSON" | "API_XML" | "EDI_X12";
  status: string;
  error?: string;
}

export type LoadDetail = Load & { refinement: { locked: boolean; reason?: string } };

export type ThreadMessage = Message & { senderName: string };
