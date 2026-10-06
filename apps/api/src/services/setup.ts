import { type Translate, translator } from "@logisticspro/workspace";
import type { AppContext } from "../http.js";

export type SetupState = "OK" | "WARN" | "OFF";

export interface SetupItem {
  id: string;
  title: string;
  state: SetupState;
  detail: string;
  /** Environment variables that change this. */
  settings: string[];
}

type Probe = (url: string) => Promise<boolean>;

/** A service counts as reachable if it answers at all within a few seconds. */
export const probeUrl: Probe = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
};

/**
 * What this deployment is connected to and what is missing, for the people
 * who run it. Nothing here reveals a secret; it only says whether one is set.
 */
export async function setupStatus(ctx: AppContext, t: Translate = translator("en"), probe: Probe = probeUrl): Promise<SetupItem[]> {
  const cfg = ctx.cfg;
  const item = (id: string, title: string, state: SetupState, detail: string, settings: string[]): SetupItem => ({ id, title, state, detail, settings });
  const reach = async (url?: string) => (url ? probe(url) : false);
  const [routingUp, geocoderUp] = await Promise.all([reach(cfg.valhallaUrl && `${cfg.valhallaUrl.replace(/\/$/, "")}/status`), reach(cfg.geocoder?.url)]);

  return [
    cfg.databaseUrl
      ? item("database", t("Database"), "OK", t("Postgres. Data survives restarts and several servers can share it."), ["LP_DATABASE_URL"])
      : item("database", t("Database"), "WARN", t("Data is kept in memory and is lost when the server restarts."), ["LP_DATABASE_URL"]),
    cfg.jwtSecretSet
      ? item("sessions", t("Sign-in sessions"), "OK", t("Sessions survive restarts and work across servers."), ["LP_JWT_SECRET"])
      : item("sessions", t("Sign-in sessions"), "WARN", t("Everyone is signed out when the server restarts, and several servers can't share sessions."), ["LP_JWT_SECRET"]),
    cfg.dataKey
      ? item("data-key", t("Stored credentials"), "OK", t("ELD keys are encrypted with their own key."), ["LP_DATA_KEY"])
      : item("data-key", t("Stored credentials"), "WARN", t("ELD keys are encrypted with the session secret. Set a separate key so changing one doesn't lose the other."), ["LP_DATA_KEY"]),
    cfg.push === "expo"
      ? item("push", t("Phone push"), "OK", t("Sent through Expo. Phones also need an app build with an EAS project ID."), ["LP_PUSH", "LP_EXPO_ACCESS_TOKEN"])
      : item("push", t("Phone push"), "OFF", t("Off. Notifications stay in the in-app list."), ["LP_PUSH"]),
    !cfg.valhallaUrl
      ? item("routing", t("Truck routing"), "OFF", t("No routing server. Routes are straight lines and ETAs use estimated road miles."), ["LP_VALHALLA_URL"])
      : routingUp
        ? item("routing", t("Truck routing"), "OK", t("Valhalla answers at {url}.", { url: cfg.valhallaUrl }), ["LP_VALHALLA_URL"])
        : item("routing", t("Truck routing"), "WARN", t("Valhalla doesn't answer at {url}.", { url: cfg.valhallaUrl }), ["LP_VALHALLA_URL"]),
    cfg.traffic
      ? item("traffic", t("Live traffic"), "OK", t("{kind} traffic times feed ETAs every 15 minutes.", { kind: cfg.traffic.kind === "here" ? "HERE" : "TomTom" }), ["LP_TRAFFIC", "LP_TRAFFIC_KEY"])
      : item("traffic", t("Live traffic"), "OFF", t("ETAs don't account for traffic. Add a HERE or TomTom key."), ["LP_TRAFFIC", "LP_TRAFFIC_KEY"]),
    !cfg.geocoder
      ? item("geocoder", t("Address search"), "OFF", t("No address search. Stops need coordinates typed in."), ["LP_GEOCODER", "LP_GEOCODER_URL"])
      : geocoderUp
        ? item("geocoder", t("Address search"), "OK", t("{kind} answers at {url}.", { kind: cfg.geocoder.kind === "nominatim" ? "Nominatim" : "Pelias", url: cfg.geocoder.url }), ["LP_GEOCODER", "LP_GEOCODER_URL"])
        : item("geocoder", t("Address search"), "WARN", t("{kind} doesn't answer at {url}.", { kind: cfg.geocoder.kind === "nominatim" ? "Nominatim" : "Pelias", url: cfg.geocoder.url }), ["LP_GEOCODER", "LP_GEOCODER_URL"]),
    cfg.fmcsaWebKey
      ? item("fmcsa", t("Carrier checks"), "OK", t("Carriers are checked against live FMCSA data."), ["LP_FMCSA_WEBKEY"])
      : cfg.fmcsaFixtures
        ? item("fmcsa", t("Carrier checks"), "WARN", t("Carriers are checked against a fixtures file, not live FMCSA data."), ["LP_FMCSA_WEBKEY", "LP_FMCSA_FIXTURES"])
        : item("fmcsa", t("Carrier checks"), "OFF", t("Carriers aren't checked. Get a free web key from FMCSA's QCMobile API."), ["LP_FMCSA_WEBKEY"]),
    cfg.as2KeyPem && cfg.as2CertPem
      ? item("as2", t("AS2 certificate"), "OK", t("Set in the configuration, so every server uses the same one."), ["LP_AS2_KEY_PEM", "LP_AS2_CERT_PEM"])
      : item("as2", t("AS2 certificate"), "WARN", t("Generated on this server. Set one in the configuration so every server uses the same certificate."), ["LP_AS2_KEY_PEM", "LP_AS2_CERT_PEM"]),
    /^https?:\/\/(localhost|127\.0\.0\.1)/.test(cfg.publicUrl)
      ? item("public-url", t("Public address"), "WARN", t("Partners are told to send to {url}, which only works on this machine.", { url: cfg.publicUrl }), ["LP_PUBLIC_URL"])
      : item("public-url", t("Public address"), "OK", t("Partners send to {url}.", { url: cfg.publicUrl }), ["LP_PUBLIC_URL"]),
    ctx.persistence
      ? item("files", t("Documents"), "OK", t("Stored in the database."), ["LP_DATABASE_URL"])
      : cfg.filesDir
        ? item("files", t("Documents"), "OK", t("Stored in {dir}.", { dir: cfg.filesDir }), ["LP_FILES_DIR"])
        : item("files", t("Documents"), "WARN", t("Kept in memory and lost when the server restarts."), ["LP_DATABASE_URL", "LP_FILES_DIR"]),
  ];
}

export const isPlatformAdmin = (ctx: AppContext, email: string) => ctx.cfg.adminEmails.includes(email.toLowerCase());
