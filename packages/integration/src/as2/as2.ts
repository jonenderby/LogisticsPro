import { generateKeyPairSync, randomUUID } from "node:crypto";
import forge from "node-forge";
import { z } from "zod";
import { base64Lines, headerParam, mediaType, newBoundary, readEntity, splitMultipart, writeEntity, writeMultipart } from "./mime.js";
import { type CipherAlg, type DigestAlg, computeMic, decryptEntity, digestFromMicalg, encryptEntity, micalgName, signEntity, verifySignedEntity } from "./smime.js";

/** Our side of AS2: one central station for the whole platform. */
export interface As2Identity {
  as2Id: string;
  privateKeyPem: string;
  certificatePem: string;
}

/** A partner's AS2 details, configured once per partner by the business. */
export const As2PartnerSettings = z.object({
  as2Id: z.string().min(1).max(128),
  url: z.string().url(),
  certificatePem: z.string().includes("BEGIN CERTIFICATE"),
  encryption: z.enum(["aes256-CBC", "aes192-CBC", "aes128-CBC", "des-EDE3-CBC", "none"]).default("aes256-CBC"),
  signing: z.enum(["sha256", "sha384", "sha512", "sha1", "none"]).default("sha256"),
  mdn: z.enum(["signed", "unsigned", "none"]).default("signed"),
});
export type As2PartnerSettings = z.infer<typeof As2PartnerSettings>;

export interface OutgoingAs2 {
  messageId: string;
  headers: Record<string, string>;
  body: Buffer;
  /** MIC we expect back in the MDN. */
  mic: string;
}

