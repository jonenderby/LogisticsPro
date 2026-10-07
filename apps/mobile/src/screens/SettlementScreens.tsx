import { type Translate, tx } from "@logisticspro/workspace";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import { useNav, useParams } from "../navigation/types";
import { useT } from "../state/MeProvider";
import { Body, Button, Chip, Empty, Field, Padded, Row, Screen, Section, Segmented, type Tone } from "../ui/components";
import { confirm, notify } from "../ui/dialog";
import { saveTextFile } from "../ui/download";
import { money, when } from "../ui/format";

type Kind = "PERCENT" | "PER_MILE" | "PER_LOAD";
interface Rule {
  kind: Kind;
  rate: number;
}
interface Statement {
  id: string;
  carrierOrgId: string;
  carrierName?: string;
  driverName: string;
  periodStart: string;
  periodEnd: string;
  rule?: Rule;
  lines: Array<{ loadId: string; loadNumber: string; deliveredAt: string; lane: string; basis: string; amount: number }>;
  adjustments: Array<{ id: string; description: string; amount: number }>;
  total: number;
  status: "DRAFT" | "APPROVED" | "PAID";
  paidAt?: string;
  paidReference?: string;
  canManage?: boolean;
}

const STATUS: Record<Statement["status"], { label: string; tone: Tone }> = {
  DRAFT: { label: tx("Draft"), tone: "neutral" },
  APPROVED: { label: tx("Approved"), tone: "info" },
  PAID: { label: tx("Paid"), tone: "success" },
};
const KIND: Record<Kind, string> = { PERCENT: tx("% of linehaul"), PER_MILE: tx("Per loaded mile"), PER_LOAD: tx("Per load") };

const ruleText = (t: Translate, r: Rule) =>
  r.kind === "PERCENT" ? t("{n}% of linehaul", { n: r.rate }) : r.kind === "PER_MILE" ? t("{amount} a loaded mile", { amount: money(r.rate) }) : t("{amount} a load", { amount: money(r.rate) });

/** Monday to Sunday of last week, the usual pay period. */
function lastWeek(): { start: string; end: string } {
  const d = new Date();
  const sinceMonday = (d.getDay() + 6) % 7;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday - 7);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return { start: iso(monday), end: iso(sunday) };
}

