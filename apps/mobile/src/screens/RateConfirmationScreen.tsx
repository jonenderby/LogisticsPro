import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Platform, Share } from "react-native";
import { tx } from "@logisticspro/workspace";
import { api, errorMessage } from "../api/client";
import { useParams } from "../navigation/types";
import { useMe, useT } from "../state/MeProvider";
import { Banner, Body, Button, Chip, Empty, Padded, Row, Screen, Section } from "../ui/components";
import { notify } from "../ui/dialog";
import { money, titleCase, when } from "../ui/format";

interface Party {
  orgId?: string;
  partnerKey?: string;
  name: string;
  scac?: string;
  mcNumber?: string;
  dotNumber?: string;
}
export interface RateCon {
  id: string;
  loadNumber: string;
  version: number;
  status: "SIGNED" | "AWAITING_CARRIER" | "SUPERSEDED" | "VOID";
  tendering: Party;
  carrier: Party;
  stops: Array<{ sequence: number; type: string; address: { name: string; city: string; state: string }; window: { start: string; end: string } }>;
  equipment: string;
  service: string;
  teamRequired: boolean;
  commodity: { description: string; pieces: number; weightLb: number; hazmat: boolean };
  rate: { amount: number; currency: string };
  accessorials: string[];
  detention: { freeHours: number; ratePerHour: number };
  payment: { days: number; quickPay?: { days: number; feePct: number } };
  terms: string[];
  hash: string;
  signatures: Array<{ side: "TENDERING" | "CARRIER"; name: string; at: string; method: string }>;
  changes: string[];
  createdAt: string;
}
interface Versions {
  current?: RateCon;
  versions: Array<{ version: number; status: RateCon["status"]; createdAt: string; changes: string[] }>;
}

export const RATE_CON_STATUS: Record<RateCon["status"], { label: string; tone: "success" | "warning" | "neutral" | "danger" }> = {
  SIGNED: { label: tx("Signed"), tone: "success" },
  AWAITING_CARRIER: { label: tx("Needs carrier signature"), tone: "warning" },
  SUPERSEDED: { label: tx("Replaced"), tone: "neutral" },
  VOID: { label: tx("Void"), tone: "danger" },
};

const ids = (p: Party) => [p.mcNumber && `MC ${p.mcNumber}`, p.dotNumber && `USDOT ${p.dotNumber}`, p.scac && `SCAC ${p.scac}`].filter(Boolean).join(" · ") || undefined;

/**
 * The agreement for a load, signed by the shipper or broker when tendering
 * and by the carrier when accepting. A revised version waits here for the
 * carrier to sign. On the website it prints or saves as a PDF.
 */
