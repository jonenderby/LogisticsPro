import { randomUUID } from "node:crypto";
import { applyFieldMap, coerceToSchema, reverseFieldMap } from "./mapping.js";
import { type Channel, type IntegrationMethod, type PartnerProfile, type TransportKind, methodSupports } from "./profile.js";
import { type CanonicalDoc, TRANSACTIONS, type TransactionType, ValidationError, validateDoc } from "./transactions.js";
import { type SecretResolver, type Transport, type TransportResult, authHeaders } from "./transport.js";
import { fromXml, toXml } from "./xml.js";
import {
  type ControlNumbers,
  type EdiEnvelope,
  type ParsedInterchange,
  type Segment,
  buildInterchange,
  build997,
  decode204,
  decode210,
  decode214,
  decode990,
  decode997,
  encode204,
  encode210,
  encode214,
  encode990,
  parseInterchange,
  resolveCodes,
  type AckResult,
  type CodeOverrides,
} from "./x12/index.js";

export interface RenderedMessage {
  transaction: TransactionType;
  method: IntegrationMethod;
  contentType: string;
  body: string;
  control?: ControlNumbers;
}

export interface ControlNumberStore {
  next(partnerKey: string): ControlNumbers;
}

export class MemoryControlNumbers implements ControlNumberStore {
  private counters = new Map<string, number>();
  next(partnerKey: string): ControlNumbers {
    const n = (this.counters.get(partnerKey) ?? 0) + 1;
    this.counters.set(partnerKey, n);
    return { interchange: n, group: n, transaction: 1 };
  }
}

export interface Transmission {
  id: string;
  partnerKey: string;
  ownerOrgId: string;
  transaction: TransactionType;
  method: IntegrationMethod;
  transport: TransportKind;
  direction: "OUTBOUND" | "INBOUND";
  status: "SENT" | "FAILED" | "RECEIVED" | "ACKNOWLEDGED" | "REJECTED";
  contentType: string;
  payload: string;
  control?: string;
  response?: TransportResult;
  error?: string;
  refs: Record<string, string>;
  createdAt: string;
}

export class ChannelNotConfigured extends Error {
  constructor(partner: string, tx: TransactionType) {
    super(`Partner ${partner} has no enabled channel for ${tx}`);
    this.name = "ChannelNotConfigured";
  }
}

const CONTENT_TYPES: Record<IntegrationMethod, string> = {
  API_JSON: "application/json",
  API_XML: "application/xml",
  EDI_X12: "application/edi-x12",
};

function encodeSet(tx: TransactionType, doc: unknown, codes: ReturnType<typeof resolveCodes>): Segment[] {
  switch (tx) {
    case "LOAD_TENDER":
      return encode204(doc as CanonicalDoc<"LOAD_TENDER">, codes);
    case "TENDER_RESPONSE":
      return encode990(doc as CanonicalDoc<"TENDER_RESPONSE">);
    case "SHIPMENT_STATUS":
      return encode214(doc as CanonicalDoc<"SHIPMENT_STATUS">, codes);
    case "FREIGHT_INVOICE":
      return encode210(doc as CanonicalDoc<"FREIGHT_INVOICE">, codes);
    default:
      throw new Error(`${tx} has no X12 mapping`);
  }
}

const SET_TO_TX: Record<string, TransactionType> = { "204": "LOAD_TENDER", "990": "TENDER_RESPONSE", "214": "SHIPMENT_STATUS", "210": "FREIGHT_INVOICE" };

function decodeSet(setId: string, body: Segment[], codes: ReturnType<typeof resolveCodes>): { tx: TransactionType; doc: unknown } {
  const tx = SET_TO_TX[setId];
  switch (setId) {
    case "204":
      return { tx: tx!, doc: decode204(body, codes) };
    case "990":
      return { tx: tx!, doc: decode990(body) };
    case "214":
      return { tx: tx!, doc: decode214(body, codes) };
    case "210":
      return { tx: tx!, doc: decode210(body, codes) };
    default:
      throw new Error(`unsupported transaction set ${setId}`);
  }
}

