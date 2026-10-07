import { translator } from "@logisticspro/workspace";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../http.js";
import { esc, htmlPage, pageLanguage } from "./pages.js";

/** When the policy text below last changed. */
export const PRIVACY_UPDATED = "2026-10-07";

/**
 * The privacy policy app stores ask for, at /privacy, in the reader's
 * language. LP_OPERATOR_NAME names who runs this server and
 * LP_PRIVACY_CONTACT (or the first LP_ADMIN_EMAILS address) is where people
 * ask for their data or for their account to be deleted.
 */
export function privacyRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/privacy", async (req, reply) => {
    const lang = pageLanguage(req.headers["accept-language"]);
    const t = translator(lang);
    const operator = ctx.cfg.operatorName ?? "Logistics Pro";
    const contact = ctx.cfg.privacyContact ?? ctx.cfg.adminEmails[0];
    const mail = contact ? `<a href="mailto:${esc(contact)}">${esc(contact)}</a>` : esc(t("the company that runs this server"));
    const p = (text: string) => `<p>${esc(text)}</p>`;
    const section = (title: string, ...paras: string[]) => `<h2>${esc(title)}</h2>\n${paras.join("\n")}`;
    const list = (...items: string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
    const body = [
      p(t("{operator} runs Logistics Pro on its own server. This page explains what the app collects, why, and who sees it.", { operator })),
      section(
        t("What the app collects"),
        list(
          t("Your account: your name, email and the contact details you add, and your sign-in security settings."),
          t("Location: while you are on duty or on a load, the app records where you are, including when it is in the background. It is used to update your carrier and customers, record arrival times, count driving hours and fuel-tax miles. It stops when you go off duty."),
          t("Photos and files: paperwork you scan or attach, such as bills of lading and delivery receipts, and signatures taken on delivery."),
          t("Work records: loads, messages, hours of service, invoices, payments, and bank details for getting paid. Account numbers are stored encrypted."),
          t("Connections you set up, such as an electronic logging device account. Their keys are stored encrypted."),
        ),
      ),
      section(t("Who sees it"), p(t("The companies on a load see what they need to run it: the carrier, the shipper or broker, and the drivers. Your location is shared only for loads you are on. Your data is not sold or used for advertising."))),
      section(t("Other services"), p(t("Data stays on this server. It is sent elsewhere only for services the operator turns on: carrier checks with FMCSA, live traffic from HERE or TomTom, logging device providers you connect, and phone notifications through Expo."))),
      section(t("Keeping and deleting your data"), p(t("Records are kept while your account is open, and as long as the law requires for freight, tax and payment records."))) + `\n<p>${esc(t("To delete your account or get a copy of your data, write to"))} ${mail}.</p>`,
      `<p class="note" style="margin-top:2rem">${esc(t("Last updated {date}.", { date: PRIVACY_UPDATED }))}</p>`,
    ].join("\n");
    reply.header("content-type", "text/html; charset=utf-8").header("cache-control", "no-cache");
    return htmlPage(lang, t("Privacy policy"), body);
  });
}
