import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { Load, MeResponse } from "../api/types";

interface MeApi {
  me?: MeResponse;
  error?: string;
  refresh(): Promise<void>;
  has(cap: string): boolean;
  /** Org ids where I hold one of these roles. */
  orgsWithRole(...roles: string[]): string[];
  relation(load: Load): { driver: boolean; dispatcher: boolean; shipper: boolean; billing: boolean };
}

const Ctx = createContext<MeApi | undefined>(undefined);

export function MeProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get<MeResponse>("/v1/me"));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const orgsWithRole = useCallback((...roles: string[]) => (me?.orgs ?? []).filter((o) => o.roles.some((r) => roles.includes(r))).map((o) => o.id), [me]);

  const value: MeApi = {
    me,
    error,
    refresh,
    has: (cap) => !!me?.capabilities.includes(cap),
    orgsWithRole,
    relation: (load) => {
      const id = me?.account.id ?? "";
      const dispatchOrgs = orgsWithRole("OWNER", "ADMIN", "DISPATCHER");
      const shipOrgs = (me?.orgs ?? []).filter((o) => (o.kinds.includes("SHIPPER") || o.kinds.includes("BROKER_3PL")) && !o.roles.every((r) => r === "DRIVER")).map((o) => o.id);
      return {
        driver: load.legs.some((l) => l.driverAccountIds.includes(id)),
        dispatcher: !!load.carrierOrgId && dispatchOrgs.includes(load.carrierOrgId),
        shipper: shipOrgs.includes(load.shipperOrgId) || (!!load.brokerOrgId && shipOrgs.includes(load.brokerOrgId)),
        billing: !!load.carrierOrgId && orgsWithRole("OWNER", "ADMIN", "BILLING").includes(load.carrierOrgId),
      };
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMe(): MeApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMe outside MeProvider");
  return v;
}
