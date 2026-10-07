import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type As2Identity, as2 } from "@logisticspro/integration";
import type { Config } from "../config.js";

/**
 * The platform's one AS2 station. Every business on Logistics Pro shares it,
 * so a trading partner sets up a single AS2 connection to reach all of them.
 * Key and certificate come from config, or are generated once and kept in
 * LP_AS2_DIR so restarts do not change the certificate partners trust.
 */
export function loadAs2Identity(cfg: Config, log: (m: string) => void = () => undefined): As2Identity {
  if (cfg.as2KeyPem && cfg.as2CertPem) return { as2Id: cfg.as2Id, privateKeyPem: cfg.as2KeyPem, certificatePem: cfg.as2CertPem };
  const dir = resolve(cfg.as2Dir);
  const keyFile = join(dir, "station.key.pem");
  const certFile = join(dir, "station.cert.pem");
  if (existsSync(keyFile) && existsSync(certFile)) {
    return { as2Id: cfg.as2Id, privateKeyPem: readFileSync(keyFile, "utf8"), certificatePem: readFileSync(certFile, "utf8") };
  }
  const id = as2.generateAs2Identity(cfg.as2Id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyFile, id.privateKeyPem, { mode: 0o600 });
  writeFileSync(certFile, id.certificatePem);
  log(`Generated a self-signed AS2 station certificate in ${dir}`);
  return id;
}
