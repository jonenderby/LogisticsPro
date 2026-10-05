import { useFocusEffect } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import { notify } from "../ui/dialog";
import { useNav, useParams } from "../navigation/types";
import { useMe } from "../state/MeProvider";
import { Banner, Body, Button, Chip, Field, Padded, Row, Screen, Section, Segmented } from "../ui/components";
import { titleCase } from "../ui/format";
import { API_URL } from "../config";

type Method = "API_JSON" | "API_XML" | "EDI_X12";
type Tx = "LOAD_TENDER" | "TENDER_RESPONSE" | "SHIPMENT_STATUS" | "FREIGHT_INVOICE" | "RATE_QUOTE" | "PICKUP_REQUEST";
type EdiTransport = "AS2" | "VAN" | "SFTP";
interface As2In {
  as2Id: string;
  url: string;
  certificatePem: string;
}
interface ChannelIn {
  method: Method;
  transport?: string;
  endpoint?: { url: string; auth?: { type: string; secretRef?: string; header?: string } };
}
interface Profile {
  key: string;
  name: string;
  kind: string;
  scac?: string;
  catalogCode?: string;
  channels: Partial<Record<Tx, ChannelIn>>;
  edi?: { receiverQualifier?: string; receiverId?: string; usage?: string };
  as2?: As2In;
  issues: Array<{ transaction?: string; message: string }>;
  inboundEnabled: boolean;
}
interface CatalogEntry {
  code: string;
  name: string;
  scac: string[];
  confidence: string;
  ttRank2026?: number;
  methods: Partial<Record<Tx, Method[]>>;
  notes?: string;
}

const TX_LABEL: Record<Tx, string> = {
  LOAD_TENDER: "Load tenders (204)",
  TENDER_RESPONSE: "Tender responses (990)",
  SHIPMENT_STATUS: "Shipment status (214)",
  FREIGHT_INVOICE: "Invoices (210)",
  RATE_QUOTE: "Rate quotes",
  PICKUP_REQUEST: "Pickup requests",
};
const METHOD_LABEL: Record<Method, string> = { API_JSON: "JSON", API_XML: "XML", EDI_X12: "EDI" };
const EDI_TX: Tx[] = ["LOAD_TENDER", "TENDER_RESPONSE", "SHIPMENT_STATUS", "FREIGHT_INVOICE"];

interface Draft {
  method: Method | "OFF";
  url: string;
  secretRef: string;
  transport: EdiTransport;
}

function draftsFrom(p: Profile | undefined, txs: Tx[]): Record<Tx, Draft> {
  return Object.fromEntries(txs.map((tx) => {
    const ch = p?.channels[tx];
    return [tx, { method: ch?.method ?? "OFF", url: ch?.endpoint?.url ?? "", secretRef: ch?.endpoint?.auth?.secretRef ?? "", transport: (ch?.method === "EDI_X12" && ch.transport !== "HTTPS" ? ch.transport : "AS2") as EdiTransport }];
  })) as Record<Tx, Draft>;
}

function toChannels(drafts: Record<Tx, Draft>) {
  const out: Partial<Record<Tx, ChannelIn>> = {};
  for (const [tx, d] of Object.entries(drafts) as Array<[Tx, Draft]>) {
    if (d.method === "OFF") continue;
    out[tx] = d.method === "EDI_X12" ? { method: d.method, transport: d.transport } : { method: d.method, transport: "HTTPS", endpoint: { url: d.url, auth: d.secretRef ? { type: "bearer", secretRef: d.secretRef } : { type: "none" } } };
  }
  return out;
}

