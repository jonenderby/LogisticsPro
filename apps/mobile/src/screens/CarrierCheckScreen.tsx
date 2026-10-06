import { tx } from "@logisticspro/workspace";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import { useNav, useParams } from "../navigation/types";
import { Banner, Body, Button, Chip, Empty, Field, Padded, Row, Screen, Section, ToggleRow, type Tone } from "../ui/components";
import { notify } from "../ui/dialog";
import { money, titleCase, when } from "../ui/format";
import { useT } from "../state/MeProvider";

export type Verdict = "PASS" | "REVIEW" | "FAIL" | "NOT_CHECKED";
interface Check {
  code: string;
  result: "PASS" | "REVIEW" | "FAIL";
  title: string;
  detail?: string;
}
interface Report {
  carrier: { id: string; name: string; dotNumber?: string; mcNumber?: string; scac?: string };
  payerOrgId?: string;
  verdict: Verdict;
  checks: Check[];
  checkedAt?: string;
  record?: {
    legalName: string;
    dbaName?: string;
    phone?: string;
    address?: { street?: string; city?: string; state?: string };
    mcNumbers: string[];
    authority: { common: string; contract: string; broker: string };
    insurance: { liabilityOnFileUsd?: number; cargoOnFileUsd?: number };
    safetyRating?: string;
    powerUnits?: number;
    drivers?: number;
  };
  changes: Array<{ replacedAt: string; phone?: string; email?: string; legalName: string }>;
  approval?: { approvedByName?: string; at: string; note: string };
}

export const VERDICT: Record<Verdict, { label: string; tone: Tone }> = {
  PASS: { label: tx("Passes"), tone: "success" },
  REVIEW: { label: tx("Needs review"), tone: "warning" },
  FAIL: { label: tx("Fails"), tone: "danger" },
  NOT_CHECKED: { label: tx("Not checked"), tone: "neutral" },
};
const RESULT: Record<Check["result"], { label: string; tone: Tone }> = { PASS: { label: tx("OK"), tone: "success" }, REVIEW: { label: tx("Review"), tone: "warning" }, FAIL: { label: tx("Fail"), tone: "danger" } };

/** A verdict chip that opens the carrier check. */
export function VettingChip({ verdict, approved, onPress }: { verdict: Verdict; approved?: boolean; onPress?: () => void }) {
  const v = verdict === "REVIEW" && approved ? { label: tx("Approved by you"), tone: "success" as Tone } : VERDICT[verdict];
  return <Chip label={v.label} tone={v.tone} onPress={onPress} />;
}

/**
 * Is this carrier allowed to haul, insured, and who it says it is? FMCSA
 * facts, each check, and, for a carrier needing review, a sign-off.
 */
