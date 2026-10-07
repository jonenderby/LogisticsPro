import { translator } from "@logisticspro/workspace";
import type { FastifyInstance } from "fastify";
import { type AppContext, HttpError, authenticate, me } from "../http.js";
import { isPlatformAdmin, setupStatus } from "../services/setup.js";

/** Setup status for the people who run this deployment (LP_ADMIN_EMAILS). */
export function setupRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/system/setup", { preHandler: authenticate(ctx) }, async (req) => {
    const account = me(ctx, req);
    if (!isPlatformAdmin(ctx, account.email)) throw new HttpError(403, "FORBIDDEN", "Setup status is for the people who run this deployment");
    return { items: await setupStatus(ctx, translator(account.language)) };
  });
}
