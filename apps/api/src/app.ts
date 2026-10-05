import cors from "@fastify/cors";
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
  await app.register(cors, { origin: true });
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
  authRoutes(app, ctx);
  meRoutes(app, ctx);
  orgRoutes(app, ctx);
  loadRoutes(app, ctx);
  operationsRoutes(app, ctx);
  integrationRoutes(app, ctx);
  return { app, ctx };
}