export function CarrierCheckScreen() {
  const t = useT();
  const { orgId, payerOrgId } = useParams<"CarrierCheck">();
  const nav = useNav();
  const [r, setR] = useState<Report>();
  const [error, setError] = useState<string>();
  const [note, setNote] = useState("");
  const q = payerOrgId ? `?payerOrgId=${payerOrgId}` : "";
  const load = useCallback(async () => {
    try {
      const report = await api.get<Report>(`/v1/carriers/${orgId}/vetting${q}`);
      setR(report);
      nav.setOptions({ title: report.carrier.name });
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [orgId, q, nav]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  if (error) return <Screen><Empty title={t("Couldn't load the carrier check")} message={error} /></Screen>;
  if (!r) return null;
  const act = (fn: () => Promise<unknown>, ok?: string) => async () => {
    try {
      const out = await fn();
      if (out && typeof out === "object" && "verdict" in out) setR(out as Report);
      else await load();
      if (ok) notify(ok);
    } catch (e) {
      notify(t("Couldn't do that"), errorMessage(e));
    }
  };
  const rec = r.record;
  const order = { FAIL: 0, REVIEW: 1, PASS: 2 } as const;

  return (
    <Screen onRefresh={load}>
      {r.verdict === "NOT_CHECKED" ? <Banner tone="info" title={t("Carriers aren't checked yet")} message={t("Set LP_FMCSA_WEBKEY on the server to check every carrier against FMCSA before you tender.")} /> : null}
      {r.verdict === "FAIL" ? <Banner tone="danger" title={t("Don't use this carrier")} message={t("It can't be tendered or awarded loads while a check fails.")} /> : null}
      {r.verdict === "REVIEW" && !r.approval ? <Banner tone="warning" title={t("Look before you tender")} message={t("Confirm the carrier using the FMCSA phone number, then approve it below.")} /> : null}
      <Section title={t("Carrier")}>
        <Row title={r.carrier.name} subtitle={[r.carrier.dotNumber && `USDOT ${r.carrier.dotNumber}`, r.carrier.mcNumber && `MC ${r.carrier.mcNumber}`, r.carrier.scac && `SCAC ${r.carrier.scac}`].filter(Boolean).join(" · ") || t("No USDOT or MC entered")} right={<VettingChip verdict={r.verdict} approved={!!r.approval} />} />
        {r.checkedAt ? <Row title={t("Checked with FMCSA")} value={when(r.checkedAt)} /> : null}
      </Section>
      {r.checks.length ? (
        <Section title={t("Checks")}>
          {[...r.checks].sort((a, b) => order[a.result] - order[b.result]).map((c) => (
            <Row key={c.code} title={c.title} subtitle={c.detail} right={<Chip label={RESULT[c.result].label} tone={RESULT[c.result].tone} />} />
          ))}
        </Section>
      ) : null}
      {rec ? (
        <Section title={t("FMCSA record")}>
          <Row title={t("Legal name")} value={rec.legalName} />
          {rec.dbaName ? <Row title={t("Doing business as")} value={rec.dbaName} /> : null}
          {rec.phone ? <Row title={t("Phone on file")} value={rec.phone} /> : null}
          {rec.address?.city ? <Row title={t("Address")} subtitle={[rec.address.street, `${rec.address.city}, ${rec.address.state}`].filter(Boolean).join("\n")} /> : null}
          {rec.mcNumbers.length ? <Row title={t("MC numbers")} value={rec.mcNumbers.join(", ")} /> : null}
          <Row title={t("Authority")} subtitle={`Common ${titleCase(rec.authority.common)} · contract ${titleCase(rec.authority.contract)} · broker ${titleCase(rec.authority.broker)}`} />
          <Row title={t("Liability on file")} value={rec.insurance.liabilityOnFileUsd !== undefined ? money(rec.insurance.liabilityOnFileUsd) : "None"} />
          {rec.insurance.cargoOnFileUsd !== undefined ? <Row title={t("Cargo on file")} value={money(rec.insurance.cargoOnFileUsd)} /> : null}
          {rec.safetyRating ? <Row title={t("Safety rating")} value={titleCase(rec.safetyRating)} /> : null}
          {rec.powerUnits ? <Row title={t("Fleet")} value={`${t("{n} trucks", { n: rec.powerUnits })}${rec.drivers ? ` · ${t("{n} drivers", { n: rec.drivers })}` : ""}`} /> : null}
        </Section>
      ) : null}
      {r.changes.length ? (
        <Section title={t("Earlier contact details")} footer={t("FMCSA details this carrier had before. Recent changes are a sign of a hijacked identity.")}>
          {[...r.changes].reverse().map((c, i) => (
            <Row key={i} title={c.legalName} subtitle={`${[c.phone, c.email].filter(Boolean).join(" · ") || "No phone or email"}\nReplaced ${when(c.replacedAt)}`} />
          ))}
        </Section>
      ) : null}
      {r.payerOrgId && r.verdict === "REVIEW" ? (
        <Section title={t("Your sign-off")} footer={t("Approving lets your company tender to this carrier while its check needs review. It never overrides a failed check.")}>
          {r.approval ? (
            <>
              <Row title={t("Approved by {name}", { name: r.approval.approvedByName ?? t("your team") })} subtitle={`${when(r.approval.at)}\n${r.approval.note}`} />
              <Padded>
                <Button title={t("Withdraw approval")} variant="destructive" onPress={act(() => api.post(`/v1/orgs/${r.payerOrgId}/carrier-approvals/${r.carrier.id}/remove`, {}))} />
              </Padded>
            </>
          ) : (
            <Padded>
              <Field label={t("How did you confirm them?")} value={note} onChangeText={setNote} placeholder={t("e.g. Called the FMCSA phone number and spoke to the owner")} multiline />
              <Button title={t("Approve this carrier")} disabled={note.trim().length < 3} onPress={act(() => api.post(`/v1/orgs/${r.payerOrgId}/carrier-approvals`, { carrierOrgId: r.carrier.id, note: note.trim() }), t("Carrier approved"))} />
            </Padded>
          )}
        </Section>
      ) : null}
      {r.verdict !== "NOT_CHECKED" ? (
        <Padded>
          <Button title={t("Check FMCSA again now")} variant="tonal" onPress={act(() => api.post(`/v1/carriers/${orgId}/vetting/refresh${q}`, {}))} />
        </Padded>
      ) : null}
    </Screen>
  );
}

interface Policy {
  minAuthorityDays: number;
  minLiabilityUsd: number;
  minCargoUsd: number;
  allowConditional: boolean;
}

/** A shipper's or broker's vetting rules. */
export function VettingPolicySection({ orgId, policy, onSaved }: { orgId: string; policy?: Policy; onSaved: () => unknown }) {
  const t = useT();
  const p = policy ?? { minAuthorityDays: 90, minLiabilityUsd: 750_000, minCargoUsd: 100_000, allowConditional: false };
  const [age, setAge] = useState(String(p.minAuthorityDays));
  const [liability, setLiability] = useState(String(p.minLiabilityUsd));
  const [cargo, setCargo] = useState(String(p.minCargoUsd));
  const [conditional, setConditional] = useState(p.allowConditional);
  const save = async () => {
    try {
      await api.put(`/v1/orgs/${orgId}/vetting-policy`, { minAuthorityDays: Number(age), minLiabilityUsd: Number(liability), minCargoUsd: Number(cargo), allowConditional: conditional });
      await onSaved();
      notify(t("Vetting rules saved"));
    } catch (e) {
      notify(t("Couldn't save"), errorMessage(e));
    }
  };
  return (
    <Section title={t("Carrier vetting")} footer={t("Every carrier is checked against FMCSA before you tender or award. A carrier that fails can't be used; one that needs review needs your sign-off first.")}>
      <Padded>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Field label={t("Minimum authority age (days)")} value={age} onChangeText={setAge} keyboardType="number-pad" />
          </View>
          <View style={{ flex: 1 }}>
            <Field label={t("Minimum liability (USD)")} value={liability} onChangeText={setLiability} keyboardType="number-pad" />
          </View>
        </View>
        <Field label={t("Minimum cargo insurance (USD)")} value={cargo} onChangeText={setCargo} keyboardType="number-pad" />
      </Padded>
      <ToggleRow title={t("Accept a Conditional safety rating")} value={conditional} onChange={setConditional} />
      <Padded>
        <Button title={t("Save vetting rules")} variant="tonal" disabled={[age, liability, cargo].some((v) => Number.isNaN(Number(v)) || v === "")} onPress={save} />
      </Padded>
      <Body secondary style={{ marginHorizontal: 16, marginBottom: 8 }}>{t("Double brokering usually starts with a broker or a stolen identity posing as a carrier. Checks look for broker-only authority, new authorities, contact details that don't match FMCSA or changed recently, and the same USDOT on two accounts.")}</Body>
    </Section>
  );
}
