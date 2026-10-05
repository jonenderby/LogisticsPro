import type { Account, AlertPreferences, AppointmentMiss, ArrivalStatus, Bid, DutyEvent, HosCycle, TrackPoint, Invoice, JoinCode, JoinRequest, Load, LoadException, Membership, Message, Organization, ShipmentOutcome } from "@logisticspro/domain";
import type { PartnerProfile, Transmission } from "@logisticspro/integration";
import type { Violation } from "@logisticspro/navigation";
import { AppendLog, type ChangeSink, type Persisted, PersistentList, PersistentMap } from "./persistence/collections.js";

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
  /** Detention starting at a stop (shippers and dispatch). */
  detention?: boolean;
  /** From the phone or browser, for times in notification text. */
  timeZone?: string;
}

export interface InboxItem {
  id: string;
  kind: "ARRIVAL" | "SUMMARY" | "TEST" | "TENDER" | "MESSAGE" | "STOP" | "DETENTION";
  /** What a tap opens. */
  target?: "LOAD" | "THREAD";
  title: string;
  body: string;
  loadId?: string;
  status?: string;
  at: string;
  read: boolean;
}

export interface RouteEstimate {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  miles: number;
  minutes: number;
  at: string;
  source: string;
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
  accounts = new PersistentMap<Account>("accounts");
  orgs = new PersistentMap<Organization>("orgs");
  memberships = PersistentList.create<Membership>("memberships", (m) => `${m.accountId}:${m.orgId}`);
  loads = new PersistentMap<Load>("loads");
  bids = new PersistentMap<Bid>("bids");
  invoices = new PersistentMap<Invoice>("invoices");
  messages = PersistentList.create<Message>("messages", (m) => m.id);
  /** key: `${ownerOrgId}:${partnerKey}`; the org's own receiving preferences use partnerKey "receiving". */
  profiles = new PersistentMap<StoredProfile>("profiles");
  transmissions = PersistentList.create<Transmission>("transmissions", (t) => t.id);
  refreshTokens = new PersistentMap<RefreshToken>("refreshTokens");
  violations = PersistentList.create<NavigationViolationRecord>("violations", (v) => v.id);
  /** last-read message timestamp per account+thread */
  reads = new PersistentMap<string>("reads");
  /** Current join code per carrier org. */
  joinCodes = new PersistentMap<JoinCode>("joinCodes");
  joinRequests = new PersistentMap<JoinRequest>("joinRequests");
  /** Over/short/damage reports per load. */
  exceptions = new PersistentMap<LoadException[]>("exceptions");
  /** Delivered-shipment outcomes used for reliability. Keyed by load id, plus "<loadId>#<carrierKey>" for carriers that missed an appointment and did not deliver. */
  outcomes = new PersistentMap<ShipmentOutcome>("outcomes");
  /** Missed appointments reported by businesses, by load id. */
  appointmentMisses = new PersistentMap<AppointmentMiss[]>("appointmentMisses");
  /** Latest reported position per driver account. */
  positions = new PersistentMap<DriverPosition>("positions");
  /** Duty status log per driver (hours of service). */
  dutyLogs = new PersistentMap<DutyEvent[]>("dutyLogs");
  /** Location trail per driver, kept for 9 days, for miles driven. */
  tracks = new AppendLog<TrackPoint>("tracks");
  /** Hours-of-service cycle per driver. */
  hosSettings = new PersistentMap<{ cycle: HosCycle }>("hosSettings");
  /** Since when a driver's truck has been stopped while driving (automatic duty status). */
  stoppedSince = new PersistentMap<string>("stoppedSince");
  /** Routed distance and driving time for what is left of a moving load, from the routing server. */
  routeEstimates = new PersistentMap<RouteEstimate>("routeEstimates");
  /** Arrival alert settings per account. */
  alertPrefs = new PersistentMap<AlertPreferences>("alertPrefs");
  /** Last authenticator step accepted per account; older or equal codes are refused. */
  totpLastStep = new PersistentMap<number>("totpLastStep");
  /** Tender and message notification switches per account. */
  notificationSettings = new PersistentMap<NotificationSettings>("notificationSettings");
  /** Pushes accepted by Expo whose delivery receipts are still to be checked. */
  pushTickets = PersistentList.create<{ id: string; token: string; at: string }>("pushTickets", (t) => t.id);
  /** Partner that sent each inbound tender, by load id (to route its responses back). */
  origins = new PersistentMap<{ carrierOrgId: string; partnerKey: string }>("origins");
  /** Failed sign-ins per email, for lockout. */
  loginFailures = new PersistentMap<{ count: number; until: number }>("loginFailures");
  /** Join code attempts per account in the last hour. */
  joinAttempts = new PersistentMap<number[]>("joinAttempts");
  /** Phone push tokens per account. */
  pushTokens = new PersistentMap<PushToken[]>("pushTokens");
  /** In-app alert inbox per account, newest first. */
  notifications = new PersistentMap<InboxItem[]>("notifications");
  /** Last arrival status the alert engine saw per load. */
  arrivalSeen = new PersistentMap<ArrivalStatus>("arrivalSeen");
  /** Last instant alert per "<accountId>:<loadId>", to suppress flip-flops. */
  alertSent = new PersistentMap<{ status: string; at: string }>("alertSent");
  /** Scheduled summary slots already sent, "<accountId>:<slot>" to when it was sent. */
  digestsSent = new PersistentMap<string>("digestsSent");
  private loadCounter = 100_000;
  private loadNumberSource?: () => number;

  nextLoadNumber(): string {
    return `LP-${this.loadNumberSource ? this.loadNumberSource() : ++this.loadCounter}`;
  }

  /** Several API servers draw load numbers from blocks reserved in the database. */
  useLoadNumbers(source: () => number): void {
    this.loadNumberSource = source;
  }

  /** Every persisted collection, by name. */
  collections(): Map<string, Persisted> {
    const out = new Map<string, Persisted>();
    for (const value of Object.values(this)) if (value instanceof PersistentMap || value instanceof PersistentList || value instanceof AppendLog) out.set(value.collection, value);
    return out;
  }

  /** Report every change to `sink` (the database layer). */
  attach(sink: ChangeSink): void {
    for (const c of this.collections().values()) c.sink = sink;
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
