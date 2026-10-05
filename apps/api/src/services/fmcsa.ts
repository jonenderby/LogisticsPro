import { readFileSync } from "node:fs";
import { type AuthorityStatus, FmcsaRecord } from "@logisticspro/domain";

/** Looks up a carrier in the FMCSA registry by USDOT number. */
export interface FmcsaClient {
  lookup(dotNumber: string): Promise<FmcsaRecord | undefined>;
}

type Fetch = typeof fetch;
const BASE = "https://mobile.fmcsa.dot.gov/qc/services";

const status = (s: unknown): AuthorityStatus => (s === "A" ? "ACTIVE" : s === "I" ? "INACTIVE" : s === "P" ? "PENDING" : "NONE");
const thousands = (v: unknown): number | undefined => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || Number.isNaN(n) ? undefined : n * 1000;
};
const str = (v: unknown): string | undefined => (v === null || v === undefined || String(v).trim() === "" ? undefined : String(v).trim());
const RATING: Record<string, FmcsaRecord["safetyRating"]> = { S: "SATISFACTORY", C: "CONDITIONAL", U: "UNSATISFACTORY" };

/**
 * FMCSA's QCMobile API (free; register for a web key at
 * mobile.fmcsa.dot.gov/QCDevsite). It gives operating status, authority,
 * insurance on file, safety rating and address. It does not give the
 * carrier's email or when its authority was granted; those checks are
 * skipped unless another source fills them in.
 */
export class QcMobileFmcsa implements FmcsaClient {
  constructor(
    private readonly webKey: string,
    private readonly fetcher: Fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async get(path: string): Promise<{ content?: unknown } | undefined> {
    const res = await this.fetcher(`${BASE}${path}${path.includes("?") ? "&" : "?"}webKey=${encodeURIComponent(this.webKey)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`FMCSA ${res.status}`);
    return (await res.json()) as { content?: unknown };
  }

  async lookup(dotNumber: string): Promise<FmcsaRecord | undefined> {
    const dot = dotNumber.replace(/\D/g, "");
    if (!dot) return undefined;
    const [carrierRes, authorityRes, docketRes] = await Promise.all([this.get(`/carriers/${dot}`), this.get(`/carriers/${dot}/authority`).catch(() => undefined), this.get(`/carriers/${dot}/docket-numbers`).catch(() => undefined)]);
    const c = (carrierRes?.content as { carrier?: Record<string, unknown> } | undefined)?.carrier;
    if (!c) return undefined;
    const auths = ((authorityRes?.content as Array<{ carrierAuthority?: Record<string, unknown> }> | undefined) ?? []).map((a) => a.carrierAuthority ?? {});
    const best = (key: string): AuthorityStatus => {
      const all = auths.map((a) => status(a[key]));
      return all.includes("ACTIVE") ? "ACTIVE" : all.includes("PENDING") ? "PENDING" : all.includes("INACTIVE") ? "INACTIVE" : "NONE";
    };
    const dockets = ((docketRes?.content as Array<Record<string, unknown>> | undefined) ?? []).filter((d) => d.prefix === "MC").map((d) => String(d.docketNumber));
    return {
      dotNumber: dot,
      mcNumbers: [...new Set([...dockets, ...auths.filter((a) => a.prefix === "MC" && a.docketNumber).map((a) => String(a.docketNumber))])],
      legalName: str(c.legalName) ?? "",
      dbaName: str(c.dbaName),
      phone: str(c.telephone) ?? str(c.phone),
      email: str(c.emailAddress),
      address: { street: str(c.phyStreet), city: str(c.phyCity), state: str(c.phyState), postalCode: str(c.phyZipcode) },
      allowedToOperate: c.allowedToOperate === "Y",
      outOfService: !!str(c.oosDate),
      outOfServiceDate: str(c.oosDate),
      authority: { common: best("commonAuthorityStatus"), contract: best("contractAuthorityStatus"), broker: best("brokerAuthorityStatus") },
      insurance: { liabilityOnFileUsd: thousands(c.bipdInsuranceOnFile), liabilityRequiredUsd: thousands(c.bipdRequiredAmount ?? c.bipdInsuranceRequired), cargoOnFileUsd: Number(c.cargoInsuranceOnFile) ? thousands(c.cargoInsuranceOnFile) : undefined },
      safetyRating: RATING[String(c.safetyRating ?? "")] ?? "NOT_RATED",
      powerUnits: Number(c.totalPowerUnits) || undefined,
      drivers: Number(c.totalDrivers) || undefined,
      fetchedAt: this.now().toISOString(),
    };
  }
}

/** A fixed registry, for tests and demos. */
export class StaticFmcsa implements FmcsaClient {
  constructor(public readonly records: Map<string, FmcsaRecord> = new Map()) {}

  /** Records from a JSON array file (LP_FMCSA_FIXTURES). */
  static fromFile(path: string): StaticFmcsa {
    const list = FmcsaRecord.array().parse(JSON.parse(readFileSync(path, "utf8")));
    return new StaticFmcsa(new Map(list.map((r) => [r.dotNumber.replace(/\D/g, ""), r])));
  }
  async lookup(dotNumber: string) {
    return this.records.get(dotNumber.replace(/\D/g, ""));
  }
}
