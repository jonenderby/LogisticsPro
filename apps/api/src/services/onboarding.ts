import { type CanonicalDoc, type PartnerProfile, type TransactionType, type Transmission, TRANSACTIONS, toCanonicalDate, toCanonicalTime, validateProfile } from "@logisticspro/integration";
import { tx } from "@logisticspro/workspace";
import type { AppContext } from "../http.js";
import type { StoredProfile } from "../store.js";

/**
 * Bringing a trading partner live: what is set up, what still needs doing,
 * test messages sent in EDI test mode, and the switch to production once
 * every test has gone through (and, for EDI, been acknowledged with a 997).
 */

export type OnboardingState = "DONE" | "TODO" | "PROBLEM";
export interface OnboardingItem {
  id: string;
  title: string;
  state: OnboardingState;
  detail?: string;
  transaction?: TransactionType;
}

// Fixed details are marked with tx() so the app can translate them; the rest stay English.

/** Which transactions go from the business to the partner, by the partner's kind; the rest come from the partner. */
const TO_CARRIER: TransactionType[] = ["LOAD_TENDER", "RATE_QUOTE", "PICKUP_REQUEST", "PAYMENT_ADVICE"];
const TO_CUSTOMER: TransactionType[] = ["TENDER_RESPONSE", "SHIPMENT_STATUS", "FREIGHT_INVOICE"];
export const sentToPartner = (p: Pick<PartnerProfile, "kind">, txn: TransactionType) => (p.kind === "CARRIER" ? TO_CARRIER : TO_CUSTOMER).includes(txn);

const TEST_PARTY = (name: string, city: string, state: string, postalCode: string) => ({ name, line1: "100 Test St", city, state, postalCode, country: "US" });

/** A realistic test document for each transaction, marked TEST so nobody mistakes it for freight. */
export function sampleDoc<T extends TransactionType>(txn: T, p: Pick<PartnerProfile, "scac" | "name">, now: Date): CanonicalDoc<T> {
  const day = (d: number) => new Date(now.getTime() + d * 86_400_000);
  const scac = (p.scac ?? "TEST").slice(0, 4);
  const shipper = TEST_PARTY("TEST SHIPPER DC", "Memphis", "TN", "38103");
  const consignee = TEST_PARTY("TEST CONSIGNEE", "Dallas", "TX", "75201");
  const docs: { [K in TransactionType]: CanonicalDoc<K> } = {
    LOAD_TENDER: {
      purpose: "ORIGINAL",
      shipmentId: "TEST-0001",
      carrierScac: scac,
      paymentTerms: "PREPAID",
      equipmentType: "DRY_VAN",
      references: { bol: "TESTBOL1", po: ["TESTPO1"] },
      billTo: TEST_PARTY("TEST BILL TO", "Memphis", "TN", "38103"),
      stops: [
        { sequence: 1, type: "PICKUP", party: shipper, windowStart: toCanonicalTime(day(1)), windowEnd: toCanonicalTime(new Date(day(1).getTime() + 2 * 3_600_000)) },
        { sequence: 2, type: "DELIVERY", party: consignee, windowStart: toCanonicalTime(day(2)), windowEnd: toCanonicalTime(new Date(day(2).getTime() + 2 * 3_600_000)) },
      ],
      items: [{ description: "TEST FREIGHT", pieces: 10, packaging: "PLT", weightLb: 12000 }],
      totalWeightLb: 12000,
      totalPieces: 10,
      rateUsd: 1000,
    },
    TENDER_RESPONSE: { shipmentId: "TEST-0001", carrierScac: scac, decision: "ACCEPT", respondedOn: toCanonicalDate(now) },
    SHIPMENT_STATUS: { shipmentId: "TEST-0001", carrierScac: scac, statusCode: "LOADED", reason: "NORMAL", at: toCanonicalTime(now), location: { city: "Memphis", state: "TN", country: "US" }, references: { bol: "TESTBOL1" } },
    FREIGHT_INVOICE: {
      invoiceNumber: "TEST-INV-1",
      shipmentId: "TEST-0001",
      carrierScac: scac,
      invoiceDate: toCanonicalDate(now),
      paymentTerms: "PREPAID",
      currency: "USD",
      totalAmount: 1000,
      billTo: TEST_PARTY("TEST BILL TO", "Memphis", "TN", "38103"),
      shipper,
      consignee,
      references: { bol: "TESTBOL1", po: ["TESTPO1"] },
      pickupDate: toCanonicalDate(now),
      deliveryDate: toCanonicalDate(now),
      weightLb: 12000,
      pieces: 10,
      lines: [{ code: "LINEHAUL", description: "TEST LINEHAUL", quantity: 1, rate: 1000, amount: 1000 }],
    },
    PAYMENT_ADVICE: { paymentRef: "TEST0001", paymentDate: toCanonicalDate(now), method: "ACH", currency: "USD", totalAmount: 1000, payerName: "TEST PAYER", payeeName: p.name.slice(0, 60) || "TEST PAYEE", invoices: [{ invoiceNumber: "TEST-INV-1", amountPaid: 1000, amountInvoiced: 1000 }] },
    RATE_QUOTE: { quoteRef: "TEST-Q1", originPostal: "38103", originCountry: "US", destinationPostal: "75201", destinationCountry: "US", pickupDate: toCanonicalDate(day(1)), items: [{ pieces: 2, packaging: "PLT", weightLb: 1500, freightClass: "70" }] },
    PICKUP_REQUEST: { pickupRef: "TEST-P1", shipmentId: "TEST-0001", pickupParty: shipper, windowStart: toCanonicalTime(day(1)), windowEnd: toCanonicalTime(new Date(day(1).getTime() + 2 * 3_600_000)), contact: { name: "TEST DOCK", phone: "9015550100" }, destinationPostal: "75201", totalWeightLb: 1500, totalPieces: 2, hazmat: false },
  };
  return docs[txn] as CanonicalDoc<T>;
}

