import { AlertPreferences, DEFAULT_ALERT_PREFERENCES, isTimeZone } from "@logisticspro/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, HttpError, authenticate, capsOf, me, parse } from "../http.js";
import { isExpoPushToken } from "../services/push.js";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../services/notify.js";

const MAX_DEVICES = 10;

/**
 * Arrival alerts: what a person wants to hear about (late, at risk, early,
 * on time), whether to be told the moment it happens, and at what local
 * times to get a summary. Plus the phones to push to and the in-app inbox.
 */
export function alertRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: authenticate(ctx) };
  const canTrack = (accountId: string) => (["SHIP", "BROKER", "DISPATCH"] as const).some((c) => capsOf(ctx, accountId).all.has(c));

  app.get("/v1/me/alert-preferences", auth, async (req) => {
    const account = me(ctx, req);
    const saved = ctx.store.alertPrefs.get(account.id);
    return { enabled: !!saved, eligible: canTrack(account.id), devices: (ctx.store.pushTokens.get(account.id) ?? []).length, ...(saved ?? DEFAULT_ALERT_PREFERENCES) };
  });

  app.put("/v1/me/alert-preferences", auth, async (req) => {
    const account = me(ctx, req);
    if (!canTrack(account.id)) throw new HttpError(403, "FORBIDDEN", "Arrival alerts are for shippers, 3PLs and carrier dispatch");
    const prefs = parse(AlertPreferences, req.body);
    prefs.statuses = [...new Set(prefs.statuses)];
    if (prefs.schedule) prefs.schedule = { ...prefs.schedule, times: [...new Set(prefs.schedule.times)].sort(), days: [...new Set(prefs.schedule.days)].sort() };
    if (!prefs.instant && !prefs.schedule) throw new HttpError(400, "INVALID_REQUEST", "Choose instant alerts, a schedule, or both");
    ctx.store.alertPrefs.set(account.id, prefs);
    return { enabled: true, eligible: true, devices: (ctx.store.pushTokens.get(account.id) ?? []).length, ...prefs };
  });

  /** Turn alerts off entirely. */
  app.delete("/v1/me/alert-preferences", auth, async (req) => {
    ctx.store.alertPrefs.delete(me(ctx, req).id);
    return { ok: true };
  });

  /** A phone registers its Expo push token after the person allows notifications. */
  app.post("/v1/me/push-tokens", auth, async (req, reply) => {
    const account = me(ctx, req);
    const body = parse(z.object({ token: z.string().refine(isExpoPushToken, "Not an Expo push token"), platform: z.enum(["ios", "android"]), timeZone: z.string().refine(isTimeZone).optional() }), req.body);
    if (body.timeZone) ctx.store.notificationSettings.set(account.id, { ...ctx.notifier.settings(account.id), timeZone: body.timeZone });
    // A phone belongs to whoever signed in last on it.
    for (const [id, list] of ctx.store.pushTokens) if (id !== account.id) ctx.store.pushTokens.set(id, list.filter((t) => t.token !== body.token));
    const mine = (ctx.store.pushTokens.get(account.id) ?? []).filter((t) => t.token !== body.token);
    ctx.store.pushTokens.set(account.id, [{ token: body.token, platform: body.platform, createdAt: ctx.now().toISOString() }, ...mine].slice(0, MAX_DEVICES));
    reply.code(201);
    return { devices: ctx.store.pushTokens.get(account.id)!.length };
  });

  /** Signing out on a phone stops its pushes. */
  app.post("/v1/me/push-tokens/remove", auth, async (req) => {
    const account = me(ctx, req);
    const { token } = parse(z.object({ token: z.string() }), req.body);
    ctx.store.pushTokens.set(account.id, (ctx.store.pushTokens.get(account.id) ?? []).filter((t) => t.token !== token));
    return { ok: true };
  });

  /** Tenders and messages: on by default, each can be turned off. */
  app.get("/v1/me/notification-settings", auth, async (req) => {
    const account = me(ctx, req);
    const caps = capsOf(ctx, account.id).all;
    return { ...ctx.notifier.settings(account.id), tendersApply: caps.has("DISPATCH") || caps.has("SHIP") || caps.has("BROKER"), devices: (ctx.store.pushTokens.get(account.id) ?? []).length };
  });

  app.put("/v1/me/notification-settings", auth, async (req) => {
    const account = me(ctx, req);
    const body = parse(z.object({ tenders: z.boolean().optional(), messages: z.boolean().optional(), timeZone: z.string().refine(isTimeZone, "Unknown time zone").optional() }), req.body);
    const next = { ...DEFAULT_NOTIFICATION_SETTINGS, ...ctx.store.notificationSettings.get(account.id), ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
    ctx.store.notificationSettings.set(account.id, next);
    return next;
  });

  app.post("/v1/me/alert-preferences/test", auth, async (req) => ctx.alerts.test(me(ctx, req).id));

  app.get("/v1/me/notifications", auth, async (req) => {
    const items = ctx.store.notifications.get(me(ctx, req).id) ?? [];
    return { unread: items.filter((i) => !i.read).length, items: items.slice(0, 50) };
  });

  /** Mark some (or, with no ids, all) alerts read. */
  app.post("/v1/me/notifications/read", auth, async (req) => {
    const account = me(ctx, req);
    const { ids } = parse(z.object({ ids: z.array(z.string()).optional() }), req.body ?? {});
    for (const i of ctx.store.notifications.get(account.id) ?? []) if (!ids || ids.includes(i.id)) i.read = true;
    ctx.store.notifications.touch(account.id);
    return { ok: true };
  });
}