/** Business: how each driver is paid. */
export function DriverPaySection({ orgId }: { orgId: string }) {
  const t = useT();
  const [drivers, setDrivers] = useState<Array<{ accountId: string; name: string; rule: Rule | null }>>();
  const [editing, setEditing] = useState<string>();
  const [kind, setKind] = useState<Kind>("PERCENT");
  const [rate, setRate] = useState("");
  const load = useCallback(async () => setDrivers(await api.get<Array<{ accountId: string; name: string; rule: Rule | null }>>(`/v1/orgs/${orgId}/driver-pay`).catch(() => undefined)), [orgId]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  if (!drivers?.length) return null;
  const save = async (accountId: string) => {
    try {
      await api.put(`/v1/orgs/${orgId}/drivers/${accountId}/pay`, { kind, rate: Number(rate) });
      setEditing(undefined);
      await load();
    } catch (e) {
      notify(t("Couldn't save"), errorMessage(e));
    }
  };
  return (
    <Section title={t("Driver pay")} footer={t("Used for pay statements. A team splits each load; relays split by miles.")}>
      {drivers.map((d) => (
        <View key={d.accountId}>
          <Row
            title={d.name}
            subtitle={d.rule ? ruleText(t, d.rule) : t("No pay rule yet")}
            onPress={() => {
              setEditing(editing === d.accountId ? undefined : d.accountId);
              setKind(d.rule?.kind ?? "PERCENT");
              setRate(d.rule ? String(d.rule.rate) : "");
            }}
          />
          {editing === d.accountId ? (
            <Padded>
              <Segmented options={(Object.keys(KIND) as Kind[]).map((k) => ({ value: k, label: KIND[k] }))} value={kind} onChange={setKind} />
              <Field label={kind === "PERCENT" ? t("Percent") : t("Amount (USD)")} value={rate} onChangeText={setRate} keyboardType="decimal-pad" />
              <Button title={t("Save")} disabled={!(Number(rate) > 0)} onPress={() => save(d.accountId)} />
            </Padded>
          ) : null}
        </View>
      ))}
    </Section>
  );
}

/** The office: make, review and export pay statements for a period. */
export function SettlementsScreen() {
  const t = useT();
  const nav = useNav();
  const { orgId } = useParams<"Settlements">();
  const week = lastWeek();
  const [start, setStart] = useState(week.start);
  const [end, setEnd] = useState(week.end);
  const [list, setList] = useState<Statement[]>();
  const load = useCallback(async () => setList(await api.get<Statement[]>(`/v1/orgs/${orgId}/settlements`).catch(() => [])), [orgId]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const make = async () => {
    try {
      const r = await api.post<{ created: Statement[]; driversWithoutPayRule: string[] }>(`/v1/orgs/${orgId}/settlements`, { periodStart: start, periodEnd: end });
      await load();
      const missing = r.driversWithoutPayRule.length ? ` ${t("No pay rule for {names}; set one under Business.", { names: r.driversWithoutPayRule.join(", ") })}` : "";
      notify(r.created.length ? t("{n} statements made", { n: r.created.length }) : t("No new statements"), `${r.created.length ? "" : t("Every delivered load in this period is already on a statement.")}${missing}`.trim());
    } catch (e) {
      notify(t("Couldn't make statements"), errorMessage(e));
    }
  };
  const exportCsv = async () => {
    try {
      const f = await api.get<{ name: string; content: string }>(`/v1/orgs/${orgId}/settlements/export?periodStart=${start}&periodEnd=${end}`);
      await saveTextFile(f.name, f.content, "text/csv");
    } catch (e) {
      notify(t("Couldn't export"), errorMessage(e));
    }
  };
  return (
    <Screen onRefresh={load}>
      <Section title={t("Pay period")} footer={t("Statements cover loads delivered in the period that aren't on a statement yet.")}>
        <Padded>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field label={t("From")} value={start} onChangeText={setStart} placeholder="YYYY-MM-DD" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label={t("To")} value={end} onChangeText={setEnd} placeholder="YYYY-MM-DD" />
            </View>
          </View>
          <Button title={t("Make statements")} onPress={make} />
          <Button title={t("Export CSV")} variant="tonal" onPress={exportCsv} />
        </Padded>
      </Section>
      <Section title={t("Statements")}>
        {list && !list.length ? <Empty title={t("No statements yet")} message={t("Set each driver's pay under Business, then make statements for a period.")} /> : null}
        {list?.map((s) => (
          <Row key={s.id} title={`${s.driverName} · ${money(s.total)}`} subtitle={`${s.periodStart} – ${s.periodEnd} · ${t(s.lines.length === 1 ? "{n} load" : "{n} loads", { n: s.lines.length })}`} right={<Chip label={STATUS[s.status].label} tone={STATUS[s.status].tone} />} onPress={() => nav.navigate("SettlementDetail", { id: s.id })} />
        ))}
      </Section>
    </Screen>
  );
}

/** One statement: loads, adjustments and total. The office edits drafts, approves and records payment. */
export function SettlementDetailScreen() {
  const t = useT();
  const nav = useNav();
  const { id } = useParams<"SettlementDetail">();
  const [s, setS] = useState<Statement>();
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [deduct, setDeduct] = useState(true);
  const [ref, setRef] = useState("");
  const load = useCallback(async () => setS(await api.get<Statement>(`/v1/settlements/${id}`).catch(() => undefined)), [id]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  if (!s) return <Screen><Empty title={t("Loading…")} /></Screen>;
  const act = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      await load();
    } catch (e) {
      notify(t("Couldn't do that"), errorMessage(e));
    }
  };
  const draft = s.canManage && s.status === "DRAFT";
  return (
    <Screen onRefresh={load}>
      <Section title={`${s.driverName} · ${s.periodStart} – ${s.periodEnd}`} footer={s.rule ? ruleText(t, s.rule) : undefined}>
        <Row title={t("Total")} value={money(s.total)} right={<Chip label={STATUS[s.status].label} tone={STATUS[s.status].tone} />} />
        {s.carrierName ? <Row title={t("Carrier")} value={s.carrierName} /> : null}
        {s.status === "PAID" ? <Row title={t("Paid")} subtitle={`${when(s.paidAt)}${s.paidReference ? ` · ${s.paidReference}` : ""}`} /> : null}
      </Section>
      <Section title={t("Loads")}>
        {s.lines.map((l) => (
          <Row key={l.loadId} title={`${l.loadNumber} · ${l.lane}`} subtitle={`${when(l.deliveredAt)} · ${l.basis}`} value={money(l.amount)} onPress={() => nav.navigate("LoadDetail", { id: l.loadId })} />
        ))}
      </Section>
      {s.adjustments.length || draft ? (
        <Section title={t("Adjustments")} footer={draft ? t("Advances and deductions come off; bonuses and reimbursements are added.") : undefined}>
          {s.adjustments.map((a) => (
            <Row key={a.id} title={a.description} value={money(a.amount)} onPress={draft ? act(async () => { if (await confirm(t("Remove this adjustment?"), a.description, t("Remove"), true)) await api.post(`/v1/settlements/${s.id}/adjustments/${a.id}/remove`, {}); }) : undefined} />
          ))}
          {draft ? (
            <Padded>
              <Field label={t("Description")} value={desc} onChangeText={setDesc} placeholder={t("e.g. Fuel advance")} />
              <Segmented options={[{ value: "deduct", label: t("Take off") }, { value: "add", label: t("Add") }]} value={deduct ? "deduct" : "add"} onChange={(v) => setDeduct(v === "deduct")} />
              <Field label={t("Amount (USD)")} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
              <Button
                title={t("Add adjustment")}
                variant="tonal"
                disabled={!desc.trim() || !(Number(amount) > 0)}
                onPress={act(async () => {
                  await api.post(`/v1/settlements/${s.id}/adjustments`, { description: desc.trim(), amount: deduct ? -Number(amount) : Number(amount) });
                  setDesc("");
                  setAmount("");
                })}
              />
            </Padded>
          ) : null}
        </Section>
      ) : null}
      {s.canManage && s.status !== "PAID" ? (
        <Padded>
          {s.status === "DRAFT" ? (
            <>
              <Body secondary>{t("Approving shows the statement to the driver.")}</Body>
              <Button title={t("Approve")} onPress={act(() => api.post(`/v1/settlements/${s.id}/approve`, {}))} />
              <Button title={t("Discard")} variant="destructive" onPress={act(async () => { if (await confirm(t("Discard this draft?"), t("Its loads can go on another statement."), t("Discard"), true)) { await api.post(`/v1/settlements/${s.id}/discard`, {}); nav.goBack(); } })} />
            </>
          ) : (
            <>
              <Field label={t("Reference (optional)")} value={ref} onChangeText={setRef} placeholder={t("Direct deposit or check no.")} />
              <Button title={t("Mark paid")} onPress={act(() => api.post(`/v1/settlements/${s.id}/paid`, { reference: ref || undefined }))} />
            </>
          )}
        </Padded>
      ) : null}
    </Screen>
  );
}

/** A driver's own pay statements, once approved. */
export function MyPayScreen() {
  const t = useT();
  const nav = useNav();
  const [list, setList] = useState<Statement[]>();
  const load = useCallback(async () => setList(await api.get<Statement[]>("/v1/me/settlements").catch(() => [])), []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  return (
    <Screen onRefresh={load}>
      <Section>
        {list && !list.length ? <Empty title={t("No pay statements yet")} message={t("Your carrier's statements appear here once they are approved.")} /> : null}
        {list?.map((s) => (
          <Row key={s.id} title={`${money(s.total)} · ${s.periodStart} – ${s.periodEnd}`} subtitle={`${s.carrierName ?? ""} · ${t(s.lines.length === 1 ? "{n} load" : "{n} loads", { n: s.lines.length })}`} right={<Chip label={STATUS[s.status].label} tone={STATUS[s.status].tone} />} onPress={() => nav.navigate("SettlementDetail", { id: s.id })} />
        ))}
      </Section>
    </Screen>
  );
}