const enabledChannels = (p: PartnerProfile) => (Object.entries(p.channels) as Array<[TransactionType, NonNullable<PartnerProfile["channels"][TransactionType]>]>).filter(([, ch]) => ch.enabled);

const ofPartner = (ctx: AppContext, p: Pick<PartnerProfile, "ownerOrgId" | "key">) => ctx.store.transmissions.filter((t) => t.ownerOrgId === p.ownerOrgId && t.partnerKey === p.key);

/** Has this outbound test gone through? API: delivered. EDI: acknowledged when a 997 was asked for. */
function testState(p: PartnerProfile, txn: TransactionType, latest?: Transmission): { state: OnboardingState; detail: string } {
  if (!latest) return { state: "TODO", detail: tx("Send a test message") };
  if (latest.status === "FAILED" || latest.status === "REJECTED") return { state: "PROBLEM", detail: latest.error ?? `Test ${latest.status.toLowerCase()}` };
  if (latest.status === "ACKNOWLEDGED") return { state: "DONE", detail: tx("Test acknowledged with a 997") };
  if (latest.method === "EDI_X12" && p.edi?.ackRequested !== false) return { state: "TODO", detail: tx("Test sent; waiting for the partner's 997") };
  return { state: "DONE", detail: tx("Test delivered") };
}