export function RateConfirmationScreen() {
  const t = useT();
  const { loadId } = useParams<"RateConfirmation">();
  const { orgsWithRole } = useMe();
  const [data, setData] = useState<Versions>();
  const [version, setVersion] = useState<number>();
  const [rc, setRc] = useState<RateCon>();

  const load = useCallback(async () => {
    const d = await api.get<Versions>(`/v1/loads/${loadId}/rate-confirmation`).catch(() => undefined);
    setData(d);
    setRc(d?.current);
    setVersion(d?.current?.version);
  }, [loadId]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const show = async (v: number) => {
    setVersion(v);
    setRc((await api.get<Versions>(`/v1/loads/${loadId}/rate-confirmation?version=${v}`).catch(() => undefined))?.current);
  };

  if (!data) return <Screen><Empty title={t("Loading…")} /></Screen>;
  if (!rc) return <Screen><Empty title={t("No rate confirmation yet")} message={t("It is written and signed when the carrier accepts the tender.")} /></Screen>;
  const canSign = rc.status === "AWAITING_CARRIER" && !!rc.carrier.orgId && orgsWithRole("OWNER", "ADMIN", "DISPATCHER").includes(rc.carrier.orgId) && version === data.current?.version;

  const sign = async () => {
    try {
      await api.post(`/v1/loads/${loadId}/rate-confirmation/sign`, {});
      await load();
      notify(t("Signed"), t("Rate confirmation v{n} is in force.", { n: rc.version }));
    } catch (e) {
      notify(t("Couldn't sign"), errorMessage(e));
    }
  };
  const print = async () => {
    const html = await api.get<string>(`/v1/loads/${loadId}/rate-confirmation?version=${rc.version}&format=html`).catch(() => undefined);
    if (!html) return;
    if (Platform.OS === "web") {
      const w = window.open("", "_blank");
      if (!w) return notify(t("Allow pop-ups"), t("Your browser blocked the print window."));
      w.document.write(html);
      w.document.close();
      w.focus();
      w.print();
      return;
    }
    await Share.share({
      title: t("Rate confirmation {n}", { n: rc.loadNumber }),
      message: `${t("Rate confirmation {n}", { n: rc.loadNumber })} v${rc.version}\n${t("{from} to {to}", { from: rc.tendering.name, to: rc.carrier.name })}\n${rc.stops.map((s) => `${s.sequence}. ${t(titleCase(s.type))} ${s.address.name}, ${s.address.city} ${s.address.state} ${when(s.window.start)}`).join("\n")}\n${t("Rate")} ${money(rc.rate.amount, rc.rate.currency)}\n${t("Fingerprint")} ${rc.hash}`,
    });
  };

  return (
    <Screen onRefresh={load}>
      {rc.status === "AWAITING_CARRIER" ? <Banner tone="warning" title={t("Version {n} needs the carrier's signature", { n: rc.version })} message={rc.changes.length ? t("Changed: {list}.", { list: rc.changes.map((c) => t(c)).join(", ") }) : undefined} /> : null}
      {rc.status === "VOID" ? <Banner tone="danger" title={t("Void")} message={t("The carrier was released or the load cancelled.")} /> : null}
      <Section title={`${rc.loadNumber} · ${t("version {n}", { n: rc.version })}`}>
        <Row title={t("Status")} right={<Chip label={RATE_CON_STATUS[rc.status].label} tone={RATE_CON_STATUS[rc.status].tone} />} />
        <Row title={t("Shipper or broker")} subtitle={[rc.tendering.name, ids(rc.tendering)].filter(Boolean).join("\n")} />
        <Row title={t("Carrier")} subtitle={[rc.carrier.name, ids(rc.carrier)].filter(Boolean).join("\n")} />
        <Row title={t("All-in rate")} value={money(rc.rate.amount, rc.rate.currency)} />
        <Row title={t("Detention")} value={t("{hours} h free, then {rate}/h", { hours: rc.detention.freeHours, rate: money(rc.detention.ratePerHour) })} />
        <Row title={t("Payment")} value={`${t("{n} days", { n: rc.payment.days })}${rc.payment.quickPay ? ` · ${t("quick pay {n} days at {fee}%", { n: rc.payment.quickPay.days, fee: rc.payment.quickPay.feePct })}` : ""}`} />
      </Section>
      <Section title={t("Stops")}>
        {rc.stops.map((s) => (
          <Row key={s.sequence} title={`${s.sequence}. ${t(titleCase(s.type))} · ${s.address.name}`} subtitle={`${s.address.city}, ${s.address.state}\n${when(s.window.start)} – ${when(s.window.end)}`} />
        ))}
      </Section>
      <Section title={t("Freight")}>
        <Row title={t("Equipment")} value={`${rc.equipment}${rc.teamRequired ? ` · ${t("team")}` : ""}`} />
        <Row title={t("Commodity")} subtitle={`${rc.commodity.description} · ${t("{n} pieces", { n: rc.commodity.pieces })} · ${rc.commodity.weightLb.toLocaleString()} lb${rc.commodity.hazmat ? ` · ${t("hazmat")}` : ""}`} />
        {rc.accessorials.length ? <Row title={t("Accessorials")} subtitle={rc.accessorials.join(", ")} /> : null}
      </Section>
      <Section title={t("Terms")}>
        {rc.terms.map((t, i) => (
          <Row key={i} title={`${i + 1}.`} subtitle={t} />
        ))}
      </Section>
      <Section title={t("Signatures")} footer={t("Content fingerprint (SHA-256): {hash}", { hash: rc.hash })}>
        {rc.signatures.map((s, i) => (
          <Row key={i} title={s.name} subtitle={`${t(s.side === "CARRIER" ? "Carrier" : "Shipper or broker")} · ${when(s.at)} · ${t(s.method === "TENDER" ? "by tendering" : s.method === "ACCEPTANCE" ? "by accepting the tender" : s.method === "PARTNER_RESPONSE" ? "by EDI or API response" : "signed in the app")}`} />
        ))}
        {rc.status === "AWAITING_CARRIER" && rc.signatures.every((s) => s.side !== "CARRIER") ? <Row title={t("Carrier")} subtitle={t("Not signed yet")} /> : null}
      </Section>
      <Padded>
        {canSign ? <Button title={t("Sign version {n}", { n: rc.version })} onPress={sign} /> : null}
        <Button title={t(Platform.OS === "web" ? "Print or save as PDF" : "Share")} variant="tonal" onPress={print} />
      </Padded>
      {data.versions.length > 1 ? (
        <Section title={t("Versions")}>
          {[...data.versions].reverse().map((v) => (
            <Row key={v.version} title={t("Version {n}", { n: v.version })} subtitle={`${when(v.createdAt)}${v.changes.length ? ` · ${v.changes.map((c) => t(c)).join(", ")}` : ""}`} right={<Chip label={RATE_CON_STATUS[v.status].label} tone={RATE_CON_STATUS[v.status].tone} selected={v.version === version} />} onPress={() => void show(v.version)} />
          ))}
        </Section>
      ) : null}
      <Body secondary style={{ margin: 16 }}>{t("Signed electronically. The fingerprint changes if anything on the confirmation changes.")}</Body>
    </Screen>
  );
}
