import type { Party } from "../transactions.js";
import { type Cursor, type Segment, X12ParseError, el, optEl, seg } from "./core.js";

/** N1/N3/N4 loop. N1 qualifiers: BT bill-to, SH ship-from, CN consignee. */
export function encodeParty(qualifier: string, p: Party): Segment[] {
  return [
    seg("N1", qualifier, p.name, p.locationCode ? "93" : undefined, p.locationCode),
    seg("N3", p.line1, p.line2),
    seg("N4", p.city, p.state, p.postalCode, p.country),
  ];
}

export function decodeParty(c: Cursor): { qualifier: string; party: Party } {
  const n1 = c.require("N1");
  const n3 = c.require("N3");
  const n4 = c.require("N4");
  const party: Party = {
    name: el(n1, 2),
    line1: el(n3, 1),
    city: el(n4, 1),
    state: el(n4, 2),
    postalCode: el(n4, 3),
    country: el(n4, 4) || "US",
  };
  const line2 = optEl(n3, 2);
  if (line2) party.line2 = line2;
  const code = optEl(n1, 4);
  if (code) party.locationCode = code;
  return { qualifier: el(n1, 1), party };
}

export function requireParty(found: Map<string, Party>, q: string, what: string): Party {
  const p = found.get(q);
  if (!p) throw new X12ParseError(`missing N1*${q} (${what})`);
  return p;
}
