import type { Account, Membership, Organization } from "@logisticspro/domain";

/**
 * What a person can do, derived from who they are (driver profile) and the
 * organizations they belong to. The app is built from capabilities, never
 * from a single "current role", so an owner-operator never switches modes.
 */
export type Capability =
  | "DRIVE"
  | "DISPATCH"
  | "BID"
  | "MANAGE_FLEET"
  | "SHIP"
  | "BROKER"
  | "INVOICE"
  | "PAY"
  | "MANAGE_INTEGRATIONS"
  | "MANAGE_ORG"
  | "MESSAGE"
  | "REGISTER_COMPANY";

export interface CapabilityContext {
  account: Pick<Account, "id" | "profileType" | "driver">;
  memberships: Membership[];
  orgs: Organization[];
}

export interface ResolvedCapabilities {
  all: Set<Capability>;
  /** Org ids that grant each capability (e.g. which carrier you dispatch for). */
  byOrg: Map<string, Set<Capability>>;
  ownerOperator: boolean;
}

export function resolveCapabilities(ctx: CapabilityContext): ResolvedCapabilities {
  const all = new Set<Capability>(["MESSAGE"]);
  const byOrg = new Map<string, Set<Capability>>();
  const grant = (orgId: string, ...caps: Capability[]) => {
    const set = byOrg.get(orgId) ?? new Set<Capability>();
    caps.forEach((c) => {
      set.add(c);
      all.add(c);
    });
    byOrg.set(orgId, set);
  };

  if (ctx.account.driver || ctx.account.profileType === "TRUCKER") {
    all.add("DRIVE");
    all.add("INVOICE");
  }
  let ownsCarrier = false;
  for (const m of ctx.memberships.filter((x) => x.accountId === ctx.account.id)) {
    const org = ctx.orgs.find((o) => o.id === m.orgId);
    if (!org) continue;
    const admin = m.roles.includes("OWNER") || m.roles.includes("ADMIN");
    if (admin) grant(org.id, "MANAGE_ORG", "MANAGE_INTEGRATIONS", "PAY");
    if (m.roles.includes("INTEGRATIONS")) grant(org.id, "MANAGE_INTEGRATIONS");
    if (m.roles.includes("BILLING")) grant(org.id, "INVOICE", "PAY");
    if (m.roles.includes("DRIVER")) grant(org.id, "DRIVE", "INVOICE");
    if (org.kinds.includes("CARRIER")) {
      if (admin || m.roles.includes("DISPATCHER")) grant(org.id, "DISPATCH", "BID");
      if (admin) grant(org.id, "MANAGE_FLEET", "INVOICE");
      if (m.roles.includes("OWNER")) ownsCarrier = true;
    }
    if (org.kinds.includes("SHIPPER") && !m.roles.every((r) => r === "DRIVER")) grant(org.id, "SHIP");
    if (org.kinds.includes("BROKER_3PL") && !m.roles.every((r) => r === "DRIVER")) grant(org.id, "BROKER", "SHIP");
  }
  if (byOrg.size === 0) all.add("REGISTER_COMPANY");
  return { all, byOrg, ownerOperator: ownsCarrier && all.has("DRIVE") };
}
