import { describe, expect, it } from "vitest";
import { IntegrationEngine, MemoryTransport, ValidationError, fieldPaths, type TransactionType } from "../src/index.js";
import { invoice, profile, remittance, status, tender, tenderResponse } from "./fixtures.js";

const engine = new IntegrationEngine({ transports: { HTTPS: new MemoryTransport(), VAN: new MemoryTransport() }, secrets: () => "secret", now: () => new Date("2026-10-05T12:00:00Z") });

const docs: Array<[TransactionType, unknown]> = [
  ["LOAD_TENDER", tender],
  ["TENDER_RESPONSE", tenderResponse],
  ["SHIPMENT_STATUS", status],
  ["FREIGHT_INVOICE", invoice],
  ["PAYMENT_ADVICE", remittance],
];

function parse(tx: TransactionType, method: "API_JSON" | "API_XML" | "EDI_X12", body: string) {
  if (method === "EDI_X12") {
    const res = engine.parseEdi(body);
    expect(res.errors).toEqual([]);
    expect(res.documents).toHaveLength(1);
    expect(res.documents[0]!.transaction).toBe(tx);
    return res.documents[0]!.doc;
  }
  return engine.parseApi(tx, method, body);
}

describe("every transaction carries identical data in every method", () => {
  for (const [tx, doc] of docs) {
    for (const method of ["API_JSON", "API_XML", "EDI_X12"] as const) {
      it(`${tx} survives a ${method} round trip`, () => {
        const rendered = engine.render(tx, doc, profile(method));
        expect(rendered.method).toBe(method);
        expect(parse(tx, method, rendered.body)).toEqual(doc);
      });
    }
  }

  it("minimal documents (required fields only) also round-trip", () => {
    const minimal = { ...tenderResponse, decision: "ACCEPT" as const };
    delete (minimal as Partial<typeof minimal>).carrierReference;
    delete (minimal as Partial<typeof minimal>).declineReason;
    for (const method of ["API_JSON", "API_XML", "EDI_X12"] as const) {
      expect(parse("TENDER_RESPONSE", method, engine.render("TENDER_RESPONSE", minimal, profile(method)).body)).toEqual(minimal);
    }
  });
});

describe("required fields are enforced the same way for every method", () => {
  it("lists the same required fields regardless of method", () => {
    const req = fieldPaths("FREIGHT_INVOICE").required;
    expect(req).toContain("invoiceNumber");
    expect(req).toContain("lines[].amount");
    expect(req).toContain("billTo.postalCode");
    expect(fieldPaths("LOAD_TENDER").optional).toContain("items[].hazmat.unNumber");
  });

  for (const method of ["API_JSON", "API_XML", "EDI_X12"] as const) {
    it(`${method} rejects an invoice missing a required field`, () => {
      const bad = { ...invoice, billTo: { ...invoice.billTo, postalCode: undefined } };
      expect(() => engine.render("FREIGHT_INVOICE", bad, profile(method))).toThrow(ValidationError);
    });
  }
});

