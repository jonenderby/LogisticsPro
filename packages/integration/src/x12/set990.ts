import type { TenderResponse } from "../transactions.js";
import { Cursor, type Segment, X12ParseError, el, fromX12Date, seg, x12Date } from "./core.js";

/** 990 Response to a Load Tender: B1 (A accept / D decline), N9*CN carrier PRO, K1 reason. */
export function encode990(r: TenderResponse): Segment[] {
  const out = [seg("B1", r.carrierScac, r.shipmentId, x12Date(r.respondedOn), r.decision === "ACCEPT" ? "A" : "D")];
  if (r.carrierReference) out.push(seg("N9", "CN", r.carrierReference));
  if (r.declineReason) out.push(seg("K1", r.declineReason));
  return out;
}

export function decode990(body: Segment[]): TenderResponse {
  const c = new Cursor(body);
  const b1 = c.require("B1");
  const action = el(b1, 4);
  if (action !== "A" && action !== "D") throw new X12ParseError(`B104 must be A or D, got ${action}`);
  const r: TenderResponse = { carrierScac: el(b1, 1), shipmentId: el(b1, 2), respondedOn: fromX12Date(el(b1, 3)), decision: action === "A" ? "ACCEPT" : "DECLINE" };
  const n9 = c.take("N9");
  if (n9) r.carrierReference = el(n9, 2);
  const k1 = c.take("K1");
  if (k1) r.declineReason = el(k1, 1);
  return r;
}
