/** Minimal MIME helpers for AS2 (RFC 2045/1847/3462). Everything is bytes; line endings are CRLF. */

export interface MimeEntity {
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: Buffer;
}

const CRLF = "\r\n";

export function headerParam(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  const m = value.match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, "i"));
  return m ? (m[2] ?? m[1]) : undefined;
}

export function mediaType(value: string | undefined): string {
  return (value ?? "").split(";")[0]!.trim().toLowerCase();
}

/** Serialize headers + body exactly as they will be signed or encrypted. */
export function writeEntity(headers: Array<[string, string]>, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(headers.map(([k, v]) => `${k}: ${v}`).join(CRLF) + CRLF + CRLF, "latin1"), body]);
}

/** Parse a MIME entity: headers up to the first blank line, then the body. Accepts CRLF or LF. */
export function readEntity(buf: Buffer): MimeEntity {
  let idx = buf.indexOf("\r\n\r\n");
  let sep = 4;
  const lf = buf.indexOf("\n\n");
  if (idx < 0 || (lf >= 0 && lf < idx)) {
    idx = lf;
    sep = 2;
  }
  if (idx < 0) throw new Error("MIME entity has no header/body separator");
  const headerText = buf.subarray(0, idx).toString("latin1").replace(/\r?\n[ \t]+/g, " ");
  const headers: Record<string, string> = {};
  for (const line of headerText.split(/\r?\n/)) {
    const c = line.indexOf(":");
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  }
  return { headers, body: buf.subarray(idx + sep) };
}

/**
 * Split a multipart body into its raw parts. Each part is returned exactly as
 * it appeared on the wire (headers included), which is what multipart/signed
 * verification needs.
 */
export function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const delim = Buffer.from(`--${boundary}`, "latin1");
  const parts: Buffer[] = [];
  let pos = body.indexOf(delim);
  if (pos < 0) throw new Error("multipart boundary not found");
  while (pos >= 0) {
    let start = pos + delim.length;
    if (body.subarray(start, start + 2).toString("latin1") === "--") break; // closing delimiter
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    else if (body[start] === 0x0a) start += 1;
    const next = body.indexOf(delim, start);
    if (next < 0) throw new Error("unterminated multipart body");
    // The CRLF before the next delimiter belongs to the delimiter, not the part.
    let end = next;
    if (body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2;
    else if (body[end - 1] === 0x0a) end -= 1;
    parts.push(body.subarray(start, end));
    pos = next;
  }
  return parts;
}

export function writeMultipart(parts: Buffer[], boundary: string): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) chunks.push(Buffer.from(`--${boundary}${CRLF}`, "latin1"), p, Buffer.from(CRLF, "latin1"));
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, "latin1"));
  return Buffer.concat(chunks);
}

export function newBoundary(): string {
  return `----=_LP_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/** Base64 bodies from other gateways may be wrapped; decode leniently. */
export function decodeBody(entity: MimeEntity): Buffer {
  const cte = (entity.headers["content-transfer-encoding"] ?? "binary").toLowerCase();
  return cte === "base64" ? Buffer.from(entity.body.toString("latin1").replace(/\s+/g, ""), "base64") : entity.body;
}

export function base64Lines(buf: Buffer): Buffer {
  return Buffer.from((buf.toString("base64").match(/.{1,76}/g) ?? []).join(CRLF) + CRLF, "latin1");
}
