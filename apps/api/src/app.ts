import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { IntegrationEngine, HttpTransport, OutboxTransport, envSecrets, type SecretResolver, type Transport } from "@logisticspro/integration";
import { type RoutingProvider, StaticProvider, ValhallaProvider } from "@logisticspro/navigation";
import Fastify, { type FastifyInstance } from "fastify";
import { type Config, loadConfig } from "./config.js";
import { type AppContext, toHttpError } from "./http.js";
import { authRoutes } from "./routes/auth.js";
import { integrationRoutes } from "./routes/integrations.js";
import { loadRoutes } from "./routes/loads.js";
import { meRoutes } from "./routes/me.js";
import { operationsRoutes } from "./routes/operations.js";
import { orgRoutes } from "./routes/orgs.js";
import { Tokens } from "./security/tokens.js";
import { IntegrationHub } from "./services/hub.js";
import { MemoryStore } from "./store.js";

export interface AppOptions {
  config?: Partial<Config>;
  store?: MemoryStore;
  transports?: Partial<Record<"HTTPS" | "AS2" | "SFTP" | "VAN", Transport>>;
  secrets?: SecretResolver;
  routing?: RoutingProvider;
  now?: () => Date;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const cfg = { ...loadConfig(), ...opts.config };
  const now = opts.now ?? (() => new Date());
  const store = opts.store ?? new MemoryStore();
  const outbox = new OutboxTransport(cfg.ediOutboxDir);
  const engine = new IntegrationEngine({
    transports: { HTTPS: new HttpTransport(), AS2: outbox, SFTP: outbox, VAN: outbox, ...opts.transports },
    secrets: opts.secrets ?? envSecrets,
    now,
  });
  const ctx: AppContext = {
    cfg,
    store,
    tokens: new Tokens(cfg),
    engine,
    hub: new IntegrationHub(store, engine, cfg, now),
    routing: opts.routing ?? (cfg.valhallaUrl ? new ValhallaProvider(cfg.valhallaUrl) : new StaticProvider()),
    now,
  };

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  // Credentialed CORS (the web session cookie) only for configured origins.
  await app.register(cors, cfg.webOrigins.length ? { origin: cfg.webOrigins, credentials: true } : { origin: true });
  for (const type of ["application/edi-x12", "application/edifact", "text/plain", "application/xml", "text/xml"]) {
    app.addContentTypeParser(type, { parseAs: "string" }, (_req, body, done) => done(null, body));
  }

  app.setErrorHandler((err, _req, reply) => {
    const http = toHttpError(err);
    if (http) return reply.code(http.status).send({ error: { code: http.code, message: http.message, details: http.details } });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: { code: "BAD_REQUEST", message: e.message } });
    app.log.error(err);
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Something went wrong" } });
  });

  app.get("/health", async () => ({ ok: true }));
  if (cfg.webDir) await serveWeb(app, cfg.webDir);
  authRoutes(app, ctx);
  meRoutes(app, ctx);
  orgRoutes(app, ctx);
  loadRoutes(app, ctx);
  operationsRoutes(app, ctx);
  integrationRoutes(app, ctx);
  return { app, ctx };
}

/**
 * Serve the website (the Expo web export of the same app) from the API
 * origin. Unknown non-API paths fall back to index.html so deep links such as
 * /loads/load/123 open the right screen.
 */
async function serveWeb(app: FastifyInstance, dir: string) {
  const root = resolve(dir);
  if (!existsSync(resolve(root, "index.html"))) throw new Error(`LP_WEB_DIR has no index.html: ${root}`);
  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    setHeaders: (res, path) => {
      res.header("cache-control", path.includes("/_expo/") || path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    },
  });
  app.addHook("onSend", async (req, reply, payload) => {
    if (!req.url.startsWith("/v1/")) {
      reply.header("x-content-type-options", "nosniff");
      reply.header("x-frame-options", "DENY");
      reply.header("referrer-policy", "strict-origin-when-cross-origin");
    }
    return payload;
  });
  app.setNotFoundHandler((req, reply) => {
    const wantsPage = req.method === "GET" && !req.url.startsWith("/v1/") && !req.url.startsWith("/health") && String(req.headers.accept ?? "").includes("text/html");
    if (wantsPage) return reply.header("cache-control", "no-cache").sendFile("index.html");
    return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } });
  });
}
