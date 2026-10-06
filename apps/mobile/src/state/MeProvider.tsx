import { type Lang, type Translate, langOf, translator } from "@logisticspro/workspace";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
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
  /** The app's language: the account's choice, else the device's. */
  lang: Lang;
  t: Translate;
  setLanguage(lang: Lang): Promise<void>;
}

/** The device's language, for before sign-in and until the person picks one. */
export const deviceLang = (): Lang => {
  try {
    return langOf(typeof navigator !== "undefined" && navigator.language ? navigator.language : Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return "en";
  }
};

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

  const lang: Lang = (me?.account as { language?: Lang } | undefined)?.language ?? deviceLang();
  const t = useMemo(() => translator(lang), [lang]);
  const setLanguage = useCallback(
    async (language: Lang) => {
      await api.put("/v1/me/preferences", { language });
      await refresh();
    },
    [refresh],
  );
  // The server translates the Today feed and push notifications; tell it the device's language once.
  useEffect(() => {
    if (me && !(me.account as { language?: Lang }).language && deviceLang() !== "en") void setLanguage(deviceLang()).catch(() => undefined);
  }, [me, setLanguage]);

  const orgsWithRole = useCallback((...roles: string[]) => (me?.orgs ?? []).filter((o) => o.roles.some((r) => roles.includes(r))).map((o) => o.id), [me]);

  const value: MeApi = {
    lang,
    t,
    setLanguage,
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

/** Translate in any component, signed in or not. */
export function useT(): Translate {
  const v = useContext(Ctx);
  return v?.t ?? translator(deviceLang());
}