describe("X12 envelope", () => {
  it("produces a well-formed interchange with matching counts and controls", () => {
    const { body, control } = engine.render("SHIPMENT_STATUS", status, profile("EDI_X12"));
    const isa = body.split("\n")[0]!;
    expect(isa).toHaveLength(106);
    expect(isa.startsWith("ISA*00*          *00*          *ZZ*LOGISTICSPRO   *02*EXLA           *261005*1200*U*00401*")).toBe(true);
    expect(body).toContain("GS*QM*LOGISTICSPRO*EXLA*20261005*1200*");
    expect(body).toContain("AT7*SD*AO***20261007*0315*UT~");
    expect(body).toContain("MS1*Nashville*TN*US*0864500*360900*W*N~");
    const segs = body.split("~").map((s) => s.trim()).filter(Boolean);
    const st = segs.findIndex((s) => s.startsWith("ST*"));
    const se = segs.findIndex((s) => s.startsWith("SE*"));
    expect(segs[se]).toBe(`SE*${se - st + 1}*0001`);
    expect(control?.interchange).toBeGreaterThan(0);
  });

  it("rejects a set whose SE count is wrong", () => {
    const { body } = engine.render("TENDER_RESPONSE", tenderResponse, profile("EDI_X12"));
    expect(() => engine.parseEdi(body.replace(/SE\*\d+\*/, "SE*99*"))).toThrow(/SE count/);
  });

  it("acknowledges inbound sets with a 997 and rejects bad ones individually", () => {
    const { body } = engine.render("SHIPMENT_STATUS", status, profile("EDI_X12"));
    const ok = engine.parseEdi(body);
    expect(ok.ack997).toContain("AK1*QM*");
    expect(ok.ack997).toContain("AK5*A~");
    expect(ok.ack997).toContain("AK9*A*1*1*1~");
    // ack goes back to the sender
    expect(ok.ack997!.slice(0, 106)).toContain("*02*EXLA           *ZZ*LOGISTICSPRO   *");

    const broken = engine.parseEdi(body.replace("AT7*SD*", "AT7*ZZ*"));
    expect(broken.documents).toHaveLength(0);
    expect(broken.errors[0]!.message).toMatch(/unknown status code/);
    expect(broken.ack997).toContain("AK5*R*5~");
    expect(broken.ack997).toContain("AK9*R*1*1*0~");

    // and our parser reads its own 997 back
    const ack = engine.parseEdi(ok.ack997!);
    expect(ack.acks[0]!.accepted).toBe(true);
    expect(ack.ack997).toBeUndefined();
  });

  it("applies partner code overrides", () => {
    const p = profile("EDI_X12");
    p.edi!.codeOverrides = { equipment: { FLATBED: "FB" } };
    const { body } = engine.render("LOAD_TENDER", tender, p);
    expect(body).toMatch(/N7\*\*NONE\*{9}FB\*{4}4800~/);
    expect(engine.parseEdi(body, { equipment: { FLATBED: "FB" } }).documents[0]!.doc).toEqual(tender);
  });

  it("strips delimiter characters out of data", () => {
    const sneaky = { ...tender, notes: "Use dock 4~ISA*bad" };
    const { body } = engine.render("LOAD_TENDER", sneaky, profile("EDI_X12"));
    expect(body).toContain("NTE*GEN*Use dock 4 ISA bad~");
  });
});

describe("820 remittance from a payer's system", () => {
  it("reads payments, addresses and short pays as payers send them", () => {
    const edi = [
      "ISA*00*          *00*          *ZZ*ACMEFOODS      *ZZ*LOGISTICSPRO   *261008*0900*U*00401*000000077*0*P*>",
      "GS*RA*ACMEFOODS*LOGISTICSPRO*20261008*0900*77*X*004010",
      "ST*820*0001",
      "BPR*C*6950.5*C*ACH*CCP*01*021000021*DA*123456*1123456789**01*121000248*DA*987654*20261008",
      "TRN*1*021000020000123*1123456789",
      "CUR*PR*USD",
      "REF*VV*0001",
      "N1*PR*Acme Foods",
      "N3*1 Main St",
      "N4*Memphis*TN*38103",
      "N1*PE*Estes Express Lines*ZZ*EXLA",
      "ENT*1",
      "RMR*IV*INV-1001*PI*5200*5200",
      "DTM*003*20261001",
      "ENT*2",
      "RMR*IV*INV-1002*PI*1750.50*1800.00*-49.50",
      "SE*15*0001",
      "GE*1*77",
      "IEA*1*000000077",
    ].join("~") + "~";
    const res = engine.parseEdi(edi);
    expect(res.errors).toEqual([]);
    expect(res.documents[0]).toMatchObject({ transaction: "PAYMENT_ADVICE", doc: remittance });
    expect(res.ack997).toContain("AK1*RA*77");
  });
});