/** Per-transaction method picker. Every method carries the same required fields. */
function ChannelEditor({ txs, drafts, setDrafts, supported }: { txs: Tx[]; drafts: Record<Tx, Draft>; setDrafts: (d: Record<Tx, Draft>) => void; supported?: Partial<Record<Tx, Method[]>> }) {
  return (
    <>
      {txs.map((tx) => {
        const d = drafts[tx];
        const methods = (supported?.[tx] ?? (EDI_TX.includes(tx) ? ["API_JSON", "API_XML", "EDI_X12"] : ["API_JSON", "API_XML"])) as Method[];
        return (
          <Section key={tx} title={TX_LABEL[tx]}>
            <Padded>
              <Segmented options={[{ value: "OFF", label: "Off" }, ...methods.map((m) => ({ value: m, label: METHOD_LABEL[m] }))]} value={d.method} onChange={(m) => setDrafts({ ...drafts, [tx]: { ...d, method: m as Draft["method"] } })} />
              {d.method === "EDI_X12" ? (
                <Segmented
                  options={[
                    { value: "AS2", label: "AS2 (direct)" },
                    { value: "VAN", label: "VAN" },
                    { value: "SFTP", label: "SFTP" },
                  ]}
                  value={d.transport}
                  onChange={(t) => setDrafts({ ...drafts, [tx]: { ...d, transport: t as EdiTransport } })}
                />
              ) : null}
              {d.method === "API_JSON" || d.method === "API_XML" ? (
                <>
                  <Field label="Endpoint URL" value={d.url} onChangeText={(url) => setDrafts({ ...drafts, [tx]: { ...d, url } })} autoCapitalize="none" keyboardType="url" />
                  <Field label="Secret name (optional)" value={d.secretRef} onChangeText={(s) => setDrafts({ ...drafts, [tx]: { ...d, secretRef: s } })} autoCapitalize="none" hint="Name of the API token stored on the server, never the token itself" />
                </>
              ) : null}
            </Padded>
          </Section>
        );
      })}
    </>
  );
}

const usesAs2 = (drafts: Record<string, Draft>) => Object.values(drafts).some((d) => d.method === "EDI_X12" && d.transport === "AS2");

/** The partner's side of an AS2 connection: their AS2 id, URL and public certificate. */
function As2Fields({ value, onChange }: { value: As2In; onChange: (v: As2In) => void }) {
  return (
    <Section title="Partner AS2 connection" footer="Ask the partner for these three values. They need ours in return (shown under Our AS2 station).">
      <Padded>
        <Field label="Partner AS2 id" value={value.as2Id} onChangeText={(t) => onChange({ ...value, as2Id: t.trim() })} autoCapitalize="characters" autoCorrect={false} />
        <Field label="Partner AS2 URL" value={value.url} onChangeText={(t) => onChange({ ...value, url: t.trim() })} autoCapitalize="none" keyboardType="url" />
        <Field label="Partner certificate (PEM)" value={value.certificatePem} onChangeText={(t) => onChange({ ...value, certificatePem: t })} multiline autoCapitalize="none" autoCorrect={false} placeholder="-----BEGIN CERTIFICATE-----" />
      </Padded>
    </Section>
  );
}

interface Station {
  as2Id: string;
  url: string;
  certificateUrl: string;
  certificatePem: string;
  fingerprintSha256: string;
}

/** What every partner needs to connect to Logistics Pro by AS2. One connection serves every business here. */
function StationSection() {
  const [station, setStation] = useState<Station>();
  useFocusEffect(
    useCallback(() => {
      void api.get<Station>("/v1/integrations/as2").then(setStation).catch(() => undefined);
    }, []),
  );
  if (!station) return null;
  return (
    <Section title="Our AS2 station" footer="Partners set up one AS2 connection to Logistics Pro using these details, then reach every business here. Messages are signed and encrypted, and receipts (MDNs) are returned immediately.">
      <Row title="AS2 id" value={station.as2Id} onPress={() => Clipboard.setStringAsync(station.as2Id)} chevron={false} />
      <Row title="AS2 URL" subtitle={station.url} onPress={() => Clipboard.setStringAsync(station.url)} chevron={false} />
      <Row title="Certificate" subtitle={`SHA-256 ${station.fingerprintSha256.slice(0, 23)}…`} value="Copy" onPress={() => Clipboard.setStringAsync(station.certificatePem)} chevron={false} />
      <Row title="Download certificate" subtitle={station.certificateUrl} onPress={() => Linking.openURL(station.certificateUrl)} />
    </Section>
  );
}

const emptyAs2: As2In = { as2Id: "", url: "", certificatePem: "" };
const as2Payload = (a: As2In) => (a.as2Id && a.url && a.certificatePem ? a : undefined);

