import type { EldClock, EldDriver, EldProvider } from "@logisticspro/domain";
import type { DriverPayRule, SettlementStatement } from "@logisticspro/domain";
import type { Account, AlertPreferences, AppointmentMiss, ArrivalStatus, Bid, DailyMiles, DutyEvent, FuelPurchase, HosCycle, TrackPoint, Invoice, JoinCode, FmcsaRecord, JoinRequest, Load, LoadException, RateConfirmation, Membership, Message, Organization, ShipmentOutcome } from "@logisticspro/domain";
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
  /** Invoices and payments (people who bill or pay). */
  payments?: boolean;
  /** From the phone or browser, for times in notification text. */
  timeZone?: string;
}

export interface InboxItem {
  id: string;
  kind: "ARRIVAL" | "SUMMARY" | "TEST" | "TENDER" | "MESSAGE" | "STOP" | "DETENTION" | "PAYMENT" | "VETTING";
  /** What a tap opens. */
  target?: "LOAD" | "THREAD" | "INVOICE" | "SETTLEMENT";
  invoiceId?: string;
  settlementId?: string;
  title: string;
  body: string;
  loadId?: string;
  status?: string;
  at: string;
  read: boolean;
}

export interface EldConnection {
  orgId: string;
  provider: EldProvider;
  /** Encrypted credentials (see security/sealed.ts). */
  sealedCredentials: string;
  /** A hint for people, such as the last four of the key or the Geotab database. */
  label: string;
  connectedAt: string;
  connectedByAccountId: string;
  lastSyncAt?: string;
  lastError?: string;
  drivers: Array<EldDriver & { accountId?: string; match?: "AUTO" | "MANUAL" }>;
  vehicles: number;
}

export interface EldDriverLink {
  accountId: string;
  orgId: string;
  provider: EldProvider;
  externalDriverId: string;
  clock?: EldClock;
  syncedAt?: string;
}

export interface StoredFile {
  id: string;
  loadId: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  uploadedByAccountId: string;
  at: string;
}

export interface FmcsaEntry {
  current: FmcsaRecord;
  /** Earlier records, stamped with when they were replaced. */
  history: FmcsaRecord[];
  /** The last verdict seen, so a carrier going bad is reported once. */
  lastVerdict?: string;
}

export interface CarrierApproval {
  payerOrgId: string;
  carrierOrgId: string;
  approvedByAccountId: string;
  at: string;
  note: string;
}

export interface RouteEstimate {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  miles: number;
  minutes: number;
  /** What traffic adds, when the time came from a live-traffic provider. */
  trafficDelayMinutes?: number;
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
  /** The driver's phone, or the truck's ELD. */
  source?: "PHONE" | "ELD";
}

/** A bank account's full numbers, encrypted; the organization keeps only a summary. */
export interface StoredBankAccount {
  orgId: string;
  /** JSON of { routingNumber, accountNumber }, sealed (see security/sealed.ts). */
  sealed: string;
  createdAt: string;
}

