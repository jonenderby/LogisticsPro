import type { Invoice, Load, LoadEvent, Organization } from "@logisticspro/domain";
import { applyStatusEvent, newId, statusText } from "@logisticspro/domain";
import {
  type CanonicalDoc,
  type FreightInvoice,
  type IntegrationEngine,
  type LoadTender,
  type PartnerProfile,
  type ShipmentStatus,
  type TenderResponse,
  type TransactionType,
  type Transmission,
  invoiceDoc,
  statusFromEvent,
  tenderFromLoad,
  tenderResponseDoc,
} from "@logisticspro/integration";
import type { Config } from "../config.js";
import { HttpError } from "../http.js";
import type { MemoryStore, StoredProfile } from "../store.js";
import { recordOutcome } from "./reliability.js";

export const RECEIVING = "receiving";

/** Where an inbound-tendered load came from, so replies go back the same way. */
interface Origin {
  carrierOrgId: string;
  partnerKey: string;
}

/**
 * Routes business events to whoever needs them, in the format each recipient
 * chose. Parties on the platform always see changes in the app; when they
 * have also set receiving preferences (their ERP/TMS), the hub sends the
 * matching transaction there. Partners off the platform are reached through
 * the sending organization's partner profile.
 */
export class IntegrationHub {
  /** Called when a partner's API or EDI message creates or changes a load (tenders, tender responses). */
  onLoadSaved?: (prior: Load | undefined, next: Load) => void;

  constructor(
    private readonly store: MemoryStore,
    private readonly engine: IntegrationEngine,
    private readonly cfg: Config,
    private readonly now: () => Date,
  ) {}

  private withDefaults(p: StoredProfile): PartnerProfile {
    if (!p.edi) return p;
    return { ...p, edi: { ...p.edi, senderId: p.edi.senderId || this.cfg.ediSenderId } };
  }

  private record(t: Transmission): Transmission {
    this.store.transmissions.push(t);
    return t;
  }

  private failed(ownerOrgId: string, partnerKey: string, tx: TransactionType, error: string, refs: Record<string, string>): Transmission {
    return this.record({ id: newId("tx"), partnerKey, ownerOrgId, transaction: tx, method: "API_JSON", transport: "HTTPS", direction: "OUTBOUND", status: "FAILED", contentType: "", payload: "", error, refs, createdAt: this.now().toISOString() });
  }

  /** Send to an on-platform org's own systems, if it asked to receive this transaction. */
  async toOrg<T extends TransactionType>(orgId: string, tx: T, build: () => CanonicalDoc<T>, refs: Record<string, string>): Promise<Transmission | undefined> {
    const prefs = this.store.profile(orgId, RECEIVING);
    const ch = prefs?.channels[tx];
    if (!prefs || !ch || !ch.enabled) return undefined;
    let doc: CanonicalDoc<T>;
    try {
      doc = build();
    } catch (e) {
      return this.failed(orgId, RECEIVING, tx, (e as Error).message, refs);
    }
    return this.record(await this.engine.send(tx, doc, this.withDefaults(prefs), refs));
  }

  /** Send to an external partner configured by `ownerOrgId`. */
  async toPartner<T extends TransactionType>(ownerOrgId: string, partnerKey: string, tx: T, build: () => CanonicalDoc<T>, refs: Record<string, string>): Promise<Transmission> {
    const profile = this.store.profile(ownerOrgId, partnerKey);
    if (!profile) throw new HttpError(409, "PARTNER_NOT_CONFIGURED", `Set up partner "${partnerKey}" under Integrations before sending`);
    let doc: CanonicalDoc<T>;
    try {
      doc = build();
    } catch (e) {
      return this.failed(ownerOrgId, partnerKey, tx, (e as Error).message, refs);
    }
    return this.record(await this.engine.send(tx, doc, this.withDefaults(profile), refs));
  }

