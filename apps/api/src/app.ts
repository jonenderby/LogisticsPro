import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { As2Transport, type As2Identity, IntegrationEngine, HttpTransport, OutboxTransport, envSecrets, type SecretResolver, type Transport } from "@logisticspro/integration";
import { type Geocoder, NominatimGeocoder, PeliasGeocoder, type RoutingProvider, StaticProvider, ValhallaProvider } from "@logisticspro/navigation";
import Fastify, { type FastifyInstance } from "fastify";
import { type Config, loadConfig } from "./config.js";
import { type AppContext, toHttpError } from "./http.js";
import { as2Routes } from "./routes/as2.js";
import { authRoutes } from "./routes/auth.js";
import { networkRoutes } from "./routes/network.js";
import { reliabilityRoutes } from "./routes/reliability.js";
import { trackingRoutes } from "./routes/tracking.js";
import { loadAs2Identity } from "./services/as2station.js";
import { integrationRoutes } from "./routes/integrations.js";
import { loadRoutes } from "./routes/loads.js";
import { meRoutes } from "./routes/me.js";
import { operationsRoutes } from "./routes/operations.js";
import { orgRoutes } from "./routes/orgs.js";
import { Tokens } from "./security/tokens.js";
import { AlertEngine } from "./services/alerts.js";
import { Notifier } from "./services/notify.js";
import { PgPersistence } from "./persistence/postgres.js";
import { IntegrationHub } from "./services/hub.js";
import { ExpoPushSender, NoPushSender, type PushSender } from "./services/push.js";
import { alertRoutes } from "./routes/alerts.js";
import { hosRoutes } from "./routes/hos.js";
import { MemoryStore } from "./store.js";

export interface AppOptions {
  config?: Partial<Config>;
  store?: MemoryStore;
  transports?: Partial<Record<"HTTPS" | "AS2" | "SFTP" | "VAN", Transport>>;
  secrets?: SecretResolver;
  routing?: RoutingProvider;
  geocoder?: Geocoder;
  as2Identity?: As2Identity;
  /** fetch used by the AS2 transport (tests point it at another station). */
  as2Fetch?: NonNullable<ConstructorParameters<typeof As2Transport>[1]>["fetch"];
  now?: () => Date;
  logger?: boolean;
  /** Phone push delivery; defaults to Expo's push service (or none with LP_PUSH=off). */
  push?: PushSender;
}

export async function buildApp(opts: AppOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const cfg = { ...loadConfig(), ...opts.config };
  const now = opts.now ?? (() => new Date());
  const store = opts.store ?? new MemoryStore();
  // With a database, load everything and keep it written through before serving.
  const persistence = cfg.databaseUrl ? await PgPersistence.start({ url: cfg.databaseUrl, store, log: { info: (m) => console.info(m), error: (m, e) => console.error(m, e) } }) : undefined;
  const outbox = new OutboxTransport(cfg.ediOutboxDir);
  const station = opts.as2Identity ?? loadAs2Identity(cfg, (m) => console.warn(m));
  const as2Transport = new As2Transport(() => station, { fetch: opts.as2Fetch, receiptUrl: `${cfg.publicUrl}/as2` });
  const engine = new IntegrationEngine({
    transports: { HTTPS: new HttpTransport(), AS2: as2Transport, SFTP: outbox, VAN: outbox, ...opts.transports },
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
    geocoder: opts.geocoder ?? (cfg.geocoder ? (cfg.geocoder.kind === "nominatim" ? new NominatimGeocoder(cfg.geocoder.url) : new PeliasGeocoder(cfg.geocoder.url, { apiKey: cfg.geocoder.apiKey })) : undefined),
    as2: station,
    as2Transport,
    push: opts.push ?? (cfg.push === "off" ? new NoPushSender() : new ExpoPushSender(cfg.expoAccessToken)),
    notifier: undefined as unknown as Notifier,
    alerts: undefined as unknown as AlertEngine,
    persistence,
    now,
  };
  ctx.notifier = new Notifier(ctx);
  ctx.alerts = new AlertEngine(ctx);
  ctx.hub.onLoadSaved = (prior, next) => ctx.notifier.loadSaved(prior, next);

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  // Credentialed CORS (the web session cookie) only for configured origins.
  await app.register(cors, cfg.webOrigins.length ? { origin: cfg.webOrigins, credentials: true } : { origin: true });
  for (const type of ["application/edi-x12", "application/edifact", "text/plain", "application/xml", "text/xml"]) {
    app.addContentTypeParser(type, { parseAs: "string" }, (_req, body, done) => done(null, body));
  }
  // AS2 bodies are binary (encrypted or signed MIME).
  app.addContentTypeParser(["application/pkcs7-mime", "application/x-pkcs7-mime", "multipart/signed"], { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  if (persistence) {
    // A response is sent only once the changes it made are committed.
    app.addHook("onSend", async (_req, _reply, payload) => {
      await persistence.flush();
      return payload;
    });
    app.addHook("onClose", async () => persistence.close());
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
  as2Routes(app, ctx);
  networkRoutes(app, ctx);
  reliabilityRoutes(app, ctx);
  trackingRoutes(app, ctx);
  alertRoutes(app, ctx);
  hosRoutes(app, ctx);

  if (cfg.alertIntervalSeconds > 0) {
    const timer = setInterval(() => {
      // With several servers, only the one holding the job lock runs jobs.
      if (persistence && !persistence.isLeader()) return;
      void ctx.alerts.tick().catch((e) => app.log.error(e));
      void ctx.notifier.checkReceipts().catch((e) => app.log.error(e));
    }, cfg.alertIntervalSeconds * 1000);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }
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
    // Look files up on each request, so a new web build (new hashed bundle
    // names) is served without restarting the API.
    wildcard: true,
    setHeaders: (res, path) => {
      res.header("cache-control", path.includes("/_expo/") || path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    },
  });
  app.addHook("onSend", async (req, reply, payload) => {
    if (!req.url.startsWith("/v1/") && !req.url.startsWith("/as2")) {
      reply.header("x-content-type-options", "nosniff");
      reply.header("x-frame-options", "DENY");
      reply.header("referrer-policy", "strict-origin-when-cross-origin");
    }
    return payload;
  });
  app.setNotFoundHandler((req, reply) => {
    const wantsPage = req.method === "GET" && !req.url.startsWith("/v1/") && !req.url.startsWith("/health") && !req.url.startsWith("/as2") && String(req.headers.accept ?? "").includes("text/html");
    if (wantsPage) return reply.header("cache-control", "no-cache").sendFile("index.html");
    return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } });
  });
}
