import { createHash } from "node:crypto";
import { DocumentKind, type Load, type LoadDocument, newId } from "@logisticspro/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, getLoad, hasOrgCap, isDriverOn, me, parse, postMessage, saveLoad } from "../http.js";
import { signFileUrl, sniff, verifyFileSig } from "../services/files.js";

const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Documents with a link that works for an hour without the session token (image tags, new tabs). */
export function documentViews(ctx: AppContext, docs: LoadDocument[]): Array<LoadDocument & { viewUrl: string }> {
  return docs.map((d) => ({ ...d, viewUrl: d.fileId ? signFileUrl(ctx.cfg.jwtSecret, d.fileId, ctx.now()) : d.url }));
}

const Point = z.tuple([z.number().finite(), z.number().finite()]);
const Pod = z.object({
  stopId: z.string().optional(),
  receiverName: z.string().trim().min(2).max(80),
  width: z.number().positive().max(4000),
  height: z.number().positive().max(4000),
  strokes: z.array(z.array(Point).min(1).max(4000)).min(1).max(300),
  piecesReceived: z.number().int().nonnegative().optional(),
  exceptions: z.string().trim().max(300).optional(),
  geo: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
});

/**
 * The delivery receipt as an SVG drawn on the server from the signature's
 * strokes, so nothing the phone sends is ever rendered as markup.
 */
