import type { Bid, DutyEvent, HosClock, Invoice, Load, Message, PublicAccount, Organization, MemberRole } from "@logisticspro/domain";
import type { ActionItem, Workspace } from "@logisticspro/workspace";

export type { Bid, Invoice, Load, Message, ActionItem, Workspace };

export interface MeResponse {
  account: PublicAccount;
  orgs: Array<Organization & { roles: MemberRole[] }>;
  capabilities: string[];
  ownerOperator: boolean;
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