/** A payer's batch of ACH payments to carriers: one NACHA file for its bank. */
export interface PaymentRun {
  id: string;
  orgId: string;
  status: "CREATED" | "SENT" | "CANCELLED";
  effectiveDate: string;
  entries: Array<{ invoiceId: string; invoiceNumber: string; carrierOrgId: string; payeeName: string; last4: string; amount: number; traceNumber: string }>;
  total: number;
  fileName: string;
  /** The NACHA file, sealed: it holds account numbers. */
  sealedFile: string;
  createdAt: string;
  createdByAccountId: string;
  sentAt?: string;
  sentByAccountId?: string;
  cancelledAt?: string;
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
  /**
   * Indexed by every party (shipper, broker, carrier orgs and assigned
   * drivers), by status, by load number and by the shipper's own reference.
   */
  loads = new PersistentMap<Load>("loads")
    .index("party", (l) => [l.shipperOrgId, l.brokerOrgId, l.carrierOrgId, ...l.legs.flatMap((g) => g.driverAccountIds)])
    .index("status", (l) => [l.status])
    .index("number", (l) => [l.loadNumber])
    .index("shipperRef", (l) => [l.references.shipperRef && `${l.shipperOrgId}|${l.references.shipperRef}`]);
  bids = new PersistentMap<Bid>("bids").index("load", (b) => [b.loadId]).index("carrier", (b) => [b.carrierOrgId]);
  /** Indexed by the carrier and the payer, by load, and by who created it. */
  invoices = new PersistentMap<Invoice>("invoices")
    .index("party", (i) => [i.carrierOrgId, i.billTo.orgId, i.createdByAccountId])
    .index("load", (i) => [i.loadId]);
  messages = PersistentList.create<Message>("messages", (m) => m.id, (m) => m.loadId);
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
  /** A carrier's ELD account, by carrier org id. */
  eldConnections = new PersistentMap<EldConnection>("eldConnections");
  /** Drivers whose hours come from an ELD: account id to the ELD driver and its latest clock. */
  eldDrivers = new PersistentMap<EldDriverLink>("eldDrivers");
  /** Uploaded files' details (the bytes are in the file store). */
  files = new PersistentMap<StoredFile>("files");
  /** FMCSA facts per USDOT number, with earlier versions whose contact details differ. */
  fmcsa = new PersistentMap<FmcsaEntry>("fmcsa");
  /** A shipper's or broker's sign-off on a carrier that needs review, "<payerOrgId>|<carrierOrgId>". */
  carrierApprovals = new PersistentMap<CarrierApproval>("carrierApprovals");
  /** Bank accounts carriers are paid to, by id (each change is a new one). */
  bankAccounts = new PersistentMap<StoredBankAccount>("bankAccounts");
  /** Payers' ACH payment files, indexed by payer and by invoice. */
  paymentRuns = new PersistentMap<PaymentRun>("paymentRuns").index("org", (r) => [r.orgId]).index("invoice", (r) => r.entries.map((e) => e.invoiceId));
  /** How each driver is paid by each carrier, "<carrierOrgId>|<accountId>". */
  driverPayRules = new PersistentMap<DriverPayRule & { setAt: string; setByAccountId: string }>("driverPayRules");
  /** Driver pay statements, indexed by carrier, by driver, and by "<loadId>|<driverId>" so no load is paid twice. */
  settlements = new PersistentMap<SettlementStatement>("settlements")
    .index("carrier", (s) => [s.carrierOrgId])
    .index("driver", (s) => [s.driverAccountId])
    .index("paid", (s) => s.lines.map((l) => `${l.loadId}|${s.driverAccountId}`));
  /** Rate confirmation versions per load, oldest first. */
  rateConfirmations = new PersistentMap<RateConfirmation[]>("rateConfirmations");
  /** Miles per jurisdiction per truck per day, "<carrierOrgId>|<vehicle>|<date>" (fuel tax). */
  jurisdictionMiles = new PersistentMap<DailyMiles>("jurisdictionMiles");
  /** Fuel purchases entered by drivers and the office, by id. */
  fuelPurchases = new PersistentMap<FuelPurchase>("fuelPurchases");
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

  /** Invoices where an org is the carrier or the payer (or an account created them, given an account id). */
  invoicesOfParty(...ids: string[]): Invoice[] {
    const seen = new Map<string, Invoice>();
    for (const id of ids) for (const i of this.invoices.where("party", id)) seen.set(i.id, i);
    return [...seen.values()];
  }

  /** Loads in any of these statuses. */
  loadsIn(...statuses: Load["status"][]): Load[] {
    return statuses.flatMap((st) => this.loads.where("status", st));
  }

  /** Loads where an account is a party: through its companies or as an assigned driver. */
  loadsOf(accountId: string): Load[] {
    const seen = new Map<string, Load>();
    for (const term of [accountId, ...this.membershipsOf(accountId).map((m) => m.orgId)]) for (const l of this.loads.where("party", term)) seen.set(l.id, l);
    return [...seen.values()];
  }

  /** Loads where an org is shipper, broker or carrier (or a driver is assigned, given an account id). */
  loadsOfParty(id: string): Load[] {
    return this.loads.where("party", id);
  }

  loadByNumber(loadNumber: string): Load | undefined {
    return this.loads.where("number", loadNumber)[0];
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
