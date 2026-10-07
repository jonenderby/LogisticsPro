import { type ParsedInterchange, type Segment, el, seg } from "./core.js";

export interface AckResult {
  groupControl: string;
  functionalId: string;
  accepted: boolean;
  transactions: Array<{ setId: string; control: string; accepted: boolean; error?: string }>;
}

/** Build 997 bodies (one per received group) acknowledging an inbound interchange. */
export function build997(received: ParsedInterchange, rejected: Map<string, string> = new Map()): Segment[][] {
  return received.groups.map((g) => {
    const body: Segment[] = [seg("AK1", g.functionalId, g.control)];
    let ok = 0;
    for (const t of g.transactions) {
      const err = rejected.get(`${g.control}:${t.control}`);
      body.push(seg("AK2", t.setId, t.control));
      body.push(seg("AK5", err ? "R" : "A", err ? "5" : undefined));
      if (!err) ok++;
    }
    const n = g.transactions.length;
    const status = ok === n ? "A" : ok === 0 ? "R" : "P";
    body.push(seg("AK9", status, n, n, ok));
    return body;
  });
}

export function decode997(body: Segment[]): AckResult {
  const ak1 = body.find((s) => s.id === "AK1");
  const ak9 = body.find((s) => s.id === "AK9");
  const res: AckResult = { functionalId: ak1 ? el(ak1, 1) : "", groupControl: ak1 ? el(ak1, 2) : "", accepted: ak9 ? el(ak9, 1) !== "R" : false, transactions: [] };
  for (let i = 0; i < body.length; i++) {
    const s = body[i]!;
    if (s.id !== "AK2") continue;
    const ak5 = body.slice(i + 1).find((x) => x.id === "AK5");
    res.transactions.push({ setId: el(s, 1), control: el(s, 2), accepted: ak5 ? el(ak5, 1) === "A" || el(ak5, 1) === "E" : false, error: ak5 && el(ak5, 1) === "R" ? el(ak5, 2) : undefined });
  }
  return res;
}
