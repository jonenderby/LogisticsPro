import { z } from "zod";
import { fieldMapCoverage } from "./mapping.js";
import { TRANSACTIONS, TransactionType } from "./transactions.js";

export const IntegrationMethod = z.enum(["API_JSON", "API_XML", "EDI_X12"]);
export type IntegrationMethod = z.infer<typeof IntegrationMethod>;

/** Preferred order when a partner supports several methods. */
export const METHOD_PRIORITY: IntegrationMethod[] = ["API_JSON", "API_XML", "EDI_X12"];

export function preferredMethod(supported: IntegrationMethod[]): IntegrationMethod | undefined {
  return METHOD_PRIORITY.find((m) => supported.includes(m));
}

export function methodSupports(method: IntegrationMethod, tx: TransactionType): boolean {
  return method !== "EDI_X12" || !!TRANSACTIONS[tx].x12;
}

/** Secrets are referenced by name and resolved at send time; they are never stored on a profile. */
export const AuthConfig = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("apiKey"), header: z.string().default("x-api-key"), secretRef: z.string() }),
  z.object({ type: z.literal("basic"), usernameRef: z.string(), passwordRef: z.string() }),
  z.object({ type: z.literal("bearer"), secretRef: z.string() }),
  z.object({ type: z.literal("oauth2"), tokenUrl: z.string().url(), clientIdRef: z.string(), clientSecretRef: z.string(), scope: z.string().optional() }),
]);
export type AuthConfig = z.infer<typeof AuthConfig>;

export const TransportKind = z.enum(["HTTPS", "AS2", "SFTP", "VAN"]);
export type TransportKind = z.infer<typeof TransportKind>;

export const Channel = z.object({
  method: IntegrationMethod,
  enabled: z.boolean().default(true),
  transport: TransportKind.default("HTTPS"),
  endpoint: z
    .object({
      url: z.string().url(),
      httpMethod: z.enum(["POST", "PUT"]).default("POST"),
      auth: AuthConfig.default({ type: "none" }),
      headers: z.record(z.string(), z.string()).default({}),
    })
    .optional(),
  /** Partner path -> canonical path. Empty means the canonical shape is sent as-is. */
  fieldMap: z.record(z.string(), z.string()).optional(),
  xmlRoot: z.string().optional(),
});
export type Channel = z.infer<typeof Channel>;

export const EdiSettings = z.object({
  /** Our interchange id as this partner knows us. */
  senderQualifier: z.string().length(2).default("ZZ"),
  senderId: z.string().min(1).max(15),
  receiverQualifier: z.string().length(2).default("ZZ"),
  receiverId: z.string().min(1).max(15),
  usage: z.enum(["P", "T"]).default("T"),
  ackRequested: z.boolean().default(true),
  codeOverrides: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});
export type EdiSettings = z.infer<typeof EdiSettings>;

export const PartnerKind = z.enum(["CARRIER", "SHIPPER", "BROKER_3PL", "ERP"]);

/**
 * How one business exchanges data with one trading partner. Owned by the
 * business (ownerOrgId), so Estes can be on API for one shipper and on EDI
 * for another.
 */
export const PartnerProfile = z.object({
  key: z.string().min(1),
  ownerOrgId: z.string(),
  name: z.string(),
  kind: PartnerKind,
  scac: z.string().optional(),
  catalogCode: z.string().optional(),
  channels: z.partialRecord(TransactionType, Channel),
  edi: EdiSettings.optional(),
});
export type PartnerProfile = z.infer<typeof PartnerProfile>;

export interface ProfileIssue {
  transaction?: TransactionType;
  message: string;
}

export function validateProfile(p: PartnerProfile): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  for (const [tx, ch] of Object.entries(p.channels) as Array<[TransactionType, Channel]>) {
    if (!ch.enabled) continue;
    if (!methodSupports(ch.method, tx)) issues.push({ transaction: tx, message: `${tx} has no X12 transaction set; use API_JSON or API_XML` });
    if (ch.method === "EDI_X12" && !p.edi) issues.push({ transaction: tx, message: "EDI channel needs interchange settings (sender/receiver ids)" });
    if (ch.method !== "EDI_X12" && ch.transport !== "HTTPS") issues.push({ transaction: tx, message: "API channels use HTTPS" });
    if (ch.transport === "HTTPS" && !ch.endpoint) issues.push({ transaction: tx, message: "HTTPS channel needs an endpoint URL" });
    if (ch.method === "EDI_X12" && ch.fieldMap && Object.keys(ch.fieldMap).length) issues.push({ transaction: tx, message: "Field maps apply to API channels; EDI uses code overrides" });
    try {
      const cov = fieldMapCoverage(tx, ch.fieldMap);
      for (const f of cov.missingRequired) issues.push({ transaction: tx, message: `field map does not carry required field ${f}` });
    } catch (e) {
      issues.push({ transaction: tx, message: (e as Error).message });
    }
  }
  return issues;
}