export function receiptSvg(load: Load, stop: Load["stops"][number] | undefined, pod: z.infer<typeof Pod>, at: string): string {
  const W = 640;
  const box = { x: 24, y: 190, w: 592, h: 170 };
  const scale = Math.min(box.w / pod.width, box.h / pod.height);
  const path = pod.strokes
    .map((s) => s.map(([x, y], i) => `${i ? "L" : "M"}${(box.x + Math.min(Math.max(x, 0), pod.width) * scale).toFixed(1)} ${(box.y + Math.min(Math.max(y, 0), pod.height) * scale).toFixed(1)}`).join(" "))
    .join(" ");
  const pieces = load.items.reduce((s, i) => s + i.pieces, 0);
  const when = new Date(at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
  const lines = [
    [`Delivery receipt · ${load.loadNumber}`, 22, 700],
    [`${stop ? `${stop.address.name}, ${stop.address.city}, ${stop.address.state}` : "Delivery"}${load.references.bol ? ` · BOL ${load.references.bol}` : ""}${load.references.po.length ? ` · PO ${load.references.po.join(", ")}` : ""}`, 15, 400],
    [`Received by ${pod.receiverName} · ${when}`, 15, 400],
    [`Pieces received: ${pod.piecesReceived ?? pieces} of ${pieces}${pod.exceptions ? ` · Exceptions: ${pod.exceptions}` : " · No exceptions noted"}`, 15, 400],
  ] as const;
  const text = lines.map(([t, size, weight], i) => `<text x="24" y="${40 + i * 30}" font-size="${size}" font-weight="${weight}">${esc(t)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="420" viewBox="0 0 ${W} 420" font-family="Helvetica, Arial, sans-serif" fill="#111"><rect width="${W}" height="420" fill="#fff"/>${text}<rect x="${box.x}" y="${box.y - 10}" width="${box.w}" height="${box.h + 20}" fill="none" stroke="#ccc"/><path d="${path}" fill="none" stroke="#0b2a6b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><text x="24" y="405" font-size="12" fill="#555">${esc(pod.geo ? `Signed at ${pod.geo.lat.toFixed(5)}, ${pod.geo.lng.toFixed(5)} · ` : "")}Signed on a driver's phone in Logistics Pro</text></svg>`;
}

export function documentRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };

  const store = async (load: Load, accountId: string, file: { name: string; contentType: string; bytes: Buffer }, doc: Partial<LoadDocument> & { kind: LoadDocument["kind"] }) => {
    const id = newId("file");
    const at = ctx.now().toISOString();
    await ctx.files.put(id, file.bytes);
    ctx.store.files.set(id, { id, loadId: load.id, name: file.name, contentType: file.contentType, size: file.bytes.length, sha256: createHash("sha256").update(file.bytes).digest("hex"), uploadedByAccountId: accountId, at });
    const d: LoadDocument = { id: newId("doc"), name: file.name, url: `/v1/files/${id}`, uploadedByAccountId: accountId, at, fileId: id, contentType: file.contentType, size: file.bytes.length, ...doc };
    const fresh = ctx.store.loads.get(load.id)!;
    saveLoad(ctx, { ...fresh, documents: [...fresh.documents, d], updatedAt: at });
    return d;
  };

  /** A scan, photo or PDF of load paperwork, from anyone on the load. */
  app.post("/v1/loads/:id/documents/upload", { ...auth, bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    const body = parse(z.object({ kind: DocumentKind, name: z.string().trim().min(1).max(120), contentType: z.enum(TYPES), data: z.string().min(8), stopId: z.string().optional() }), req.body);
    const bytes = Buffer.from(body.data, "base64");
    if (bytes.length > MAX_BYTES) throw new HttpError(413, "TOO_LARGE", "Files can be up to 10 MB");
    if (sniff(bytes) !== body.contentType) throw new HttpError(400, "INVALID_FILE", "That file isn't the JPEG, PNG, WebP or PDF it says it is");
    if (body.stopId && !load.stops.some((s) => s.id === body.stopId)) throw new HttpError(400, "INVALID_REQUEST", "Unknown stop");
    const doc = await store(load, account.id, { name: body.name, contentType: body.contentType, bytes }, { kind: body.kind, stopId: body.stopId });
    postMessage(ctx, load, { senderAccountId: account.id, kind: "SYSTEM", body: `${body.kind.replace(/_/g, " ")} uploaded: ${body.name}` });
    reply.code(201);
    return documentViews(ctx, [doc])[0];
  });

  /** The receiver signs on the driver's phone; the signed receipt becomes the load's POD. */
  app.post("/v1/loads/:id/pod", auth, async (req, reply) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    if (!isDriverOn(load, account.id) && !hasOrgCap(ctx, account.id, load.carrierOrgId, "DISPATCH")) throw new HttpError(403, "FORBIDDEN", "The driver or dispatch collects the delivery signature");
    if (!["IN_TRANSIT", "AT_DELIVERY", "DELIVERED"].includes(load.status)) throw new HttpError(409, "NOT_AT_DELIVERY", "Signatures are collected at delivery");
    const pod = parse(Pod, req.body);
    const ink = pod.strokes.reduce((sum, s) => sum + s.slice(1).reduce((d, p, i) => d + Math.hypot(p[0] - s[i]![0], p[1] - s[i]![1]), 0), 0);
    if (ink < Math.min(pod.width, pod.height) * 0.5) throw new HttpError(400, "NO_SIGNATURE", "Ask the receiver to sign in the box");
    const deliveries = [...load.stops].sort((a, b) => a.sequence - b.sequence).filter((s) => s.type === "DELIVERY");
    const stop = pod.stopId ? load.stops.find((s) => s.id === pod.stopId) : deliveries.at(-1);
    if (pod.stopId && !stop) throw new HttpError(400, "INVALID_REQUEST", "Unknown stop");
    const at = ctx.now().toISOString();
    const svg = Buffer.from(receiptSvg(load, stop, pod, at));
    const doc = await store(load, account.id, { name: `Delivery receipt signed by ${pod.receiverName}`, contentType: "image/svg+xml", bytes: svg }, { kind: "POD", stopId: stop?.id, signedBy: pod.receiverName, geo: pod.geo });
    postMessage(ctx, load, { senderAccountId: account.id, kind: "SYSTEM", body: `Delivery receipt signed by ${pod.receiverName}${pod.exceptions ? `. Exceptions: ${pod.exceptions}` : ""}` });
    reply.code(201);
    return documentViews(ctx, [doc])[0];
  });

  /** A file, for someone who can see its load, or anyone holding a fresh signed link. */
  app.get("/v1/files/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { exp?: string; sig?: string };
    const meta = ctx.store.files.get(id);
    if (!meta) throw new HttpError(404, "NOT_FOUND", "File not found");
    if (!verifyFileSig(ctx.cfg.jwtSecret, id, q.exp, q.sig, ctx.now())) {
      await authenticate(ctx)(req, reply);
      getLoad(ctx, me(ctx, req).id, meta.loadId);
    }
    const bytes = await ctx.files.get(id);
    if (!bytes) throw new HttpError(404, "NOT_FOUND", "File not found");
    return reply
      .header("content-type", meta.contentType)
      .header("content-length", bytes.length)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:")
      .header("cache-control", "private, max-age=3600")
      .header("content-disposition", `inline; filename="${meta.name.replace(/[^\w .-]/g, "_")}${ext(meta.contentType)}"`)
      .send(bytes);
  });
}

const ext = (t: string) => ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf", "image/svg+xml": ".svg" })[t] ?? "";
