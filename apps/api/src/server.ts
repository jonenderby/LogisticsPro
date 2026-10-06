import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { setupStatus } from "./services/setup.js";

const cfg = loadConfig();
const { app, ctx } = await buildApp({ logger: true });
await app.listen({ port: cfg.port, host: cfg.host });
// Say once at start what isn't set up yet; the full list is in the app under More > Setup status.
for (const i of await setupStatus(ctx)) if (i.state !== "OK") app.log.warn(`Setup: ${i.title}: ${i.detail} (${i.settings.join(", ")})`);
