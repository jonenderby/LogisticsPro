import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { As2Transport, IntegrationEngine, type As2PartnerSettings, as2 } from "../src/index.js";
import { invoice, profile } from "./fixtures.js";

const { buildAs2Message, receiveAs2, buildMdn, parseMdn, micMatches, generateAs2Identity, As2Error } = as2;

let platform: ReturnType<typeof generateAs2Identity>;
let carrier: ReturnType<typeof generateAs2Identity>;
const EDI = Buffer.from("ISA*00*          *00*          *ZZ*LOGISTICSPRO   *02*RLCA           *261005*1200*U*00401*000000001*0*T*>~\nGS*IM*X*Y*20261005*1200*1*X*004010~\nST*210*0001~\nSE*2*0001~\nGE*1*1~\nIEA*1*000000001~\n");

const settings = (id: ReturnType<typeof generateAs2Identity>, over: Partial<As2PartnerSettings> = {}): As2PartnerSettings => ({
  as2Id: id.as2Id,
  url: "https://as2.partner.example/as2",
  certificatePem: id.certificatePem,
  encryption: "aes256-CBC",
  signing: "sha256",
  mdn: "signed",
  ...over,
});
const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

beforeAll(() => {
  platform = generateAs2Identity("LOGISTICSPRO");
  carrier = generateAs2Identity("RLCARRIERS");
});

describe("AS2 messages", () => {
  for (const encryption of ["aes256-CBC", "des-EDE3-CBC", "none"] as const) {
    for (const signing of ["sha256", "sha1", "none"] as const) {
      it(`round-trips with encryption=${encryption} signing=${signing} and returns a matching MIC`, () => {
        const out = buildAs2Message(EDI, { contentType: "application/edi-x12", filename: "210.x12", us: platform, partner: settings(carrier, { encryption, signing }) });
        const got = receiveAs2(lower(out.headers), out.body, carrier, (from) => (from === "LOGISTICSPRO" ? settings(platform, { encryption, signing }) : undefined));
        expect(got.payload.equals(EDI)).toBe(true);
        expect(got).toMatchObject({ from: "LOGISTICSPRO", to: "RLCARRIERS", encrypted: encryption !== "none", signed: signing !== "none", filename: "210.x12" });
        expect(micMatches(got.mic, out.mic)).toBe(true);
        const mdn = buildMdn({ us: carrier, partnerAs2Id: "LOGISTICSPRO", originalMessageId: got.messageId, mic: got.mic, sign: true });
        const parsed = parseMdn(mdn.headers["Content-Type"]!, mdn.body, carrier.certificatePem);
        expect(parsed).toMatchObject({ signed: true, processed: true, originalMessageId: out.messageId });
        expect(micMatches(parsed.mic, out.mic)).toBe(true);
      });
    }
  }

  it("rejects tampered content, the wrong certificate, unknown partners and downgraded security", () => {
    const EDI_CRLF = Buffer.from(EDI.toString().replace(/\n/g, "\r\n"));
    const out = buildAs2Message(EDI_CRLF, { contentType: "application/edi-x12", filename: "x.x12", us: platform, partner: settings(carrier, { encryption: "none" }) });
    const tampered = Buffer.from(out.body.toString("latin1").replace("ST*210", "ST*211"), "latin1");
    const expectDisposition = (fn: () => unknown, d: string) => {
      try {
        fn();
        throw new Error("expected failure");
      } catch (e) {
        expect(e).toBeInstanceOf(As2Error);
        expect((e as InstanceType<typeof As2Error>).disposition).toBe(d);
      }
    };
    expectDisposition(() => receiveAs2(lower(out.headers), tampered, carrier, () => settings(platform, { encryption: "none" })), "integrity-check-failed");
    const impostor = generateAs2Identity("LOGISTICSPRO");
    expectDisposition(() => receiveAs2(lower(out.headers), out.body, carrier, () => settings(impostor, { encryption: "none" })), "integrity-check-failed");
    expectDisposition(() => receiveAs2(lower(out.headers), out.body, carrier, () => undefined), "authentication-failed");
    expectDisposition(() => receiveAs2(lower(out.headers), out.body, carrier, () => settings(platform)), "insufficient-message-security");
    const wrongTo = { ...lower(out.headers), "as2-to": "SOMEONEELSE" };
    expectDisposition(() => receiveAs2(wrongTo, out.body, carrier, () => settings(platform, { encryption: "none" })), "authentication-failed");
    const enc = buildAs2Message(EDI, { contentType: "application/edi-x12", filename: "x.x12", us: platform, partner: settings(impostor, { as2Id: "RLCARRIERS" }) });
    expectDisposition(() => receiveAs2(lower(enc.headers), enc.body, carrier, () => settings(platform)), "decryption-failed");
  });

  it("reports an error disposition in the MDN", () => {
    const mdn = buildMdn({ us: carrier, partnerAs2Id: "LOGISTICSPRO", originalMessageId: "<m1@x>", error: "decryption-failed", sign: false });
    expect(parseMdn(mdn.headers["Content-Type"]!, mdn.body)).toMatchObject({ processed: false, error: "decryption-failed", signed: false });
  });
});

