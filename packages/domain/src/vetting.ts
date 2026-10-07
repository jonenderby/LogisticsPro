import { z } from "zod";

/**
 * Carrier vetting: is this carrier allowed to haul, insured, and who it says
 * it is? Facts come from FMCSA (the US motor carrier registry); the checks
 * below turn them into PASS, REVIEW (a person should look) or FAIL (do not
 * tender). Several checks target double brokering and identity theft, where
 * a fraudster uses a real carrier's USDOT number to take a load and re-broker
 * it, or to redirect payment.
 */

export const AuthorityStatus = z.enum(["ACTIVE", "INACTIVE", "PENDING", "NONE"]);
export type AuthorityStatus = z.infer<typeof AuthorityStatus>;

export const FmcsaRecord = z.object({
  dotNumber: z.string(),
  mcNumbers: z.array(z.string()).default([]),
  legalName: z.string(),
  dbaName: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  address: z.object({ street: z.string().optional(), city: z.string().optional(), state: z.string().optional(), postalCode: z.string().optional() }).optional(),
  allowedToOperate: z.boolean(),
  outOfService: z.boolean(),
  outOfServiceDate: z.string().optional(),
  authority: z.object({ common: AuthorityStatus, contract: AuthorityStatus, broker: AuthorityStatus }),
  /** When the carrier's operating authority was first granted, when known. */
  authoritySince: z.string().optional(),
  insurance: z.object({
    /** Bodily injury and property damage (auto liability) on file, in dollars. */
    liabilityOnFileUsd: z.number().optional(),
    liabilityRequiredUsd: z.number().optional(),
    cargoOnFileUsd: z.number().optional(),
  }),
  safetyRating: z.enum(["SATISFACTORY", "CONDITIONAL", "UNSATISFACTORY", "NOT_RATED"]).optional(),
  powerUnits: z.number().optional(),
  drivers: z.number().optional(),
  fetchedAt: z.string(),
});
export type FmcsaRecord = z.infer<typeof FmcsaRecord>;

/** A shipper's or broker's vetting rules. */
export const VettingPolicy = z.object({
  /** New authorities are a common fraud signal; younger than this needs review. */
  minAuthorityDays: z.number().int().min(0).max(3650).default(90),
  minLiabilityUsd: z.number().min(0).default(750_000),
  minCargoUsd: z.number().min(0).default(100_000),
  /** Treat a Conditional safety rating as a pass instead of needing review. */
  allowConditional: z.boolean().default(false),
});
export type VettingPolicy = z.infer<typeof VettingPolicy>;
export const DEFAULT_VETTING_POLICY: VettingPolicy = { minAuthorityDays: 90, minLiabilityUsd: 750_000, minCargoUsd: 100_000, allowConditional: false };

export type VettingOutcome = "PASS" | "REVIEW" | "FAIL";
export interface VettingCheck {
  code: string;
  result: VettingOutcome;
  title: string;
  detail?: string;
}
export interface VettingResult {
  /** NOT_CHECKED: FMCSA lookups are not set up, so nothing is enforced. */
  verdict: VettingOutcome | "NOT_CHECKED";
  checks: VettingCheck[];
  checkedAt?: string;
}

export interface VettingInput {
  org: { name: string; dotNumber?: string; mcNumber?: string };
  record?: FmcsaRecord;
  /** Earlier FMCSA snapshots of this USDOT number, oldest first. */
  history?: FmcsaRecord[];
  /** Email addresses of the carrier's owners and admins on Logistics Pro. */
  contactEmails?: string[];
  /** Other companies on Logistics Pro claiming the same USDOT number. */
  otherOrgsWithDot?: number;
  policy?: VettingPolicy;
  now: string;
}

const FREE_MAIL = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com", "icloud.com", "live.com", "msn.com", "protonmail.com", "proton.me", "comcast.net", "att.net"]);
const SUFFIXES = /\b(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc|the|trucking|transport|transportation|logistics|express|freight|lines|carriers?|services?)\b/g;

