import { randomBytes } from "node:crypto";

export interface Config {
  port: number;
  host: string;
  jwtSecret: Uint8Array;
  issuer: string;
  accessTokenTtl: string;
  refreshTokenDays: number;
  /** Where EDI for AS2/SFTP/VAN partners is written for the EDI gateway. */
  ediOutboxDir: string;
  /** Valhalla base URL for truck routing; without it, straight-line routes are used. */
  valhallaUrl?: string;
  /** Interchange id Logistics Pro uses as an EDI sender. */
  ediSenderId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = env.LP_JWT_SECRET;
  if (!secret && env.NODE_ENV === "production") throw new Error("LP_JWT_SECRET is required in production");
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    jwtSecret: secret ? new TextEncoder().encode(secret) : randomBytes(32),
    issuer: env.LP_ISSUER ?? "logistics-pro",
    accessTokenTtl: env.LP_ACCESS_TTL ?? "1h",
    refreshTokenDays: Number(env.LP_REFRESH_DAYS ?? 30),
    ediOutboxDir: env.LP_EDI_OUTBOX ?? "./var/edi-outbox",
    valhallaUrl: env.LP_VALHALLA_URL,
    ediSenderId: env.LP_EDI_SENDER_ID ?? "LOGISTICSPRO",
  };
}