export interface InboundEdiDocument {
  transaction: TransactionType;
  doc: unknown;
  groupControl: string;
  setControl: string;
}

export interface InboundEdiResult {
  interchange: ParsedInterchange;
  documents: InboundEdiDocument[];
  acks: AckResult[];
  errors: Array<{ groupControl: string; setControl: string; setId: string; message: string }>;
  /** 997 to return to the sender (undefined when the inbound was itself a 997). */
  ack997?: string;
}

export interface EngineOptions {
  transports: Partial<Record<TransportKind, Transport>>;
  secrets: SecretResolver;
  controlNumbers?: ControlNumberStore;
  now?: () => Date;
}

/**
 * The integration engine: validate a canonical document, render it in the
 * method the partner chose for that transaction, and deliver it.
 */
export class IntegrationEngine {
  private readonly controls: ControlNumberStore;
  private readonly now: () => Date;

  constructor(private readonly opts: EngineOptions) {
    this.controls = opts.controlNumbers ?? new MemoryControlNumbers();
    this.now = opts.now ?? (() => new Date());
  }

  channelFor(profile: PartnerProfile, tx: TransactionType): Channel {
    const ch = profile.channels[tx];
    if (!ch || !ch.enabled) throw new ChannelNotConfigured(profile.name, tx);
    if (!methodSupports(ch.method, tx)) throw new Error(`${tx} cannot be sent as ${ch.method}`);
    return ch;
  }

  render<T extends TransactionType>(tx: T, doc: CanonicalDoc<T> | unknown, profile: PartnerProfile, methodOverride?: IntegrationMethod): RenderedMessage {
    const valid = validateDoc(tx, doc);
    const ch = methodOverride ? { ...this.channelFor(profile, tx), method: methodOverride } : this.channelFor(profile, tx);
    switch (ch.method) {
      case "API_JSON":
        return { transaction: tx, method: ch.method, contentType: CONTENT_TYPES.API_JSON, body: JSON.stringify(applyFieldMap(valid, ch.fieldMap), null, 2) };
      case "API_XML":
        return { transaction: tx, method: ch.method, contentType: CONTENT_TYPES.API_XML, body: toXml(ch.xmlRoot ?? rootName(tx), applyFieldMap(valid, ch.fieldMap)) };
      case "EDI_X12": {
        if (!profile.edi) throw new Error(`Partner ${profile.name} has no EDI interchange settings`);
        const def = TRANSACTIONS[tx].x12!;
        const codes = resolveCodes(profile.edi.codeOverrides as CodeOverrides);
        const control = this.controls.next(profile.key);
        const env: EdiEnvelope = { ...profile.edi, version: "004010" };
        const body = buildInterchange([{ setId: def.set, functionalId: def.functionalId, body: encodeSet(tx, valid, codes) }], env, control, this.now());
        return { transaction: tx, method: ch.method, contentType: CONTENT_TYPES.EDI_X12, body, control };
      }
    }
  }