/** Lowercase name without punctuation or business suffixes, for comparing names. */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").replace(SUFFIXES, " ").replace(/\s+/g, " ").trim();
}

export function namesMatch(a: string, b: string): boolean {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return a.trim().toLowerCase() === b.trim().toLowerCase();
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const tx = new Set(x.split(" "));
  const ty = y.split(" ");
  const shared = ty.filter((t) => tx.has(t)).length;
  return shared / Math.max(tx.size, ty.length) >= 0.6;
}

const domainOf = (email: string) => email.split("@")[1]?.toLowerCase().trim() ?? "";
const digits = (s?: string) => (s ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const days = (from: string, to: string) => Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000);

export function vetCarrier(input: VettingInput): VettingResult {
  const policy = input.policy ?? DEFAULT_VETTING_POLICY;
  const checks: VettingCheck[] = [];
  const add = (code: string, result: VettingOutcome, title: string, detail?: string) => checks.push({ code, result, title, detail });
  const r = input.record;

  if (!input.org.dotNumber) {
    add("DOT_ON_FILE", "FAIL", "No USDOT number", "The carrier has not entered its USDOT number.");
    return finish(checks, input.now);
  }
  if (!r) {
    add("FMCSA_FOUND", "FAIL", "Not found at FMCSA", `USDOT ${input.org.dotNumber} is not in the FMCSA registry.`);
    return finish(checks, input.now);
  }

  add("ALLOWED_TO_OPERATE", r.allowedToOperate ? "PASS" : "FAIL", r.allowedToOperate ? "Allowed to operate" : "Not allowed to operate", r.allowedToOperate ? undefined : "FMCSA shows this carrier is not authorized to operate.");
  if (r.outOfService) add("OUT_OF_SERVICE", "FAIL", "Out of service", `Placed out of service${r.outOfServiceDate ? ` on ${r.outOfServiceDate}` : ""}.`);

  const carrierAuthority = r.authority.common === "ACTIVE" || r.authority.contract === "ACTIVE";
  if (carrierAuthority) add("AUTHORITY", "PASS", "Active operating authority", `Common ${r.authority.common.toLowerCase()}, contract ${r.authority.contract.toLowerCase()}.`);
  else if (r.authority.broker === "ACTIVE") add("AUTHORITY", "FAIL", "Broker authority only", "A broker can't haul freight. Tendering to a broker as a carrier is how loads get double brokered.");
  else add("AUTHORITY", "FAIL", "No active operating authority", r.authority.common === "PENDING" || r.authority.contract === "PENDING" ? "The authority is still pending." : "The carrier's operating authority is inactive or revoked.");

  if (input.org.mcNumber) {
    const mc = input.org.mcNumber.replace(/\D/g, "");
    const ok = r.mcNumbers.some((m) => m.replace(/\D/g, "") === mc);
    add("MC_MATCH", ok ? "PASS" : "FAIL", ok ? "MC number matches the USDOT" : "MC number doesn't match", ok ? undefined : `MC ${input.org.mcNumber} is not registered to USDOT ${r.dotNumber}${r.mcNumbers.length ? ` (FMCSA lists ${r.mcNumbers.map((m) => `MC ${m}`).join(", ")})` : ""}.`);
  }

  if (r.authoritySince) {
    const age = days(r.authoritySince, input.now);
    add("AUTHORITY_AGE", age >= policy.minAuthorityDays ? "PASS" : "REVIEW", `Authority ${age} days old`, age >= policy.minAuthorityDays ? undefined : `Younger than your ${policy.minAuthorityDays}-day minimum. New authorities are a common fraud signal.`);
  }

  const liability = r.insurance.liabilityOnFileUsd;
  if (liability === undefined) add("LIABILITY", "REVIEW", "Liability insurance not on file", "FMCSA has no auto liability filing. Ask for a certificate from the insurer directly.");
  else add("LIABILITY", liability >= policy.minLiabilityUsd ? "PASS" : "FAIL", `Liability ${usd(liability)} on file`, liability >= policy.minLiabilityUsd ? undefined : `Below your ${usd(policy.minLiabilityUsd)} minimum.`);
  if (r.insurance.cargoOnFileUsd !== undefined && r.insurance.cargoOnFileUsd < policy.minCargoUsd) {
    add("CARGO", "REVIEW", `Cargo ${usd(r.insurance.cargoOnFileUsd)} on file`, `Below your ${usd(policy.minCargoUsd)} minimum. Ask for a cargo certificate.`);
  }

  if (r.safetyRating === "UNSATISFACTORY") add("SAFETY", "FAIL", "Unsatisfactory safety rating");
  else if (r.safetyRating === "CONDITIONAL") add("SAFETY", policy.allowConditional ? "PASS" : "REVIEW", "Conditional safety rating");
  else add("SAFETY", "PASS", r.safetyRating === "SATISFACTORY" ? "Satisfactory safety rating" : "Not rated");

  const names = [r.legalName, r.dbaName].filter((n): n is string => !!n);
  const nameOk = names.some((n) => namesMatch(input.org.name, n));
  add("NAME_MATCH", nameOk ? "PASS" : "REVIEW", nameOk ? "Name matches FMCSA" : "Name doesn't match FMCSA", nameOk ? undefined : `Registered as ${names.join(" / ")}, not ${input.org.name}.`);

  // Identity: the people running this account should be reachable the way FMCSA lists the carrier.
  if (r.email && input.contactEmails?.length) {
    const fm = r.email.toLowerCase().trim();
    const fd = domainOf(fm);
    const ok = FREE_MAIL.has(fd) ? input.contactEmails.some((e) => e.toLowerCase().trim() === fm) : input.contactEmails.some((e) => domainOf(e) === fd);
    add("CONTACT_MATCH", ok ? "PASS" : "REVIEW", ok ? "Account email matches FMCSA" : "Account email doesn't match FMCSA", ok ? undefined : `FMCSA lists ${maskEmail(fm)}. Call the carrier at the FMCSA phone number${r.phone ? ` (${r.phone})` : ""}, not one they gave you, to confirm it's them.`);
  }

  // Hijacked carriers often have their phone, email or address changed right before the fraud.
  const recent = (input.history ?? []).filter((h) => days(h.fetchedAt, input.now) <= 90);
  const changed = new Set<string>();
  for (const h of recent) {
    if (digits(h.phone) && digits(h.phone) !== digits(r.phone)) changed.add("phone");
    if (h.email && h.email.toLowerCase() !== (r.email ?? "").toLowerCase()) changed.add("email");
    if (h.address?.street && `${h.address.street}|${h.address.postalCode}`.toLowerCase() !== `${r.address?.street}|${r.address?.postalCode}`.toLowerCase()) changed.add("address");
    if (nameKey(h.legalName) !== nameKey(r.legalName)) changed.add("legal name");
  }
  if (changed.size) add("RECENT_CHANGES", "REVIEW", `FMCSA ${[...changed].join(", ")} changed recently`, "Contact details changed in the last 90 days. Confirm with the carrier using details you had before the change.");

  if (input.otherOrgsWithDot) add("DUPLICATE_DOT", "REVIEW", "USDOT used by another company here", `${input.otherOrgsWithDot} other compan${input.otherOrgsWithDot === 1 ? "y" : "ies"} on Logistics Pro claim USDOT ${r.dotNumber}. Only one is the real carrier.`);

  return finish(checks, r.fetchedAt);
}

function finish(checks: VettingCheck[], checkedAt: string): VettingResult {
  const verdict = checks.some((c) => c.result === "FAIL") ? "FAIL" : checks.some((c) => c.result === "REVIEW") ? "REVIEW" : "PASS";
  return { verdict, checks, checkedAt };
}

function maskEmail(e: string): string {
  const [user, domain] = e.split("@");
  if (!user || !domain) return e;
  return `${user.slice(0, 2)}${"•".repeat(Math.max(1, user.length - 2))}@${domain}`;
}