  private scacOf(load: Load): string {
    if (load.externalCarrierKey) {
      const owner = load.brokerOrgId ?? load.shipperOrgId;
      const s = this.store.profile(owner, load.externalCarrierKey)?.scac;
      if (s) return s;
    }
    const org = load.carrierOrgId ? this.store.orgs.get(load.carrierOrgId) : undefined;
    if (!org?.scac) throw new Error("Carrier has no SCAC; add it in company settings to exchange EDI/API data");
    return org.scac;
  }

  /** The org that tenders to the carrier: the broker if there is one, else the shipper. */
  tenderingOrg(load: Load): string {
    return load.brokerOrgId ?? load.shipperOrgId;
  }

  async tender(load: Load, purpose: LoadTender["purpose"]): Promise<Transmission[]> {
    const out: Transmission[] = [];
    const refs = { loadId: load.id };
    const build = () => tenderFromLoad(load, this.scacOf(load), purpose);
    if (load.externalCarrierKey) out.push(await this.toPartner(this.tenderingOrg(load), load.externalCarrierKey, "LOAD_TENDER", build, refs));
    else if (load.carrierOrgId) {
      const t = await this.toOrg(load.carrierOrgId, "LOAD_TENDER", build, refs);
      if (t) out.push(t);
    }
    return out;
  }

  async tenderResponse(load: Load, decision: TenderResponse["decision"], reason?: string): Promise<Transmission[]> {
    const refs = { loadId: load.id };
    const build = () => tenderResponseDoc(load, this.scacOf(load), decision, this.now().toISOString(), reason);
    const out: Transmission[] = [];
    const origin = this.store.origins.get(load.id);
    if (origin) out.push(await this.toPartner(origin.carrierOrgId, origin.partnerKey, "TENDER_RESPONSE", build, refs));
    const t = await this.toOrg(this.tenderingOrg(load), "TENDER_RESPONSE", build, refs);
    if (t) out.push(t);
    return out;
  }

  /** Status goes to every party except the carrier that reported it, plus the origin partner. */
  async status(load: Load, event: LoadEvent, extra: { reason?: ShipmentStatus["reason"]; eta?: string } = {}): Promise<Transmission[]> {
    const refs = { loadId: load.id, eventId: event.id };
    const out: Transmission[] = [];
    const build = (): ShipmentStatus => {
      const doc = statusFromEvent(load, event, this.scacOf(load), extra.reason, extra.eta);
      if (!doc) throw new Error("internal event");
      return doc;
    };
    if (!statusFromEvent(load, event, "XXXX")) return out; // internal-only event
    const origin = this.store.origins.get(load.id);
    if (origin) out.push(await this.toPartner(origin.carrierOrgId, origin.partnerKey, "SHIPMENT_STATUS", build, refs));
    for (const orgId of new Set([load.shipperOrgId, load.brokerOrgId].filter((x): x is string => !!x))) {
      const t = await this.toOrg(orgId, "SHIPMENT_STATUS", build, refs);
      if (t) out.push(t);
    }
    return out;
  }

  /**
   * Invoice delivery follows the bill-to party's choice: its receiving
   * preferences if it is on the platform, otherwise the carrier's partner
   * profile for that customer (JSON, XML or EDI 210).
   */
  async invoice(inv: Invoice, load: Load): Promise<Transmission[]> {
    const refs = { loadId: load.id, invoiceId: inv.id };
    const build = (): FreightInvoice => invoiceDoc(inv, load.paymentTerms, load.loadNumber);
    const out: Transmission[] = [];
    const origin = this.store.origins.get(load.id);
    const partnerKey = inv.billTo.partnerKey ?? origin?.partnerKey;
    if (partnerKey) out.push(await this.toPartner(inv.carrierOrgId, partnerKey, "FREIGHT_INVOICE", build, refs));
    if (inv.billTo.orgId && this.store.orgs.has(inv.billTo.orgId)) {
      const t = await this.toOrg(inv.billTo.orgId, "FREIGHT_INVOICE", build, refs);
      if (t) out.push(t);
    }
    return out;
  }

  // ------------------------------------------------------------------ inbound