export function IntegrationsScreen() {
  const { me, orgsWithRole } = useMe();
  const nav = useNav();
  const orgs = orgsWithRole("OWNER", "ADMIN", "INTEGRATIONS");
  const [orgId, setOrgId] = useState(orgs[0]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [drafts, setDrafts] = useState<Record<Tx, Draft>>(draftsFrom(undefined, EDI_TX));
  const [ediId, setEdiId] = useState("");
  const [ediQual, setEdiQual] = useState("ZZ");
  const [as2In, setAs2In] = useState<As2In>(emptyAs2);

  const refresh = useCallback(async () => {
    if (!orgId) return;
    const [p, c] = await Promise.all([api.get<Profile[]>(`/v1/orgs/${orgId}/partners`), api.get<CatalogEntry[]>("/v1/integrations/catalog")]);
    setProfiles(p);
    setCatalog(c);
    const receiving = p.find((x) => x.key === "receiving");
    setDrafts(draftsFrom(receiving, EDI_TX));
    setEdiId(receiving?.edi?.receiverId ?? "");
    setEdiQual(receiving?.edi?.receiverQualifier ?? "ZZ");
    setAs2In(receiving?.as2 ?? emptyAs2);
  }, [orgId]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  if (!orgId) return <Banner tone="info" title="Integrations belong to a company" message="Register a company first." />;
  const partners = profiles.filter((p) => p.key !== "receiving");
  const usesEdi = Object.values(drafts).some((d) => d.method === "EDI_X12");

  return (
    <Screen onRefresh={refresh}>
      {orgs.length > 1 ? (
        <View style={{ flexDirection: "row", gap: 8, margin: 16, flexWrap: "wrap" }}>
          {orgs.map((id) => (
            <Chip key={id} label={me?.orgs.find((o) => o.id === id)?.name ?? id} selected={id === orgId} onPress={() => setOrgId(id)} />
          ))}
        </View>
      ) : null}
      <StationSection />
      <Banner tone="info" title="How your systems receive data" message="Anyone on Logistics Pro who works with you sends through these settings. Your partners need no setup of their own." />
      <ChannelEditor txs={EDI_TX} drafts={drafts} setDrafts={setDrafts} />
      {usesEdi ? (
        <Section title="Your EDI interchange id">
          <Padded>
            <Field label="Qualifier" value={ediQual} onChangeText={setEdiQual} maxLength={2} autoCapitalize="characters" />
            <Field label="Interchange id" value={ediId} onChangeText={(t) => setEdiId(t.toUpperCase())} maxLength={15} autoCapitalize="characters" />
          </Padded>
        </Section>
      ) : null}
      {usesAs2(drafts) ? <As2Fields value={as2In} onChange={setAs2In} /> : null}
      <View style={{ margin: 16 }}>
        <Button
          title="Save receiving preferences"
          onPress={async () => {
            try {
              await api.put(`/v1/orgs/${orgId}/receiving`, { channels: toChannels(drafts), edi: usesEdi ? { receiverQualifier: ediQual, receiverId: ediId } : undefined, as2: usesAs2(drafts) ? as2Payload(as2In) : undefined });
              await refresh();
              notify("Saved");
            } catch (e) {
              notify("Couldn't save", errorMessage(e));
            }
          }}
        />
      </View>

      <Section title="Trading partners" footer="Partners who are not on Logistics Pro, such as carriers reached by API or EDI.">
        {partners.length === 0 ? <Row title="No partners yet" subtitle="Add one from the carrier catalog below." /> : null}
        {partners.map((p) => (
          <Row key={p.key} title={p.name} subtitle={Object.entries(p.channels).map(([tx, ch]) => `${TX_LABEL[tx as Tx].split(" (")[0]}: ${METHOD_LABEL[ch!.method]}`).join(" · ")} right={p.issues.length ? <Chip label={`${p.issues.length} to fix`} tone="warning" /> : <Chip label="Ready" tone="success" />} onPress={() => nav.navigate("PartnerEdit", { orgId, key: p.key })} />
        ))}
      </Section>

      <Section title="Carrier catalog" footer="Defaults prefer JSON APIs, then XML APIs, then EDI. Change any transaction per partner.">
        {catalog.map((c) => {
          const added = partners.some((p) => p.key === c.code);
          return (
            <Row
              key={c.code}
              title={`${c.ttRank2026 ? `#${c.ttRank2026} ` : ""}${c.name}`}
              subtitle={`${c.scac.join(", ") || "SCAC at onboarding"} · ${titleCase(c.confidence)}`}
              right={added ? <Chip label="Added" tone="success" /> : <Button title="Add" variant="tonal" style={{ minHeight: 36 }} onPress={async () => { await api.post(`/v1/orgs/${orgId}/partners/from-catalog/${c.code}`).catch((e) => notify("Couldn't add", errorMessage(e))); await refresh(); }} />}
            />
          );
        })}
      </Section>
    </Screen>
  );
}

export function PartnerEditScreen() {
  const { orgId, key } = useParams<"PartnerEdit">();
  const nav = useNav();
  const [profile, setProfile] = useState<Profile>();
  const [entry, setEntry] = useState<CatalogEntry>();
  const [drafts, setDrafts] = useState<Record<Tx, Draft>>();
  const [ediId, setEdiId] = useState("");
  const [ediQual, setEdiQual] = useState("02");
  const [scac, setScac] = useState("");
  const [token, setToken] = useState<string>();
  const [as2In, setAs2In] = useState<As2In>(emptyAs2);

  const refresh = useCallback(async () => {
    const [ps, cat] = await Promise.all([api.get<Profile[]>(`/v1/orgs/${orgId}/partners`), api.get<CatalogEntry[]>("/v1/integrations/catalog")]);
    const p = ps.find((x) => x.key === key);
    const e = cat.find((c) => c.code === p?.catalogCode);
    setProfile(p);
    setEntry(e);
    const txs = (e ? Object.keys(e.methods) : [...EDI_TX, "RATE_QUOTE", "PICKUP_REQUEST"]) as Tx[];
    setDrafts(draftsFrom(p, txs));
    setEdiId(p?.edi?.receiverId ?? p?.scac ?? "");
    setEdiQual(p?.edi?.receiverQualifier ?? "02");
    setScac(p?.scac ?? "");
    setAs2In(p?.as2 ?? emptyAs2);
    nav.setOptions({ title: p?.name ?? key });
  }, [orgId, key, nav]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  if (!profile || !drafts) return null;
  const usesEdi = Object.values(drafts).some((d) => d.method === "EDI_X12");

  return (
    <Screen onRefresh={refresh}>
      {profile.issues.length ? <Banner tone="warning" title="Finish setup" message={profile.issues.map((i) => `${i.transaction ? `${TX_LABEL[i.transaction as Tx]}: ` : ""}${i.message}`).join("\n")} /> : <Banner tone="success" title="Ready to exchange data" />}
      {entry?.notes ? <Banner tone="neutral" title="About this carrier" message={entry.notes} /> : null}
      <Section title="Partner">
        <Padded>
          <Field label="SCAC" value={scac} onChangeText={(t) => setScac(t.toUpperCase())} maxLength={4} autoCapitalize="characters" />
        </Padded>
      </Section>
      <ChannelEditor txs={Object.keys(drafts) as Tx[]} drafts={drafts} setDrafts={setDrafts} supported={entry?.methods} />
      {usesEdi ? (
        <Section title="Partner EDI interchange id">
          <Padded>
            <Field label="Qualifier" value={ediQual} onChangeText={setEdiQual} maxLength={2} autoCapitalize="characters" />
            <Field label="Interchange id" value={ediId} onChangeText={(t) => setEdiId(t.toUpperCase())} maxLength={15} autoCapitalize="characters" />
          </Padded>
        </Section>
      ) : null}
      {usesAs2(drafts) ? <As2Fields value={as2In} onChange={setAs2In} /> : null}
      <View style={{ margin: 16, gap: 10 }}>
        <Button
          title="Save partner"
          onPress={async () => {
            try {
              await api.put(`/v1/orgs/${orgId}/partners/${key}`, { name: profile.name, kind: profile.kind, scac: scac || undefined, catalogCode: profile.catalogCode, channels: toChannels(drafts), edi: usesEdi ? { receiverQualifier: ediQual, receiverId: ediId } : undefined, as2: usesAs2(drafts) ? as2Payload(as2In) : undefined });
              await refresh();
            } catch (e) {
              notify("Couldn't save", errorMessage(e));
            }
          }}
        />
        <Button title={profile.inboundEnabled ? "Rotate inbound token" : "Let this partner send to us"} variant="tonal" onPress={async () => setToken((await api.post<{ inboundToken: string }>(`/v1/orgs/${orgId}/partners/${key}/inbound-token`)).inboundToken)} />
      </View>
      {token ? (
        <Section title="Inbound connection" footer="Share these with the partner once. The token is not shown again.">
          <Padded>
            <Body>EDI: POST {API_URL}/v1/inbound/{orgId}/{key}/edi</Body>
            <Body>API: POST {API_URL}/v1/inbound/{orgId}/{key}/shipment_status (or any transaction)</Body>
            <Body>Header x-lp-inbound-token: {token}</Body>
            <Button title="Copy token" variant="tonal" onPress={() => Clipboard.setStringAsync(token)} />
          </Padded>
        </Section>
      ) : null}
    </Screen>
  );
}