  async send<T extends TransactionType>(tx: T, doc: CanonicalDoc<T> | unknown, profile: PartnerProfile, refs: Record<string, string> = {}): Promise<Transmission> {
    const base = { id: `tx_${randomUUID().replace(/-/g, "").slice(0, 20)}`, partnerKey: profile.key, ownerOrgId: profile.ownerOrgId, transaction: tx, direction: "OUTBOUND" as const, refs, createdAt: this.now().toISOString() };
    let rendered: RenderedMessage;
    let ch: Channel;
    try {
      ch = this.channelFor(profile, tx);
      rendered = this.render(tx, doc, profile);
    } catch (e) {
      const ch0 = profile.channels[tx];
      return { ...base, method: ch0?.method ?? "API_JSON", transport: ch0?.transport ?? "HTTPS", status: "FAILED", contentType: "", payload: "", error: e instanceof ValidationError ? e.message : (e as Error).message };
    }
    const transport = this.opts.transports[ch.transport];
    const record = { ...base, method: rendered.method, transport: ch.transport, contentType: rendered.contentType, payload: rendered.body, control: rendered.control ? String(rendered.control.interchange).padStart(9, "0") : undefined };
    if (!transport) return { ...record, status: "FAILED", error: `no ${ch.transport} transport configured` };
    try {
      const headers = ch.endpoint ? { ...ch.endpoint.headers, ...(await authHeaders(ch.endpoint.auth, this.opts.secrets)) } : {};
      const ext = rendered.method === "API_JSON" ? "json" : rendered.method === "API_XML" ? "xml" : "x12";
      const result = await transport.send({
        partnerKey: profile.key,
        transport: ch.transport,
        url: ch.endpoint?.url,
        httpMethod: ch.endpoint?.httpMethod ?? "POST",
        headers,
        contentType: rendered.contentType,
        body: rendered.body,
        filename: `${tx.toLowerCase()}_${record.control ?? base.id}.${ext}`,
      });
      return { ...record, status: result.ok ? "SENT" : "FAILED", response: result, error: result.error };
    } catch (e) {
      return { ...record, status: "FAILED", error: (e as Error).message };
    }
  }

  /** Parse an inbound API payload (JSON or XML) into a validated canonical document. */
  parseApi<T extends TransactionType>(tx: T, method: "API_JSON" | "API_XML", body: string, channel?: Pick<Channel, "fieldMap">): CanonicalDoc<T> {
    const raw = method === "API_JSON" ? (JSON.parse(body) as unknown) : fromXml(body).value;
    const canonical = reverseFieldMap(raw, channel?.fieldMap);
    return validateDoc(tx, coerceToSchema(canonical, TRANSACTIONS[tx].schema));
  }

  /**
   * Parse an inbound X12 interchange, decode every set it carries and build
   * the 997 functional acknowledgment to return.
   */
  parseEdi(raw: string, codeOverrides: CodeOverrides = {}): InboundEdiResult {
    const ic = parseInterchange(raw);
    const codes = resolveCodes(codeOverrides);
    const documents: InboundEdiDocument[] = [];
    const errors: InboundEdiResult["errors"] = [];
    const acks: AckResult[] = [];
    const rejected = new Map<string, string>();
    for (const g of ic.groups) {
      for (const t of g.transactions) {
        if (t.setId === "997") {
          acks.push(decode997(t.body));
          continue;
        }
        try {
          const { tx, doc } = decodeSet(t.setId, t.body, codes);
          documents.push({ transaction: tx, doc: validateDoc(tx, doc), groupControl: g.control, setControl: t.control });
        } catch (e) {
          rejected.set(`${g.control}:${t.control}`, (e as Error).message);
          errors.push({ groupControl: g.control, setControl: t.control, setId: t.setId, message: (e as Error).message });
        }
      }
    }
    const ackGroups = ic.groups.filter((g) => g.functionalId !== "FA");
    let ack997: string | undefined;
    if (ackGroups.length) {
      const bodies = build997({ ...ic, groups: ackGroups }, rejected);
      const control = this.controls.next(`${ic.senderId}:997`);
      const env: EdiEnvelope = {
        senderQualifier: ic.receiverQualifier,
        senderId: ic.receiverId,
        receiverQualifier: ic.senderQualifier,
        receiverId: ic.senderId,
        usage: ic.usage === "P" ? "P" : "T",
        version: "004010",
        ackRequested: false,
      };
      ack997 = buildInterchange(bodies.map((body) => ({ setId: "997", functionalId: "FA", body })), env, control, this.now());
    }
    return { interchange: ic, documents, acks, errors, ack997 };
  }
}

export function rootName(tx: TransactionType): string {
  return tx
    .toLowerCase()
    .split("_")
    .map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join("");
}
