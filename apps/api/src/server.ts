import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const { app } = await buildApp({ logger: true });
await app.listen({ port: cfg.port, host: cfg.host });
