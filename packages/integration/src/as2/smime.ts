import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import forge from "node-forge";
import { base64Lines, decodeBody, headerParam, mediaType, newBoundary, readEntity, splitMultipart, writeEntity, writeMultipart } from "./mime.js";

export type DigestAlg = "sha256" | "sha384" | "sha512" | "sha1";
export type CipherAlg = "aes256-CBC" | "aes192-CBC" | "aes128-CBC" | "des-EDE3-CBC";

const MICALG: Record<DigestAlg, string> = { sha1: "sha1", sha256: "sha-256", sha384: "sha-384", sha512: "sha-512" };
const DIGEST_BY_OID: Record<string, DigestAlg> = {
  "1.3.14.3.2.26": "sha1",
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512",
};
const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";

const bin = (b: Buffer) => b.toString("binary");
const buf = (s: string) => Buffer.from(s, "binary");

export function micalgName(d: DigestAlg): string {
  return MICALG[d];
}

export function digestFromMicalg(name: string | undefined): DigestAlg {
  const n = (name ?? "sha-256").toLowerCase().replace(/["\s]/g, "");
  const hit = (Object.entries(MICALG) as Array<[DigestAlg, string]>).find(([, v]) => v === n || v.replace("-", "") === n);
  return hit ? hit[0] : "sha256";
}

/** Message integrity check: base64 digest of exactly the bytes that were signed (or sent). */
export function computeMic(content: Buffer, d: DigestAlg): string {
  return `${createHash(d).update(content).digest("base64")}, ${MICALG[d]}`;
}

/**
 * Produce a multipart/signed entity (RFC 1847 / S/MIME) whose first part is
 * `entity` and second part a detached PKCS#7 signature over it.
 */
export function signEntity(entity: Buffer, keyPem: string, certPem: string, digest: DigestAlg = "sha256"): { contentType: string; body: Buffer } {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(bin(entity));
  const cert = forge.pki.certificateFromPem(certPem);
  p7.addCertificate(cert);
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(keyPem),
    certificate: cert,
    digestAlgorithm: forge.pki.oids[digest]!,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType!, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest! },
      { type: forge.pki.oids.signingTime!, value: new Date() as unknown as string },
    ],
  });
  p7.sign({ detached: true });
  const der = buf(forge.asn1.toDer(p7.toAsn1()).getBytes());
  const sigPart = writeEntity(
    [
      ["Content-Type", 'application/pkcs7-signature; name="smime.p7s"'],
      ["Content-Transfer-Encoding", "base64"],
      ["Content-Disposition", 'attachment; filename="smime.p7s"'],
    ],
    base64Lines(der),
  );
  const boundary = newBoundary();
  return {
    contentType: `multipart/signed; protocol="application/pkcs7-signature"; micalg=${MICALG[digest]}; boundary="${boundary}"`,
    body: writeMultipart([entity, sigPart], boundary),
  };
}

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureError";
  }
}

/**
 * Verify a detached PKCS#7 signature against the partner's certificate.
 * Certificates embedded in the message are ignored: only the certificate the
 * business configured for this partner is trusted.
 */