describe("AS2 transport through the engine", () => {
  it("sends a 210 over AS2 and accepts only a signed MDN with the right MIC", async () => {
    let received: ReturnType<typeof receiveAs2> | undefined;
    const fakePartner = async (_url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
      received = receiveAs2(lower(init.headers), Buffer.from(init.body), carrier, () => settings(platform));
      const mdn = buildMdn({ us: carrier, partnerAs2Id: received.from, originalMessageId: received.messageId, mic: received.mic, sign: true });
      return { ok: true, status: 200, headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? mdn.headers["Content-Type"]! : null) }, arrayBuffer: async () => new Uint8Array(mdn.body).buffer };
    };
    const engine = new IntegrationEngine({ transports: { AS2: new As2Transport(() => platform, { fetch: fakePartner }) }, secrets: () => undefined });
    const p = profile("EDI_X12");
    p.channels.FREIGHT_INVOICE = { ...p.channels.FREIGHT_INVOICE!, transport: "AS2" };
    p.as2 = settings(carrier);
    const t = await engine.send("FREIGHT_INVOICE", invoice, p);
    expect(t.error).toBeUndefined();
    expect(t.status).toBe("SENT");
    expect(JSON.parse(t.response!.body!)).toMatchObject({ micMatched: true, signedReceipt: true });
    expect(received!.payload.toString()).toContain("ST*210*0001~");

    // A partner that answers with someone else's MIC is a failed delivery.
    const lying = async (_url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
      const r = receiveAs2(lower(init.headers), Buffer.from(init.body), carrier, () => settings(platform));
      const mdn = buildMdn({ us: carrier, partnerAs2Id: r.from, originalMessageId: r.messageId, mic: "AAAA, sha-256", sign: true });
      return { ok: true, status: 200, headers: { get: () => mdn.headers["Content-Type"]! }, arrayBuffer: async () => new Uint8Array(mdn.body).buffer };
    };
    const engine2 = new IntegrationEngine({ transports: { AS2: new As2Transport(() => platform, { fetch: lying }) }, secrets: () => undefined });
    const t2 = await engine2.send("FREIGHT_INVOICE", invoice, p);
    expect(t2.status).toBe("FAILED");
    expect(t2.error).toMatch(/MIC/);
  });
});

let hasOpenssl = true;
try {
  execFileSync("openssl", ["version"]);
} catch {
  hasOpenssl = false;
}

describe.skipIf(!hasOpenssl)("AS2 interoperability with OpenSSL", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-as2-"));
  const file = (n: string, data?: string | Buffer) => {
    const p = join(dir, n);
    if (data !== undefined) writeFileSync(p, data);
    return p;
  };

  it("OpenSSL decrypts and verifies what we send", () => {
    const out = buildAs2Message(EDI, { contentType: "application/edi-x12", filename: "210.x12", us: platform, partner: settings(carrier) });
    file("msg.der", out.body);
    file("carrier.key", carrier.privateKeyPem);
    file("carrier.crt", carrier.certificatePem);
    file("platform.crt", platform.certificatePem);
    execFileSync("openssl", ["cms", "-decrypt", "-inform", "DER", "-in", file("msg.der"), "-recip", file("carrier.crt"), "-inkey", file("carrier.key"), "-binary", "-out", file("signed.eml")]);
    execFileSync("openssl", ["smime", "-verify", "-in", file("signed.eml"), "-CAfile", file("platform.crt"), "-purpose", "any", "-binary", "-out", file("content.eml")], { stdio: "pipe" });
    const content = as2.readEntity(readFileSync(file("content.eml")));
    expect(content.headers["content-type"]).toBe("application/edi-x12");
    expect(as2.decodeBody(content).equals(EDI)).toBe(true);
  });

  it("we decrypt and verify what OpenSSL sends", () => {
    file("platform.key", platform.privateKeyPem);
    file("platform.crt", platform.certificatePem);
    file("carrier.key", carrier.privateKeyPem);
    file("carrier.crt", carrier.certificatePem);
    file("entity.eml", Buffer.concat([Buffer.from("Content-Type: application/edi-x12\r\nContent-Disposition: attachment; filename=\"214.x12\"\r\n\r\n"), EDI]));
    execFileSync("openssl", ["smime", "-sign", "-binary", "-md", "sha256", "-in", file("entity.eml"), "-signer", file("carrier.crt"), "-inkey", file("carrier.key"), "-out", file("osigned.eml")]);
    execFileSync("openssl", ["smime", "-encrypt", "-binary", "-aes256", "-outform", "DER", "-in", file("osigned.eml"), "-out", file("oenc.der"), file("platform.crt")]);
    const got = receiveAs2(
      { "as2-from": "RLCARRIERS", "as2-to": "LOGISTICSPRO", "message-id": "<openssl-1@rl>", "content-type": "application/pkcs7-mime; smime-type=enveloped-data", "disposition-notification-to": "x", "disposition-notification-options": "signed-receipt-protocol=optional, pkcs7-signature; signed-receipt-micalg=optional, sha-256" },
      readFileSync(file("oenc.der")),
      platform,
      () => settings(carrier),
    );
    expect(got.payload.equals(EDI)).toBe(true);
    expect(got).toMatchObject({ signed: true, encrypted: true, filename: "214.x12", mdn: "signed" });
  });
});
