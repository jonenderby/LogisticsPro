import { tx } from "@logisticspro/workspace";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { api, errorMessage } from "../api/client";
import { useNav, useParams } from "../navigation/types";
import { useT } from "../state/MeProvider";
import { Body, Button, Chip, Empty, Field, Padded, Row, Screen, Section, ToggleRow, type Tone } from "../ui/components";
import { confirm, notify } from "../ui/dialog";
import { saveTextFile } from "../ui/download";
import { money, when } from "../ui/format";

interface Candidate {
  id: string;
  invoiceNumber: string;
  loadNumber: string;
  carrierName?: string;
  payee?: string;
  last4?: string;
  balance: number;
  notPayable?: string;
}
interface Run {
  id: string;
  status: "CREATED" | "SENT" | "CANCELLED";
  effectiveDate: string;
  total: number;
  fileName: string;
  entries: Array<{ invoiceNumber: string; payeeName: string; last4: string; amount: number }>;
  createdAt: string;
}

const RUN_STATUS: Record<Run["status"], { label: string; tone: Tone }> = {
  CREATED: { label: tx("Not sent yet"), tone: "warning" },
  SENT: { label: tx("Sent"), tone: "success" },
  CANCELLED: { label: tx("Cancelled"), tone: "neutral" },
};

/**
 * Pay approved invoices by ACH: pick them, confirm with an authenticator
 * code, and upload the file to your bank. Marking it sent records each
 * payment and tells each carrier.
 */
export function AchPaymentsScreen() {
  const t = useT();
  const nav = useNav();
  const { orgId } = useParams<"AchPayments">();
  const [data, setData] = useState<{ originator: object | null; invoices: Candidate[]; runs: Run[] }>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api.get(`/v1/orgs/${orgId}/payment-runs`));
    } catch (e) {
      notify(t("Couldn't load payments"), errorMessage(e));
    }
  }, [orgId, t]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  if (!data) return <Screen><Empty title={t("Loading…")} /></Screen>;
  if (!data.originator) {
    return (
      <Screen>
        <Empty title={t("Add your bank's ACH details first")} message={t("Under Business, in Paying by ACH.")} />
        <Padded>
          <Button title={t("Open Business")} variant="tonal" onPress={() => nav.navigate("Business")} />
        </Padded>
      </Screen>
    );
  }
  const payable = data.invoices.filter((i) => !i.notPayable);
  const total = payable.filter((i) => picked.has(i.id)).reduce((s, i) => s + i.balance, 0);
  const toggle = (id: string) => setPicked((p) => (p.has(id) ? new Set([...p].filter((x) => x !== id)) : new Set([...p, id])));
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ run: Run; file: { name: string; content: string } }>(`/v1/orgs/${orgId}/payment-runs`, { invoiceIds: [...picked], code });
      setPicked(new Set());
      setCode("");
      await saveTextFile(r.file.name, r.file.content);
      await load();
      notify(t("Payment file ready"), t("Upload {name} to your bank, then mark it sent.", { name: r.file.name }));
    } catch (e) {
      notify(t("Couldn't make the payment file"), errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const act = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      await load();
    } catch (e) {
      notify(t("Couldn't do that"), errorMessage(e));
    }
  };

  return (
    <Screen onRefresh={load}>
      <Section title={t("Approved and ready to pay")} footer={t("Each invoice's balance goes to the bank account it was sent with.")}>
        {payable.length === 0 ? <Empty title={t("Nothing ready to pay")} message={t("Approve invoices first. Carriers need to have given bank details.")} /> : null}
        {payable.map((i) => (
          <ToggleRow key={i.id} title={`${i.invoiceNumber} · ${money(i.balance)}`} subtitle={`${i.payee ?? i.carrierName} · ${t("ending {last4}", { last4: i.last4 ?? "" })} · ${t("Load {n}", { n: i.loadNumber })}`} value={picked.has(i.id)} onChange={() => toggle(i.id)} />
        ))}
      </Section>
      {picked.size ? (
        <Padded>
          <Body>{t("{n} payments, {total} in all.", { n: picked.size, total: money(total) })}</Body>
          <Field label={t("Authenticator code")} value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={8} hint={t("The file holds account numbers, so it takes a fresh code")} />
          <Button title={t("Make payment file")} loading={busy} disabled={code.length < 6} onPress={create} />
        </Padded>
      ) : null}
      {data.invoices.some((i) => i.notPayable) ? (
        <Section title={t("Not ready")}>
          {data.invoices
            .filter((i) => i.notPayable)
            .map((i) => (
              <Row key={i.id} title={`${i.invoiceNumber} · ${money(i.balance)}`} subtitle={`${i.carrierName} · ${t(i.notPayable!)}`} onPress={() => nav.navigate("InvoiceDetail", { id: i.id })} />
            ))}
        </Section>
      ) : null}
      {data.runs.length ? (
        <Section title={t("Payment files")}>
          {data.runs.map((r) => (
            <RunRow key={r.id} run={r} onSent={act(() => api.post(`/v1/payment-runs/${r.id}/sent`, {}))} onCancel={act(async () => { if (await confirm(t("Cancel this payment file?"), t("Only if you haven't uploaded it to your bank."), t("Cancel file"), true)) await api.post(`/v1/payment-runs/${r.id}/cancel`, {}); })} />
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}

function RunRow({ run, onSent, onCancel }: { run: Run; onSent: () => void; onCancel: () => void }) {
  const t = useT();
  const [code, setCode] = useState("");
  const [open, setOpen] = useState(false);
  const download = async () => {
    try {
      const f = await api.post<{ name: string; content: string }>(`/v1/payment-runs/${run.id}/file`, { code });
      setCode("");
      await saveTextFile(f.name, f.content);
    } catch (e) {
      notify(t("Couldn't download"), errorMessage(e));
    }
  };
  return (
    <>
      <Row
        title={`${money(run.total)} · ${t("effective {date}", { date: run.effectiveDate })}`}
        subtitle={`${run.entries.map((e) => `${e.invoiceNumber} ${e.payeeName}`).join(", ")}\n${when(run.createdAt)}`}
        right={<Chip label={RUN_STATUS[run.status].label} tone={RUN_STATUS[run.status].tone} />}
        onPress={run.status === "CREATED" ? () => setOpen(!open) : undefined}
      />
      {open && run.status === "CREATED" ? (
        <Padded>
          <Button title={t("Mark sent to the bank")} onPress={onSent} />
          <Field label={t("Authenticator code")} value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={8} />
          <Button title={t("Download again")} variant="tonal" disabled={code.length < 6} onPress={download} />
          <Button title={t("Cancel file")} variant="destructive" onPress={onCancel} />
        </Padded>
      ) : null}
    </>
  );
}
