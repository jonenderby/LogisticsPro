import { randomBytes } from "node:crypto";

export interface Config {
  port: number;
  host: string;
  jwtSecret: Uint8Array;
  /** False when no LP_JWT_SECRET was given and a random one is used, so sessions end on restart. */
  jwtSecretSet: boolean;
  /** Emails of the people who run this deployment; they see its setup status. */
  adminEmails: string[];
  issuer: string;
  accessTokenTtl: string;
  refreshTokenDays: number;
  /** Where EDI for AS2/SFTP/VAN partners is written for the EDI gateway. */
  ediOutboxDir: string;
  /** Valhalla base URL for truck routing; without it, straight-line routes are used. */
  valhallaUrl?: string;
  /** Interchange id Logistics Pro uses as an EDI sender. */
  ediSenderId: string;
  /** Built website (Expo web export) to serve at "/", so one deployment serves app and API. */
  webDir?: string;
  /** Other origins allowed to call the API with the session cookie (e.g. the Expo dev server). */
  webOrigins: string[];
  /** Mark the session cookie Secure (HTTPS only). On by default in production. */
  cookieSecure: boolean;
  /** Public base URL of this server, used to tell partners where to send AS2 (e.g. https://api.example.com). */
  publicUrl: string;
  /** The platform's single AS2 station identity. */
  as2Id: string;
  /** PEM key/certificate for the AS2 station. Without them a certificate is generated and saved in as2Dir. */
  as2KeyPem?: string;
  as2CertPem?: string;
  as2Dir: string;
  /** Live traffic for ETAs: HERE or TomTom truck routing, with its API key. */
  traffic?: { kind: "here" | "tomtom"; apiKey: string };
  /** Address search: "pelias" or "nominatim", with its base URL. */
  geocoder?: { kind: "pelias" | "nominatim"; url: string; apiKey?: string };
  /** How long a carrier's join code stays valid before it rotates. */
  joinCodeTtlHours: number;
  /** Phone push: "expo" sends through Expo's push service, "off" keeps alerts in the in-app inbox only. */
  push: "expo" | "off";
  /** Optional Expo access token when the Expo project requires authenticated sends. */
  expoAccessToken?: string;
  /** How often arrival alerts are checked, in seconds. 0 turns the checker off. */
  alertIntervalSeconds: number;
  /** Postgres connection string. Without it, data lives in memory only. */
  databaseUrl?: string;
  /** FMCSA QCMobile web key for carrier vetting. Without it, carriers are not checked. */
  fmcsaWebKey?: string;
  /** A JSON file of FMCSA records (an array) to check against instead, for demos and staging. */
  fmcsaFixtures?: string;
  /** Directory for uploaded documents when there is no database. Without either, they are kept in memory. */
  filesDir?: string;
  /** Phone app builds offered at /download (deploy/build-android.sh puts them there). */
  downloadsDir?: string;
  /** Finished loads untouched this many days leave memory (they stay in Postgres and come back when opened). 0 keeps everything. */
  archiveAfterDays: number;
  /** Integration transmissions older than this many days leave memory. */
  archiveTransmissionsAfterDays: number;
  /** Key for encrypting credentials businesses give us (ELD API keys). Defaults to the JWT secret. */
  dataKey?: Uint8Array;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = env.LP_JWT_SECRET;
  if (!secret && env.NODE_ENV === "production") throw new Error("LP_JWT_SECRET is required in production");
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    jwtSecret: secret ? new TextEncoder().encode(secret) : randomBytes(32),
    jwtSecretSet: !!secret,
    adminEmails: (env.LP_ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    issuer: env.LP_ISSUER ?? "logistics-pro",
    accessTokenTtl: env.LP_ACCESS_TTL ?? "1h",
    refreshTokenDays: Number(env.LP_REFRESH_DAYS ?? 30),
    ediOutboxDir: env.LP_EDI_OUTBOX ?? "./var/edi-outbox",
    valhallaUrl: env.LP_VALHALLA_URL,
    ediSenderId: env.LP_EDI_SENDER_ID ?? "LOGISTICSPRO",
    webDir: env.LP_WEB_DIR,
    webOrigins: (env.LP_WEB_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    cookieSecure: env.LP_COOKIE_SECURE ? env.LP_COOKIE_SECURE === "true" : env.NODE_ENV === "production",
    publicUrl: (env.LP_PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8080}`).replace(/\/$/, ""),
    as2Id: env.LP_AS2_ID ?? "LOGISTICSPRO",
    as2KeyPem: env.LP_AS2_KEY_PEM,
    as2CertPem: env.LP_AS2_CERT_PEM,
    as2Dir: env.LP_AS2_DIR ?? "./var/as2",
    traffic: env.LP_TRAFFIC_KEY && (env.LP_TRAFFIC === "here" || env.LP_TRAFFIC === "tomtom") ? { kind: env.LP_TRAFFIC, apiKey: env.LP_TRAFFIC_KEY } : undefined,
    geocoder: env.LP_GEOCODER_URL ? { kind: env.LP_GEOCODER === "nominatim" ? "nominatim" : "pelias", url: env.LP_GEOCODER_URL, apiKey: env.LP_GEOCODER_KEY } : undefined,
    joinCodeTtlHours: Number(env.LP_JOIN_CODE_TTL_HOURS ?? 24 * 7),
    push: env.LP_PUSH === "off" ? "off" : "expo",
    expoAccessToken: env.LP_EXPO_ACCESS_TOKEN,
    alertIntervalSeconds: Number(env.LP_ALERT_INTERVAL_SECONDS ?? 60),
    fmcsaWebKey: env.LP_FMCSA_WEBKEY || undefined,
    fmcsaFixtures: env.LP_FMCSA_FIXTURES || undefined,
    filesDir: env.LP_FILES_DIR || undefined,
    downloadsDir: env.LP_DOWNLOADS_DIR || undefined,
    archiveAfterDays: Number(env.LP_ARCHIVE_AFTER_DAYS ?? 120),
    archiveTransmissionsAfterDays: Number(env.LP_ARCHIVE_TRANSMISSIONS_AFTER_DAYS ?? 30),
    dataKey: env.LP_DATA_KEY ? new TextEncoder().encode(env.LP_DATA_KEY) : undefined,
    databaseUrl: env.LP_DATABASE_URL || env.DATABASE_URL || undefined,
  };
}