export function onboardingStatus(ctx: AppContext, p: StoredProfile): { items: OnboardingItem[]; ready: boolean; live: boolean } {
  const items: OnboardingItem[] = [];
  const issues = validateProfile(p);
  items.push(issues.length ? { id: "settings", title: "Settings", state: "PROBLEM", detail: issues.map((i) => `${i.transaction ? `${TRANSACTIONS[i.transaction].title}: ` : ""}${i.message}`).join("; ") } : { id: "settings", title: "Settings", state: "DONE", detail: tx("Every channel is set up") });

  // Credentials are referenced by name; check each is set on the server without showing it.
  const refs = new Set<string>();
  for (const [, ch] of enabledChannels(p)) {
    const a = ch.endpoint?.auth;
    if (!a) continue;
    if (a.type === "apiKey" || a.type === "bearer") refs.add(a.secretRef);
    if (a.type === "basic") [a.usernameRef, a.passwordRef].forEach((r) => refs.add(r));
    if (a.type === "oauth2") [a.clientIdRef, a.clientSecretRef].forEach((r) => refs.add(r));
  }
  const missing = [...refs].filter((r) => !ctx.secrets(r));
  if (refs.size) items.push(missing.length ? { id: "credentials", title: "Credentials", state: "TODO", detail: `Set ${missing.map((r) => `LP_SECRET_${r.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`).join(", ")} on the server` } : { id: "credentials", title: "Credentials", state: "DONE", detail: `${refs.size} set on the server` });

  const sent = ofPartner(ctx, p);
  for (const [txn] of enabledChannels(p)) {
    const title = TRANSACTIONS[txn].title;
    if (sentToPartner(p, txn)) {
      const latest = [...sent].reverse().find((t) => t.direction === "OUTBOUND" && t.transaction === txn && t.refs.test === "true");
      items.push({ id: `test:${txn}`, title: `Test: ${title}`, transaction: txn, ...testState(p, txn, latest) });
    } else {
      const got = sent.filter((t) => t.direction === "INBOUND" && t.transaction === txn);
      const ok = got.filter((t) => t.status === "RECEIVED");
      items.push({ id: `received:${txn}`, title: `Received: ${title}`, transaction: txn, state: ok.length ? "DONE" : got.length ? "PROBLEM" : "TODO", detail: ok.length ? `${ok.length} received` : got.length ? (got[got.length - 1]!.error ?? tx("Rejected")) : tx("Ask the partner to send a test") });
    }
  }

  const receives = enabledChannels(p).some(([txn]) => !sentToPartner(p, txn));
  if (receives) {
    const edi = enabledChannels(p).filter(([txn, ch]) => !sentToPartner(p, txn) && ch.method === "EDI_X12");
    const api = enabledChannels(p).filter(([txn, ch]) => !sentToPartner(p, txn) && ch.method !== "EDI_X12");
    const ready = (!api.length || !!p.inboundTokenHash) && (!edi.length || !!p.inboundTokenHash || !!p.as2 || edi.every(([, ch]) => ch.transport !== "HTTPS"));
    items.push({ id: "inbound", title: "Partner can send to you", state: ready ? "DONE" : "TODO", detail: ready ? tx("Inbound connection is set up") : tx("Issue an inbound token and share it with the partner") });
  }

  const live = !!p.liveAt && (!p.edi || p.edi.usage === "P");
  const ready = items.every((i) => i.state === "DONE");
  items.push({ id: "live", title: "Live", state: live ? "DONE" : "TODO", detail: live ? `Live since ${p.liveAt!.slice(0, 10)}` : p.edi ? tx("EDI is in test mode (ISA15 T)") : tx("Not marked live yet") });
  return { items, ready, live };
}

/** Send a test message on each channel that goes to the partner, EDI in test mode. */
export async function sendTests(ctx: AppContext, p: StoredProfile, only?: TransactionType[]): Promise<Transmission[]> {
  const testProfile: PartnerProfile = p.edi ? { ...p, edi: { ...p.edi, usage: "T", senderId: p.edi.senderId || ctx.cfg.ediSenderId } } : p;
  const out: Transmission[] = [];
  for (const [txn] of enabledChannels(p)) {
    if (!sentToPartner(p, txn) || (only && !only.includes(txn))) continue;
    const t = await ctx.engine.send(txn, sampleDoc(txn, p, ctx.now()), testProfile, { test: "true" });
    ctx.store.transmissions.push(t);
    out.push(t);
  }
  return out;
}
