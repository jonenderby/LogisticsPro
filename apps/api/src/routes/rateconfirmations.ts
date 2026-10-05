import type { RateConfirmation } from "@logisticspro/domain";
import type { FastifyInstance } from "fastify";
import { type AppContext, HttpError, authenticate, canShip, getLoad, hasOrgCap, me } from "../http.js";
import { rateConfirmationsOf, signRateConfirmation } from "../services/rateconfirmations.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (n: number, cur = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(n);
const time = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

/** A printable page: the browser's Print saves it as a PDF. */
export function rateConHtml(rc: RateConfirmation): string {
  const party = (p: RateConfirmation["carrier"]) =>
    `<strong>${esc(p.name)}</strong><br>${[p.mcNumber && `MC ${esc(p.mcNumber)}`, p.dotNumber && `USDOT ${esc(p.dotNumber)}`, p.scac && `SCAC ${esc(p.scac)}`].filter(Boolean).join(" · ")}`;
  const stops = rc.stops
    .map((s) => `<tr><td>${s.sequence}</td><td>${esc(s.type.toLowerCase())}</td><td>${esc(s.address.name)}<br>${esc(s.address.line1)}, ${esc(s.address.city)}, ${esc(s.address.state)} ${esc(s.address.postalCode)}</td><td>${time(s.window.start)}<br>to ${time(s.window.end)}${s.appointmentRef ? `<br>Appt ${esc(s.appointmentRef)}` : ""}</td></tr>`)
    .join("");
  const sigs = rc.signatures.map((s) => `<li>${s.side === "CARRIER" ? "Carrier" : "Shipper or broker"}: <strong>${esc(s.name)}</strong>, ${time(s.at)} (${esc(s.method.toLowerCase().replace("_", " "))})</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rate confirmation ${esc(rc.loadNumber)} v${rc.version}</title>
<style>body{font:14px/1.45 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;color:#111;background:#fff;max-width:820px;margin:24px auto;padding:0 16px}h1{font-size:22px;margin:0}h2{font-size:15px;margin:20px 0 6px;border-bottom:1px solid #ccc;padding-bottom:4px}table{width:100%;border-collapse:collapse}td,th{text-align:left;vertical-align:top;padding:6px 8px 6px 0;border-bottom:1px solid #eee}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.muted{color:#555}.status{display:inline-block;padding:2px 8px;border-radius:6px;background:${rc.status === "SIGNED" ? "#e6f4ea" : "#fff4e5"}}code{font-size:11px;word-break:break-all}@media print{body{margin:0}}</style></head><body>
<h1>Rate confirmation · ${esc(rc.loadNumber)}</h1>
<p class="muted">Version ${rc.version} · <span class="status">${esc(rc.status.replace("_", " ").toLowerCase())}</span> · issued ${time(rc.createdAt)}${rc.changes.length ? ` · changed: ${esc(rc.changes.join(", "))}` : ""}</p>
<div class="grid"><div><h2>Shipper or broker</h2>${party(rc.tendering)}</div><div><h2>Carrier</h2>${party(rc.carrier)}</div></div>
<h2>Stops</h2><table><tr><th>#</th><th>Type</th><th>Where</th><th>When</th></tr>${stops}</table>
<h2>Freight</h2><table>
<tr><td>Equipment</td><td>${esc(rc.equipment)} · ${esc(rc.service.toLowerCase().replace(/_/g, " "))}${rc.teamRequired ? " · team required" : ""}</td></tr>
<tr><td>Commodity</td><td>${esc(rc.commodity.description)} · ${rc.commodity.pieces} pieces · ${rc.commodity.weightLb.toLocaleString("en-US")} lb${rc.commodity.hazmat ? " · HAZMAT" : ""}</td></tr>
<tr><td>References</td><td>${[rc.references.bol && `BOL ${esc(rc.references.bol)}`, rc.references.po.length && `PO ${esc(rc.references.po.join(", "))}`, rc.references.pro && `PRO ${esc(rc.references.pro)}`].filter(Boolean).join(" · ") || "None"}</td></tr>
${rc.notes ? `<tr><td>Notes</td><td>${esc(rc.notes)}</td></tr>` : ""}
</table>
<h2>Rate and payment</h2><table>
<tr><td>All-in rate</td><td><strong>${money(rc.rate.amount, rc.rate.currency)}</strong></td></tr>
${rc.accessorials.length ? `<tr><td>Accessorials</td><td>${esc(rc.accessorials.join(", "))}</td></tr>` : ""}
<tr><td>Detention</td><td>${rc.detention.freeHours} hours free, then ${money(rc.detention.ratePerHour)} an hour</td></tr>
<tr><td>Payment</td><td>${rc.payment.days} days from invoice${rc.payment.quickPay ? `; quick pay in ${rc.payment.quickPay.days} days at ${rc.payment.quickPay.feePct}%` : ""}</td></tr>
</table>
<h2>Terms</h2><ol>${rc.terms.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>
<h2>Signatures</h2><ul>${sigs}</ul>
<p class="muted">Signed electronically in Logistics Pro. Content fingerprint (SHA-256):<br><code>${esc(rc.hash)}</code></p>
</body></html>`;
}

/**
 * Rate confirmations for the shipping side and the carrier's office. The
 * carrier signs a revised version here.
 */
export function rateConRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };
  const office = (accountId: string, carrierOrgId?: string) => ["DISPATCH", "MANAGE_ORG", "INVOICE"].some((c) => hasOrgCap(ctx, accountId, carrierOrgId, c as "DISPATCH"));

  app.get("/v1/loads/:id/rate-confirmation", auth, async (req, reply) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    if (!canShip(ctx, account.id, load) && !office(account.id, load.carrierOrgId)) throw new HttpError(403, "FORBIDDEN", "Rate confirmations are for the shipper, broker and carrier office");
    const q = req.query as { version?: string; format?: string };
    const versions = rateConfirmationsOf(ctx, load.id);
    const rc = q.version ? versions.find((v) => v.version === Number(q.version)) : versions.at(-1);
    if (q.format === "html") {
      if (!rc) throw new HttpError(404, "NOT_FOUND", "No rate confirmation yet");
      return reply.header("content-type", "text/html; charset=utf-8").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'").send(rateConHtml(rc));
    }
    return { current: rc, versions: versions.map((v) => ({ version: v.version, status: v.status, createdAt: v.createdAt, changes: v.changes })) };
  });

  app.post("/v1/loads/:id/rate-confirmation/sign", auth, async (req) => {
    const account = me(ctx, req);
    const load = getLoad(ctx, account.id, (req.params as { id: string }).id);
    if (!hasOrgCap(ctx, account.id, load.carrierOrgId, "DISPATCH")) throw new HttpError(403, "FORBIDDEN", "The carrier's dispatch or owner signs rate confirmations");
    return signRateConfirmation(ctx, load, account.id);
  });
}
