/**
 * Minimal, strict ANSI X12 reader/writer. Handles the ISA/GS/ST envelopes and
 * leaves transaction-set meaning to the per-set encoders in this folder.
 */

export interface Delimiters {
  element: string;
  segment: string;
  component: string;
}

export const DEFAULT_DELIMITERS: Delimiters = { element: "*", segment: "~", component: ">" };

export interface Segment {
  id: string;
  /** elements[0] is the XX01 element. */
  elements: string[];
}

type El = string | number | undefined | null;

/** Build a segment, dropping trailing empty elements. */
export function seg(id: string, ...elements: El[]): Segment {
  const els = elements.map((e) => (e === undefined || e === null ? "" : String(e)));
  while (els.length && els[els.length - 1] === "") els.pop();
  return { id, elements: els };
}

export function el(s: Segment, n: number): string {
  return s.elements[n - 1] ?? "";
}

export function optEl(s: Segment, n: number): string | undefined {
  const v = el(s, n);
  return v === "" ? undefined : v;
}

/** Strip delimiter characters from data so values cannot break the envelope. */
export function clean(value: string, d: Delimiters = DEFAULT_DELIMITERS): string {
  let out = value;
  for (const ch of [d.element, d.segment, d.component, "\r", "\n"]) out = out.split(ch).join(" ");
  return out.trim();
}

export function serializeSegments(segments: Segment[], d: Delimiters = DEFAULT_DELIMITERS): string {
  return segments.map((s) => [s.id, ...s.elements.map((e) => clean(e, d))].join(d.element) + d.segment).join("\n");
}

export interface EdiEnvelope {
  senderQualifier: string;
  senderId: string;
  receiverQualifier: string;
  receiverId: string;
  /** GS02/GS03 application codes; default to the ISA ids. */
  gsSender?: string;
  gsReceiver?: string;
  usage: "P" | "T";
  version: "004010";
  ackRequested: boolean;
}

export interface ControlNumbers {
  interchange: number;
  group: number;
  transaction: number;
}

export interface SetPayload {
  setId: string;
  functionalId: string;
  body: Segment[];
}

const pad = (v: string, n: number) => v.slice(0, n).padEnd(n, " ");
const zpad = (v: number, n: number) => String(v).padStart(n, "0");

function stamp(now: Date) {
  const iso = now.toISOString();
  return { yymmdd: iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10), ccyymmdd: iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10), hhmm: iso.slice(11, 13) + iso.slice(14, 16) };
}

/**
 * Wrap one or more transaction sets of the same functional group in
 * ISA/GS/ST..SE/GE/IEA envelopes.
 */
export function buildInterchange(sets: SetPayload[], env: EdiEnvelope, ctl: ControlNumbers, now = new Date(), d: Delimiters = DEFAULT_DELIMITERS): string {
  if (sets.length === 0) throw new Error("no transaction sets");
  const fid = sets[0]!.functionalId;
  if (sets.some((s) => s.functionalId !== fid)) throw new Error("all sets in a group must share a functional id");
  const t = stamp(now);
  const isa = [
    "ISA",
    "00",
    pad("", 10),
    "00",
    pad("", 10),
    pad(env.senderQualifier, 2),
    pad(env.senderId, 15),
    pad(env.receiverQualifier, 2),
    pad(env.receiverId, 15),
    t.yymmdd,
    t.hhmm,
    "U",
    "00401",
    zpad(ctl.interchange, 9),
    env.ackRequested ? "1" : "0",
    env.usage,
    d.component,
  ].join(d.element) + d.segment;

  const lines: Segment[] = [seg("GS", fid, env.gsSender ?? env.senderId.trim(), env.gsReceiver ?? env.receiverId.trim(), t.ccyymmdd, t.hhmm, ctl.group, "X", env.version)];
  sets.forEach((s, i) => {
    const stCtl = zpad(ctl.transaction + i, 4);
    lines.push(seg("ST", s.setId, stCtl), ...s.body, seg("SE", s.body.length + 2, stCtl));
  });
  lines.push(seg("GE", sets.length, ctl.group), seg("IEA", 1, zpad(ctl.interchange, 9)));
  return `${isa}\n${serializeSegments(lines, d)}`;
}

export interface ParsedTransaction {
  setId: string;
  control: string;
  body: Segment[];
}

export interface ParsedGroup {
  functionalId: string;
  sender: string;
  receiver: string;
  control: string;
  version: string;
  transactions: ParsedTransaction[];
}

export interface ParsedInterchange {
  delimiters: Delimiters;
  senderQualifier: string;
  senderId: string;
  receiverQualifier: string;
  receiverId: string;
  control: string;
  usage: string;
  ackRequested: boolean;
  groups: ParsedGroup[];
}

export class X12ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "X12ParseError";
  }
}

