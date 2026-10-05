import type { Account, AlertPreferences, AppointmentMiss, ArrivalStatus, Bid, DutyEvent, HosCycle, TrackPoint, Invoice, JoinCode, JoinRequest, Load, LoadException, Membership, Message, Organization, ShipmentOutcome } from "@logisticspro/domain";
import type { PartnerProfile, Transmission } from "@logisticspro/integration";
import type { Violation } from "@logisticspro/navigation";

export interface StoredProfile extends PartnerProfile {
  /** sha256 of the token partners send on inbound requests. */
  inboundTokenHash?: string;
  updatedAt: string;
}

export interface PushToken {
  token: string;
  platform: "ios" | "android";
  createdAt: string;
}

export interface NotificationSettings {
  tenders: boolean;
  messages: boolean;
  /** From the phone or browser, for times in notification text. */
  timeZone?: string;
}

export interface InboxItem {
  id: string;
  kind: "ARRIVAL" | "SUMMARY" | "TEST" | "TENDER" | "MESSAGE";
  /** What a tap opens. */
  target?: "LOAD" | "THREAD";
  title: string;
  body: string;
  loadId?: string;
  status?: string;
  at: string;
  read: boolean;
}

export interface DriverPosition {
  accountId: string;
  geo: { lat: number; lng: number };
  at: string;
  speedMps?: number;
  headingDeg?: number;
  accuracyM?: number;
}

export interface RefreshToken {
  hash: string;
  accountId: string;
  expiresAt: string;
  revoked: boolean;
}

export interface NavigationViolationRecord extends Violation {
  id: string;
  loadId: string;
  accountId: string;
}

/**
 * In-memory persistence. Every collection is a plain Map so a database-backed
 * implementation can replace it behind the same shape.
 */
export class MemoryStore {
  accounts = new Map<string, Account>();
  orgs = new Map<string, Organization>();
  memberships: Membership[] = [];
  loads = new Map<string, Load>();
  bids = new Map<string, Bid>();
  invoices = new Map<string, Invoice>();
  messages: Message[] = [];
  /** key: `${ownerOrgId}:${partnerKey}`; the org's own receiving preferences use partnerKey "receiving". */
  profiles = new Map<string, StoredProfile>();
  transmissions: Transmission[] = [];
  refreshTokens = new Map<string, RefreshToken>();
  violations: NavigationViolationRecord[] = [];
  /** last-read message timestamp per account+thread */
  reads = new Map<string, string>();
  /** Current join code per carrier org. */
  joinCodes = new Map<string, JoinCode>();
  joinRequests = new Map<string, JoinRequest>();
  /** Over/short/damage reports per load. */
  exceptions = new Map<string, LoadException[]>();
  /** Delivered-shipment outcomes used for reliability. Keyed by load id, plus "<loadId>#<carrierKey>" for carriers that missed an appointment and did not deliver. */
  outcomes = new Map<string, ShipmentOutcome>();
  /** Missed appointments reported by businesses, by load id. */
  appointmentMisses = new Map<string, AppointmentMiss[]>();
  /** Latest reported position per driver account. */
  positions = new Map<string, DriverPosition>();
  /** Duty status log per driver (hours of service). */
  dutyLogs = new Map<string, DutyEvent[]>();
  /** Location trail per driver, kept for 9 days, for miles driven. */
  tracks = new Map<string, TrackPoint[]>();
  /** Hours-of-service cycle per driver. */
  hosSettings = new Map<string, { cycle: HosCycle }>();
  /** Since when a driver's truck has been stopped while driving (automatic duty status). */
  stoppedSince = new Map<string, string>();
  /** Arrival alert settings per account. */
  alertPrefs = new Map<string, AlertPreferences>();
  /** Tender and message notification switches per account. */
  notificationSettings = new Map<string, NotificationSettings>();
  /** Pushes accepted by Expo whose delivery receipts are still to be checked. */
  pushTickets: Array<{ id: string; token: string; at: string }> = [];
  /** Phone push tokens per account. */
  pushTokens = new Map<string, PushToken[]>();
  /** In-app alert inbox per account, newest first. */
  notifications = new Map<string, InboxItem[]>();
  /** Last arrival status the alert engine saw per load. */
  arrivalSeen = new Map<string, ArrivalStatus>();
  /** Last instant alert per "<accountId>:<loadId>", to suppress flip-flops. */
  alertSent = new Map<string, { status: string; at: string }>();
  /** Scheduled summary slots already sent, "<accountId>:<slot>" to when it was sent. */
  digestsSent = new Map<string, string>();
  private loadCounter = 100_000;

  nextLoadNumber(): string {
    this.loadCounter += 1;
    return `LP-${this.loadCounter}`;
  }

  accountByEmail(email: string): Account | undefined {
    const e = email.trim().toLowerCase();
    return [...this.accounts.values()].find((a) => a.email === e);
  }

  membershipsOf(accountId: string): Membership[] {
    return this.memberships.filter((m) => m.accountId === accountId);
  }

  orgsOf(accountId: string): Organization[] {
    return this.membershipsOf(accountId)
      .map((m) => this.orgs.get(m.orgId))
      .filter((o): o is Organization => !!o);
  }

  profile(ownerOrgId: string, key: string): StoredProfile | undefined {
    return this.profiles.get(`${ownerOrgId}:${key}`);
  }

  profilesOf(ownerOrgId: string): StoredProfile[] {
    return [...this.profiles.values()].filter((p) => p.ownerOrgId === ownerOrgId);
  }
}

/** Drivers in a carrier's network (members with the DRIVER role). */
export function driverCount(store: MemoryStore, carrierOrgId: string): number {
  return store.memberships.filter((m) => m.orgId === carrierOrgId && m.roles.includes("DRIVER")).length;
}
