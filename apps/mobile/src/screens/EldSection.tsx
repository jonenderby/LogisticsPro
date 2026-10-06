import { tx } from "@logisticspro/workspace";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import { Banner, Body, Button, Chip, Field, Padded, Row, Section, Segmented } from "../ui/components";
import { confirm, notify } from "../ui/dialog";
import { ELD_NAME } from "../ui/Hos";
import { when } from "../ui/format";
import { useT } from "../state/MeProvider";

type Provider = keyof typeof ELD_NAME;
interface EldView {
  connected: boolean;
  provider?: Provider;
  label?: string;
  connectedAt?: string;
  lastSyncAt?: string;
  lastError?: string;
  vehicles?: number;
  drivers?: Array<{ externalId: string; name: string; email?: string; accountId?: string; accountName?: string; match?: "AUTO" | "MANUAL"; clock?: { driveLeftMin: number; asOf: string } }>;
  members: Array<{ accountId: string; name: string }>;
}

const HELP: Record<Provider, string> = {
  MOTIVE: tx("In Motive, go to Admin, then API keys, and create a key with read access."),
  SAMSARA: tx("In Samsara, go to Settings, then API Tokens, and create a token that can read drivers, vehicles and hours of service."),
  GEOTAB: tx("Use a MyGeotab service account that can read users, devices and hours of service."),
};

/**
 * A carrier's ELD account. Once connected, drivers' hours come from the ELD
 * and trucks' GPS feeds tracking, ETAs and fuel-tax miles.
 */
export function EldSection({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const t = useT();
  const [eld, setEld] = useState<EldView>();
  const [provider, setProvider] = useState<Provider>("SAMSARA");
  const [apiKey, setApiKey] = useState("");
  const [geotab, setGeotab] = useState({ server: "my.geotab.com", database: "", userName: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState<string>();
  const load = useCallback(async () => setEld(await api.get<EldView>(`/v1/orgs/${orgId}/eld`).catch(() => undefined)), [orgId]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!eld) return null;
  const run = (fn: () => Promise<EldView>, ok?: string) => async () => {
    try {
      setBusy(true);
      setEld(await fn());
      if (ok) notify(ok);
    } catch (e) {
      notify(t("Couldn't update the ELD"), errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!eld.connected) {
    if (!canManage) return null;
    return (
      <Section title="ELD" footer={t("Connect your ELD so drivers' hours come from the legal record and trucks' GPS keeps tracking going with the app closed. Keys are stored encrypted and never shown again.")}>
        <Padded>
          <Segmented<Provider> options={(Object.keys(ELD_NAME) as Provider[]).map((p) => ({ value: p, label: ELD_NAME[p] }))} value={provider} onChange={setProvider} />
          <Body secondary style={{ marginVertical: 8 }}>{t(HELP[provider])}</Body>
          {provider === "GEOTAB" ? (
            <>
              <Field label={t("Server")} value={geotab.server} onChangeText={(v) => setGeotab({ ...geotab, server: v })} autoCapitalize="none" />
              <Field label={t("Database")} value={geotab.database} onChangeText={(v) => setGeotab({ ...geotab, database: v })} autoCapitalize="none" />
              <Field label={t("User name")} value={geotab.userName} onChangeText={(v) => setGeotab({ ...geotab, userName: v })} autoCapitalize="none" />
              <Field label={t("Password")} value={geotab.password} onChangeText={(v) => setGeotab({ ...geotab, password: v })} secureTextEntry />
            </>
          ) : (
            <Field label={t(provider === "MOTIVE" ? "Motive API key" : "Samsara API token")} value={apiKey} onChangeText={setApiKey} autoCapitalize="none" secureTextEntry />
          )}
          <Button
            title={t("Connect {name}", { name: ELD_NAME[provider] })}
            loading={busy}
            disabled={provider === "GEOTAB" ? !geotab.database || !geotab.userName || !geotab.password : apiKey.trim().length < 8}
            onPress={run(async () => {
              const v = await api.put<EldView>(`/v1/orgs/${orgId}/eld`, provider === "GEOTAB" ? { provider, ...geotab } : { provider, apiKey: apiKey.trim() });
              setApiKey("");
              setGeotab({ ...geotab, password: "" });
              return v;
            }, t("ELD connected"))}
          />
        </Padded>
      </Section>
    );
  }

  const unmatched = eld.drivers?.filter((d) => !d.accountId) ?? [];
  return (
    <Section title={`ELD · ${ELD_NAME[eld.provider!]}`} footer={t("Drivers are matched by email, CDL number or name. Hours and truck locations update every five minutes.")}>
      {eld.lastError ? <Banner tone="danger" title={t("Last sync failed")} message={eld.lastError} /> : null}
      <Row title={eld.label ?? t("Connected")} subtitle={t("{n} trucks reporting · last sync {time}", { n: eld.vehicles ?? 0, time: eld.lastSyncAt ? when(eld.lastSyncAt) : t("never") })} />
      {eld.drivers?.map((d) => (
        <View key={d.externalId}>
          <Row
            title={d.name}
            subtitle={d.accountId ? `${d.accountName}${d.match === "MANUAL" ? ` ${t("(linked by hand)")}` : ""}${d.clock ? ` · ${t("{h} h {m} min to drive", { h: Math.floor(d.clock.driveLeftMin / 60), m: d.clock.driveLeftMin % 60 })}` : ""}` : t("Not linked to a driver here")}
            right={<Chip label={t(d.accountId ? "Linked" : "Link")} tone={d.accountId ? "success" : "warning"} onPress={() => setLinking(linking === d.externalId ? undefined : d.externalId)} />}
          />
          {linking === d.externalId ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingBottom: 12 }}>
              {eld.members.map((m) => (
                <Chip key={m.accountId} label={m.name} selected={m.accountId === d.accountId} onPress={() => void run(async () => (await api.put<EldView>(`/v1/orgs/${orgId}/eld/drivers/${d.externalId}`, { accountId: m.accountId })))().then(() => setLinking(undefined))} />
              ))}
              {d.accountId ? <Chip label={t("Unlink")} tone="danger" onPress={() => void run(async () => api.put<EldView>(`/v1/orgs/${orgId}/eld/drivers/${d.externalId}`, { accountId: null }))().then(() => setLinking(undefined))} /> : null}
            </View>
          ) : null}
        </View>
      ))}
      {unmatched.length ? <Body secondary style={{ marginHorizontal: 16, marginTop: 8 }}>{t(unmatched.length === 1 ? "{n} ELD driver isn't linked. Tap Link to choose who they are here." : "{n} ELD drivers aren't linked. Tap Link to choose who they are here.", { n: unmatched.length })}</Body> : null}
      <Padded>
        <Button title={t("Sync now")} variant="tonal" loading={busy} onPress={run(() => api.post<EldView>(`/v1/orgs/${orgId}/eld/sync`, {}))} />
        {canManage ? (
          <Button
            title={t("Disconnect ELD")}
            variant="destructive"
            onPress={async () => {
              if (await confirm(t("Disconnect the ELD?"), t("Drivers' hours go back to estimates from their phones."), t("Disconnect"), true)) await run(() => api.post<EldView>(`/v1/orgs/${orgId}/eld/remove`, {}))();
            }}
          />
        ) : null}
      </Padded>
    </Section>
  );
}