const quoteId = (id: string) => (/[\s"]/.test(id) ? `"${id.replace(/"/g, '\\"')}"` : id);
const unquoteId = (id: string | undefined) => (id ?? "").trim().replace(/^"(.*)"$/, "$1");

/**
 * Build an AS2 (RFC 4130) message: payload -> optional signature ->
 * optional encryption. The outermost MIME headers become HTTP headers.
 */
export function buildAs2Message(payload: Buffer, opts: { contentType: string; filename: string; us: As2Identity; partner: As2PartnerSettings; subject?: string; receiptUrl?: string }): OutgoingAs2 {
  const p = opts.partner;
  // Signed MIME content must be in canonical form (CRLF line endings), and
  // strict gateways such as OpenSSL normalize bare LFs, which would break the
  // signature. Payloads that are not canonical travel base64-encoded instead.
  const canonical = !/(^|[^\r])\n/.test(payload.toString("latin1"));
  const binary = canonical || p.signing === "none";
  let entity = writeEntity(
    [
      ["Content-Type", opts.contentType],
      ["Content-Transfer-Encoding", binary ? "binary" : "base64"],
      ["Content-Disposition", `attachment; filename="${opts.filename}"`],
    ],
    binary ? payload : base64Lines(payload),
  );
  const digest: DigestAlg = p.signing === "none" ? "sha256" : p.signing;
  // RFC 4130 7.3.1: signed or encrypted messages -> MIC over the MIME headers and
  // content; plain messages -> MIC over the content only.
  const mic = computeMic(p.signing === "none" && p.encryption === "none" ? payload : entity, digest);
  let contentType = opts.contentType;
  let body = payload;
  if (p.signing !== "none") {
    const signed = signEntity(entity, opts.us.privateKeyPem, opts.us.certificatePem, p.signing);
    contentType = signed.contentType;
    body = signed.body;
    entity = writeEntity([["Content-Type", signed.contentType]], signed.body);
  } else {
    body = entity.subarray(entity.indexOf("\r\n\r\n") + 4);
  }
  if (p.encryption !== "none") {
    const enc = encryptEntity(entity, p.certificatePem, p.encryption as CipherAlg);
    contentType = enc.contentType;
    body = enc.body;
  }
  const messageId = `<${randomUUID()}@${opts.us.as2Id.replace(/[^A-Za-z0-9.-]/g, "")}>`;
  const headers: Record<string, string> = {
    "AS2-Version": "1.2",
    "AS2-From": quoteId(opts.us.as2Id),
    "AS2-To": quoteId(p.as2Id),
    "Message-ID": messageId,
    Subject: opts.subject ?? "EDI from Logistics Pro",
    Date: new Date().toUTCString(),
    "MIME-Version": "1.0",
    "Content-Type": contentType,
    "Content-Transfer-Encoding": "binary",
  };
  if (p.signing === "none" && p.encryption === "none") headers["Content-Disposition"] = `attachment; filename="${opts.filename}"`;
  if (p.mdn !== "none") {
    headers["Disposition-Notification-To"] = opts.receiptUrl ?? "mdn@logisticspro";
    if (p.mdn === "signed") headers["Disposition-Notification-Options"] = `signed-receipt-protocol=optional, pkcs7-signature; signed-receipt-micalg=optional, ${micalgName(digest)}`;
  }
  return { messageId, headers, body, mic };
}

export interface ReceivedAs2 {
  from: string;
  to: string;
  messageId: string;
  payload: Buffer;
  payloadContentType: string;
  filename?: string;
  encrypted: boolean;
  signed: boolean;
  mic: string;
  mdn: "signed" | "unsigned" | "none";
  micDigest: DigestAlg;
}

export class As2Error extends Error {
  /** RFC 4130 disposition modifier, e.g. "decryption-failed". */
  constructor(
    public readonly disposition: string,
    message: string,
  ) {
    super(message);
    this.name = "As2Error";
  }
}

/**
 * Unwrap an incoming AS2 message. `partner` is looked up by AS2-From; its
 * settings decide whether encryption and a signature are required.
 */
export function receiveAs2(headersIn: Record<string, string | string[] | undefined>, body: Buffer, us: As2Identity, findPartner: (as2From: string) => As2PartnerSettings | undefined): ReceivedAs2 {
  const h = (n: string) => {
    const v = headersIn[n.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const from = unquoteId(h("as2-from"));
  const to = unquoteId(h("as2-to"));
  const messageId = (h("message-id") ?? "").trim();
  if (!from || !to || !messageId) throw new As2Error("unexpected-processing-error", "Missing AS2-From, AS2-To or Message-ID");
  if (to.toLowerCase() !== us.as2Id.toLowerCase()) throw new As2Error("authentication-failed", `AS2-To ${to} is not this station`);
  const partner = findPartner(from);
  if (!partner) throw new As2Error("authentication-failed", `Unknown AS2 partner ${from}`);

  const opts = h("disposition-notification-options") ?? "";
  const mdn: ReceivedAs2["mdn"] = !h("disposition-notification-to") ? "none" : /pkcs7-signature/i.test(opts) ? "signed" : "unsigned";
  const micDigest = digestFromMicalg(opts.match(/signed-receipt-micalg\s*=\s*[^,]+,\s*([^;\s]+)/i)?.[1]);

  let contentType = h("content-type") ?? "";
  let entityBody = body;
  let encrypted = false;
  let decrypted: Buffer | undefined;
  if (mediaType(contentType) === "application/pkcs7-mime" || mediaType(contentType) === "application/x-pkcs7-mime") {
    encrypted = true;
    let inner: Buffer;
    try {
      inner = decryptEntity(body, us.privateKeyPem, us.certificatePem);
    } catch (e) {
      throw new As2Error("decryption-failed", (e as Error).message);
    }
    decrypted = inner;
    const ent = readEntity(inner);
    contentType = ent.headers["content-type"] ?? "application/octet-stream";
    entityBody = ent.body;
  } else if (partner.encryption !== "none") {
    throw new As2Error("insufficient-message-security", "Partner is set up to encrypt but sent plain text");
  }

  let signed = false;
  let payloadEntity: Buffer;
  if (mediaType(contentType) === "multipart/signed") {
    signed = true;
    try {
      payloadEntity = verifySignedEntity(contentType, entityBody, partner.certificatePem).content;
    } catch (e) {
      throw new As2Error("integrity-check-failed", (e as Error).message);
    }
  } else {
    if (partner.signing !== "none") throw new As2Error("insufficient-message-security", "Partner is set up to sign but sent an unsigned message");
    const disposition = h("content-disposition");
    payloadEntity = decrypted ?? writeEntity([["Content-Type", contentType], ...(disposition ? ([["Content-Disposition", disposition]] as Array<[string, string]>) : [])], entityBody);
  }
  const ent = readEntity(payloadEntity);
  const cte = (ent.headers["content-transfer-encoding"] ?? "binary").toLowerCase();
  const payload = cte === "base64" ? Buffer.from(ent.body.toString("latin1").replace(/\s+/g, ""), "base64") : ent.body;
  return {
    from,
    to,
    messageId,
    payload,
    payloadContentType: ent.headers["content-type"] ?? contentType,
    filename: headerParam(ent.headers["content-disposition"], "filename"),
    encrypted,
    signed,
    // RFC 4130 7.3.1: the MIC covers what was signed; else the decrypted entity; else the raw content.
    mic: computeMic(signed ? payloadEntity : decrypted ?? entityBody, micDigest),
    mdn,
    micDigest,
  };
}

/** Build the synchronous MDN (receipt) returned in the HTTP response. */
export function buildMdn(opts: { us: As2Identity; partnerAs2Id: string; originalMessageId: string; mic?: string; error?: string; sign: boolean; text?: string }): { headers: Record<string, string>; body: Buffer } {
  const disposition = `automatic-action/MDN-sent-automatically; ${opts.error ? `processed/error: ${opts.error}` : "processed"}`;
  const human = writeEntity(
    [["Content-Type", "text/plain; charset=us-ascii"]],
    Buffer.from(`${opts.text ?? (opts.error ? `The message ${opts.originalMessageId} could not be processed: ${opts.error}.` : `The message ${opts.originalMessageId} was received and processed.`)}\r\n`, "latin1"),
  );
  const fields = [
    "Reporting-UA: Logistics Pro AS2",
    `Original-Recipient: rfc822; ${opts.us.as2Id}`,
    `Final-Recipient: rfc822; ${opts.us.as2Id}`,
    `Original-Message-ID: ${opts.originalMessageId}`,
    `Disposition: ${disposition}`,
    ...(opts.mic && !opts.error ? [`Received-Content-MIC: ${opts.mic}`] : []),
  ];
  const machine = writeEntity([["Content-Type", "message/disposition-notification"]], Buffer.from(`${fields.join("\r\n")}\r\n`, "latin1"));
  const boundary = newBoundary();
  const reportType = `multipart/report; report-type=disposition-notification; boundary="${boundary}"`;
  const report = writeMultipart([human, machine], boundary);
  let contentType = reportType;
  let body = report;
  if (opts.sign) {
    const signed = signEntity(writeEntity([["Content-Type", reportType]], report), opts.us.privateKeyPem, opts.us.certificatePem);
    contentType = signed.contentType;
    body = signed.body;
  }
  return {
    headers: {
      "AS2-Version": "1.2",
      "AS2-From": quoteId(opts.us.as2Id),
      "AS2-To": quoteId(opts.partnerAs2Id),
      "Message-ID": `<${randomUUID()}@${opts.us.as2Id.replace(/[^A-Za-z0-9.-]/g, "")}>`,
      "MIME-Version": "1.0",
      "Content-Type": contentType,
    },
    body,
  };
}

export interface ParsedMdn {
  signed: boolean;
  originalMessageId?: string;
  disposition?: string;
  mic?: string;
  processed: boolean;
  error?: string;
}

/** Read an MDN returned by a partner; verifies its signature when we asked for a signed one. */
export function parseMdn(contentType: string, body: Buffer, partnerCertPem?: string): ParsedMdn {
  let ct = contentType;
  let b = body;
  let signed = false;
  if (mediaType(ct) === "multipart/signed") {
    if (!partnerCertPem) throw new As2Error("authentication-failed", "Signed MDN but no partner certificate");
    const { content } = verifySignedEntity(ct, b, partnerCertPem);
    const inner = readEntity(content);
    ct = inner.headers["content-type"] ?? "";
    b = inner.body;
    signed = true;
  }
  if (mediaType(ct) !== "multipart/report") throw new As2Error("unexpected-processing-error", `MDN content type ${mediaType(ct)} is not multipart/report`);
  const parts = splitMultipart(b, headerParam(ct, "boundary") ?? "");
  const dn = parts.map(readEntity).find((p) => /disposition-notification/i.test(p.headers["content-type"] ?? ""));
  if (!dn) throw new As2Error("unexpected-processing-error", "MDN has no disposition-notification part");
  const fields: Record<string, string> = {};
  for (const line of dn.body.toString("latin1").replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const c = line.indexOf(":");
    if (c > 0) fields[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  }
  const disposition = fields.disposition;
  const error = disposition?.match(/processed\/(?:error|failure):\s*(.+)$/i)?.[1];
  return { signed, originalMessageId: fields["original-message-id"], disposition, mic: fields["received-content-mic"], processed: !!disposition && /;\s*processed/i.test(disposition) && !error, error };
}

/** MICs match when digest bytes and algorithm agree (spacing differs between gateways). */
export function micMatches(a: string | undefined, b: string | undefined): boolean {
  const norm = (m?: string) => (m ?? "").replace(/\s+/g, "").toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}

/** Create a self-signed station certificate (development; use a CA-issued or long-lived cert in production). */
export function generateAs2Identity(as2Id: string, years = 3): As2Identity {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = `01${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + years * 365 * 86_400_000);
  const attrs = [{ name: "commonName", value: as2Id }, { name: "organizationName", value: "Logistics Pro" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: "basicConstraints", cA: false }, { name: "keyUsage", digitalSignature: true, keyEncipherment: true }]);
  const key = forge.pki.privateKeyFromPem(privateKey);
  cert.sign(key, forge.md.sha256.create());
  return { as2Id, privateKeyPem: forge.pki.privateKeyToPem(key), certificatePem: forge.pki.certificateToPem(cert) };
}

export function certificateFingerprint(pem: string): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(pem))).getBytes();
  const md = forge.md.sha256.create();
  md.update(der);
  return md.digest().toHex().toUpperCase().match(/.{2}/g)!.join(":");
}