  private externalOrg(ownerOrgId: string, partnerKey: string, name: string): Organization {
    const id = `ext_${ownerOrgId}_${partnerKey}`;
    let org = this.store.orgs.get(id);
    if (!org) {
      org = { id, name, kinds: ["SHIPPER"], distributionCenters: [], createdAt: this.now().toISOString() };
      this.store.orgs.set(id, org);
    }
    return org;
  }

  private findLoad(orgId: string, shipmentId: string): Load | undefined {
    const l = this.store.loadByNumber(shipmentId);
    return l && [l.shipperOrgId, l.brokerOrgId, l.carrierOrgId].includes(orgId) ? l : undefined;
  }

  /** A partner may only touch loads it carries (or tendered to us). */
  private assertPartnerOwns(load: Load, partnerKey: string): void {
    if (load.externalCarrierKey !== partnerKey && this.store.origins.get(load.id)?.partnerKey !== partnerKey) {
      throw new HttpError(403, "FORBIDDEN", `Load ${load.loadNumber} is not with partner ${partnerKey}`);
    }
  }

  /** Apply a document received from an external partner of `orgId`. */
  async applyInbound(orgId: string, partnerKey: string, tx: TransactionType, doc: unknown, source: "API" | "EDI"): Promise<{ loadId?: string; invoiceId?: string; action: string }> {
    const now = this.now().toISOString();
    switch (tx) {
      case "LOAD_TENDER": {
        const t = doc as LoadTender;
        const profile = this.store.profile(orgId, partnerKey);
        const shipper = this.externalOrg(orgId, partnerKey, profile?.name ?? partnerKey);
        const existing = this.store.loads.where("shipperRef", `${shipper.id}|${t.shipmentId}`)[0];
        if (t.purpose === "CANCEL") {
          if (existing) this.store.loads.set(existing.id, { ...existing, status: "CANCELLED", version: existing.version + 1, updatedAt: now });
          return { loadId: existing?.id, action: "cancelled" };
        }
        const base: Load = existing ?? {
          id: newId("load"),
          loadNumber: this.store.nextLoadNumber(),
          version: 0,
          status: "TENDERED",
          mode: "FTL",
          service: "STANDARD",
          equipment: { type: t.equipmentType, lengthFt: 53 },
          shipperOrgId: shipper.id,
          carrierOrgId: orgId,
          references: { po: [] },
          stops: [],
          items: [],
          accessorials: [],
          billTo: { address: { ...t.billTo } },
          paymentTerms: t.paymentTerms,
          teamRequired: false,
          legs: [],
          events: [],
          documents: [],
          createdByAccountId: "system",
          createdAt: now,
          updatedAt: now,
        };
        if (existing && (existing.pickedUpAt || existing.shipConfirmedAt)) return { loadId: existing.id, action: "ignored: load already picked up" };
        const load: Load = {
          ...base,
          service: t.service ?? "STANDARD",
          teamRequired: t.service === "TEAM_EXPEDITED",
          equipment: { type: t.equipmentType, lengthFt: t.equipmentLengthFt ?? 53 },
          references: { bol: t.references.bol, po: t.references.po ?? [], shipperRef: t.shipmentId },
          stops: t.stops.map((s) => ({
            id: newId("stop"),
            sequence: s.sequence,
            type: s.type,
            address: { ...s.party },
            window: { start: s.windowStart, end: s.windowEnd },
            appointmentRef: s.appointmentRef,
            contact: s.contact,
          })),
          items: t.items.map((i) => ({ ...i })),
          oversize: t.oversize ? { ...t.oversize, permits: [] } : undefined,
          rate: t.rateUsd !== undefined ? { amount: t.rateUsd, currency: "USD" } : base.rate,
          billTo: { address: { ...t.billTo } },
          paymentTerms: t.paymentTerms,
          notes: t.notes,
          legs: existing ? [] : base.legs,
          version: base.version + 1,
          updatedAt: now,
        };
        this.store.loads.set(load.id, load);
        this.onLoadSaved?.(existing, load);
        this.store.origins.set(load.id, { carrierOrgId: orgId, partnerKey });
        return { loadId: load.id, action: existing ? "updated" : "created" };
      }
      case "TENDER_RESPONSE": {
        const r = doc as TenderResponse;
        const load = this.findLoad(orgId, r.shipmentId);
        if (!load || load.externalCarrierKey !== partnerKey) throw new HttpError(404, "NOT_FOUND", `No tender ${r.shipmentId} to ${partnerKey}`);
        const next: Load =
          r.decision === "ACCEPT"
            ? { ...load, status: "BOOKED", references: { ...load.references, pro: r.carrierReference ?? load.references.pro }, tender: { ...load.tender, at: load.tender?.at ?? now, acceptedAt: now, via: "PARTNER" } }
            : { ...load, status: "DRAFT", externalCarrierKey: undefined, tender: undefined };
        this.store.loads.set(load.id, { ...next, version: load.version + 1, updatedAt: now });
        this.onLoadSaved?.(load, this.store.loads.get(load.id)!);
        return { loadId: load.id, action: r.decision === "ACCEPT" ? "booked" : "declined" };
      }
      case "SHIPMENT_STATUS": {
        const s = doc as ShipmentStatus;
        const load = this.findLoad(orgId, s.shipmentId);
        if (!load) throw new HttpError(404, "NOT_FOUND", `No load ${s.shipmentId}`);
        this.assertPartnerOwns(load, partnerKey);
        const updated = applyStatusEvent(load, {
          code: s.statusCode,
          at: s.at,
          city: s.location.city,
          state: s.location.state,
          geo: s.location.lat !== undefined && s.location.lng !== undefined ? { lat: s.location.lat, lng: s.location.lng } : undefined,
          note: s.reason !== "NORMAL" ? `Reason: ${s.reason.toLowerCase().replace(/_/g, " ")}` : undefined,
          eta: s.eta,
          source,
        });
        if (s.references.pro && !updated.references.pro) updated.references = { ...updated.references, pro: s.references.pro };
        this.store.loads.set(load.id, updated);
        recordOutcome(this.store, updated);
        this.store.messages.push({
          id: newId("msg"),
          threadId: `load:${load.id}`,
          loadId: load.id,
          senderAccountId: "system",
          kind: "STATUS",
          statusCode: s.statusCode,
          body: `${statusText(s.statusCode)}${s.location.city ? ` · ${s.location.city}, ${s.location.state ?? ""}` : ""} (via ${source} from ${partnerKey})`,
          visibleToOrgIds: [load.shipperOrgId, load.brokerOrgId, load.carrierOrgId].filter((x): x is string => !!x),
          createdAt: now,
        });
        return { loadId: load.id, action: `status ${s.statusCode}` };
      }
      case "FREIGHT_INVOICE": {
        const f = doc as FreightInvoice;
        const load = this.findLoad(orgId, f.shipmentId);
        if (!load) throw new HttpError(404, "NOT_FOUND", `No load ${f.shipmentId}`);
        this.assertPartnerOwns(load, partnerKey);
        const inv: Invoice = {
          id: newId("inv"),
          invoiceNumber: f.invoiceNumber,
          loadId: load.id,
          loadNumber: load.loadNumber,
          carrierOrgId: `ext_${orgId}_${partnerKey}`,
          carrierScac: f.carrierScac,
          billTo: { orgId, address: { ...f.billTo } },
          shipper: { ...f.shipper },
          consignee: { ...f.consignee },
          references: { bol: f.references.bol, po: f.references.po ?? [], pro: f.references.pro },
          pickupDate: f.pickupDate,
          deliveryDate: f.deliveryDate,
          weightLb: f.weightLb,
          pieces: f.pieces,
          currency: f.currency,
          lines: f.lines.map((l) => ({ ...l })),
          total: f.totalAmount,
          terms: "NET30",
          issuedAt: `${f.invoiceDate}T00:00:00.000Z`,
          status: "SENT",
          createdByAccountId: "system",
        };
        this.store.invoices.set(inv.id, inv);
        return { loadId: load.id, invoiceId: inv.id, action: "invoice received" };
      }
      default:
        throw new HttpError(400, "UNSUPPORTED", `${tx} is not accepted inbound`);
    }
  }
}