/** Parse an interchange; delimiters are read from the fixed-width ISA segment. */
export function parseInterchange(raw: string): ParsedInterchange {
  const text = raw.replace(/^﻿/, "").trimStart();
  if (!text.startsWith("ISA") || text.length < 106) throw new X12ParseError("Not an X12 interchange (missing ISA)");
  const element = text[3]!;
  const component = text[104]!;
  const segment = text[105]!;
  const d: Delimiters = { element, segment, component };
  const segments: Segment[] = text
    .split(segment)
    .map((s) => s.replace(/^[\r\n]+|[\r\n]+$/g, ""))
    .filter((s) => s.length > 0)
    .map((s) => {
      const [id, ...elements] = s.split(element);
      return { id: id!.trim(), elements };
    });

  const isa = segments[0]!;
  if (isa.id !== "ISA" || isa.elements.length !== 16) throw new X12ParseError("ISA must have 16 elements");
  const out: ParsedInterchange = {
    delimiters: d,
    senderQualifier: el(isa, 5).trim(),
    senderId: el(isa, 6).trim(),
    receiverQualifier: el(isa, 7).trim(),
    receiverId: el(isa, 8).trim(),
    control: el(isa, 13),
    ackRequested: el(isa, 14) === "1",
    usage: el(isa, 15),
    groups: [],
  };

  let group: ParsedGroup | undefined;
  let tx: ParsedTransaction | undefined;
  let txCount = 0;
  for (let i = 1; i < segments.length; i++) {
    const s = segments[i]!;
    switch (s.id) {
      case "GS":
        group = { functionalId: el(s, 1), sender: el(s, 2), receiver: el(s, 3), control: el(s, 6), version: el(s, 8), transactions: [] };
        out.groups.push(group);
        break;
      case "ST":
        if (!group) throw new X12ParseError("ST outside a GS group");
        tx = { setId: el(s, 1), control: el(s, 2), body: [] };
        txCount = 1;
        break;
      case "SE": {
        if (!tx || !group) throw new X12ParseError("SE without ST");
        txCount++;
        if (Number(el(s, 1)) !== txCount) throw new X12ParseError(`SE count ${el(s, 1)} != actual ${txCount} in set ${tx.control}`);
        if (el(s, 2) !== tx.control) throw new X12ParseError(`SE control ${el(s, 2)} != ST control ${tx.control}`);
        group.transactions.push(tx);
        tx = undefined;
        break;
      }
      case "GE":
        if (!group) throw new X12ParseError("GE without GS");
        if (Number(el(s, 1)) !== group.transactions.length) throw new X12ParseError("GE transaction count mismatch");
        if (el(s, 2) !== group.control) throw new X12ParseError("GE control mismatch");
        group = undefined;
        break;
      case "IEA":
        if (el(s, 2) !== out.control) throw new X12ParseError("IEA control mismatch");
        if (Number(el(s, 1)) !== out.groups.length) throw new X12ParseError("IEA group count mismatch");
        break;
      default:
        if (!tx) throw new X12ParseError(`Segment ${s.id} outside a transaction set`);
        tx.body.push(s);
        txCount++;
    }
  }
  if (tx) throw new X12ParseError("Unterminated transaction set (missing SE)");
  return out;
}

// ------------------------------------------------------------- date helpers
/** 2026-10-05T14:30:00Z -> { date: "20261005", time: "1430" } */
export function x12DateTime(iso: string): { date: string; time: string } {
  return { date: iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10), time: iso.slice(11, 13) + iso.slice(14, 16) };
}
export function x12Date(isoDate: string): string {
  return isoDate.slice(0, 4) + isoDate.slice(5, 7) + isoDate.slice(8, 10);
}
export function fromX12Date(ccyymmdd: string): string {
  if (!/^\d{8}$/.test(ccyymmdd)) throw new X12ParseError(`bad date ${ccyymmdd}`);
  return `${ccyymmdd.slice(0, 4)}-${ccyymmdd.slice(4, 6)}-${ccyymmdd.slice(6, 8)}`;
}
export function fromX12DateTime(ccyymmdd: string, hhmm: string): string {
  if (!/^\d{4}$/.test(hhmm)) throw new X12ParseError(`bad time ${hhmm}`);
  return `${fromX12Date(ccyymmdd)}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00Z`;
}

/** X12 "N2" amounts: implied two decimals. */
export const toN2 = (amount: number) => String(Math.round(amount * 100));
export const fromN2 = (v: string) => Math.round(Number(v)) / 100;

/** Helper for sequential decoding. */
export class Cursor {
  private i = 0;
  constructor(private readonly segs: Segment[]) {}
  peek(): Segment | undefined {
    return this.segs[this.i];
  }
  next(): Segment | undefined {
    return this.segs[this.i++];
  }
  /** Consume the next segment if it has this id. */
  take(id: string): Segment | undefined {
    if (this.peek()?.id === id) return this.next();
    return undefined;
  }
  /** Consume consecutive segments with this id. */
  takeAll(id: string): Segment[] {
    const out: Segment[] = [];
    while (this.peek()?.id === id) out.push(this.next()!);
    return out;
  }
  require(id: string): Segment {
    const s = this.next();
    if (!s || s.id !== id) throw new X12ParseError(`expected ${id}, found ${s?.id ?? "end of set"}`);
    return s;
  }
  done(): boolean {
    return this.i >= this.segs.length;
  }
}