export function verifyDetached(content: Buffer, signatureDer: Buffer, partnerCertPem: string): { digest: DigestAlg } {
  const asn1 = forge.asn1;
  const ci = asn1.fromDer(bin(signatureDer));
  const ciVal = ci.value as forge.asn1.Asn1[];
  if (asn1.derToOid(ciVal[0]!.value as string) !== forge.pki.oids.signedData) throw new SignatureError("not a PKCS#7 signedData");
  const sd = ((ciVal[1]!.value as forge.asn1.Asn1[])[0]!.value as forge.asn1.Asn1[]);
  const signerInfos = sd[sd.length - 1]!.value as forge.asn1.Asn1[];
  const si = signerInfos[0]?.value as forge.asn1.Asn1[] | undefined;
  if (!si) throw new SignatureError("no signer");
  let i = 2;
  const digestOid = asn1.derToOid((si[i++]!.value as forge.asn1.Asn1[])[0]!.value as string);
  const digest = DIGEST_BY_OID[digestOid];
  if (!digest) throw new SignatureError(`unsupported digest ${digestOid}`);
  let signedAttrs: forge.asn1.Asn1 | undefined;
  if (si[i]!.tagClass === asn1.Class.CONTEXT_SPECIFIC && si[i]!.type === 0) signedAttrs = si[i++];
  const sigAlgOid = asn1.derToOid((si[i++]!.value as forge.asn1.Asn1[])[0]!.value as string);
  if (sigAlgOid === "1.2.840.113549.1.1.10") throw new SignatureError("RSASSA-PSS signatures are not supported");
  const signature = buf(si[i]!.value as string);
  const contentDigest = createHash(digest).update(content).digest();

  let signedBytes: Buffer;
  if (signedAttrs) {
    const attrs = signedAttrs.value as forge.asn1.Asn1[];
    const md = attrs.find((a) => asn1.derToOid((a.value as forge.asn1.Asn1[])[0]!.value as string) === OID_MESSAGE_DIGEST);
    if (!md) throw new SignatureError("signature has no message digest attribute");
    const mdValue = buf((((md.value as forge.asn1.Asn1[])[1]!.value as forge.asn1.Asn1[])[0]!.value) as string);
    if (!mdValue.equals(contentDigest)) throw new SignatureError("content does not match the signature (message digest differs)");
    // The signature covers the DER of the attributes encoded as a SET, not as [0].
    const set = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, attrs);
    signedBytes = buf(asn1.toDer(set).getBytes());
  } else {
    signedBytes = content;
  }
  const key = createPublicKey(forge.pki.publicKeyToPem(forge.pki.certificateFromPem(partnerCertPem).publicKey));
  if (!cryptoVerify(digest, signedBytes, key, signature)) throw new SignatureError("signature does not verify with the partner's certificate");
  return { digest };
}

/** Verify a multipart/signed entity; returns the signed inner entity bytes. */
export function verifySignedEntity(contentType: string, body: Buffer, partnerCertPem: string): { content: Buffer; digest: DigestAlg } {
  const boundary = headerParam(contentType, "boundary");
  if (!boundary) throw new SignatureError("multipart/signed without boundary");
  const [content, sigPart] = splitMultipart(body, boundary);
  if (!content || !sigPart) throw new SignatureError("multipart/signed needs two parts");
  const sig = readEntity(sigPart);
  if (!/pkcs7-signature/i.test(sig.headers["content-type"] ?? "")) throw new SignatureError("second part is not a PKCS#7 signature");
  const { digest } = verifyDetached(content, decodeBody(sig), partnerCertPem);
  return { content, digest };
}

/** Encrypt an entity for the partner (PKCS#7 envelopedData, RSA key transport). */
export function encryptEntity(entity: Buffer, partnerCertPem: string, cipher: CipherAlg = "aes256-CBC"): { contentType: string; body: Buffer } {
  const p7 = forge.pkcs7.createEnvelopedData();
  p7.addRecipient(forge.pki.certificateFromPem(partnerCertPem));
  p7.content = forge.util.createBuffer(bin(entity));
  p7.encrypt(undefined, forge.pki.oids[cipher]);
  return {
    contentType: 'application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"',
    body: buf(forge.asn1.toDer(p7.toAsn1()).getBytes()),
  };
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

/** Decrypt envelopedData addressed to our certificate. Accepts DER or base64 bodies. */
export function decryptEntity(body: Buffer, keyPem: string, certPem: string): Buffer {
  const der = body[0] === 0x30 ? body : Buffer.from(body.toString("latin1").replace(/\s+/g, ""), "base64");
  try {
    const msg = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(bin(der))) as forge.pkcs7.PkcsEnvelopedData & {
      findRecipient(cert: forge.pki.Certificate): unknown;
      decrypt(recipient: unknown, key: forge.pki.PrivateKey): void;
      content: forge.util.ByteStringBuffer;
    };
    const recipient = msg.findRecipient(forge.pki.certificateFromPem(certPem));
    if (!recipient) throw new Error("message is not encrypted for our certificate");
    msg.decrypt(recipient, forge.pki.privateKeyFromPem(keyPem));
    return buf(msg.content.getBytes());
  } catch (e) {
    throw new DecryptionError((e as Error).message);
  }
}

export { mediaType };
