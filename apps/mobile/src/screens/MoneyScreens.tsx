import { useFocusEffect } from "@react-navigation/native";
import { type DetentionView, visitLine } from "../ui/detention";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import type { Invoice, Load, Transmission } from "../api/types";
import { notify } from "../ui/dialog";
import { useNav, useParams } from "../navigation/types";
import { useMe } from "../state/MeProvider";
import { Banner, Body, Button, Chip, Empty, Field, Padded, Row, Screen, Section, Segmented } from "../ui/components";
import { money, titleCase, when } from "../ui/format";

const METHOD_LABEL: Record<string, string> = { API_JSON: "JSON API", API_XML: "XML API", EDI_X12: "EDI 210" };

/** An invoice with what is owed, paid and due, as the API returns it. */
export interface InvoiceView extends Invoice {
  dueDate: string;
  owed: number;
  paid: number;
  balance: number;
  daysLate: number;
  bucket?: string;
  carrierName?: string;
  billToName?: string;
  documents: Array<{ id: string; kind: string; name: string; url: string }>;
}
interface InvoiceDetail extends InvoiceView {
  canPay: boolean;
  canBill: boolean;
  quickPayOffer?: { days: number; feePct: number };
}
interface AgingSide {
  open: number;
  overdue: number;
  averageDaysToPay?: number;
  buckets: Record<string, { count: number; amount: number }>;
}
interface Aging {
  receivable?: AgingSide & { customers: Array<{ orgId: string; name: string; open: number; overdue: number }> };
  payable?: AgingSide & { carriers: Array<{ orgId: string; name: string; open: number; overdue: number }> };
}

const BUCKETS: Array<[string, string]> = [
  ["CURRENT", "Not due yet"],
  ["DAYS_1_30", "1–30 days late"],
  ["DAYS_31_60", "31–60 days late"],
  ["DAYS_61_90", "61–90 days late"],
  ["DAYS_90_PLUS", "Over 90 days late"],
];

export const INVOICE_STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info" }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SENT: { label: "Sent", tone: "info" },
  ACKNOWLEDGED: { label: "Received", tone: "info" },
  APPROVED: { label: "Approved", tone: "info" },
  PARTIALLY_PAID: { label: "Part paid", tone: "warning" },
  PAID: { label: "Paid", tone: "success" },
  DISPUTED: { label: "Disputed", tone: "danger" },
  REJECTED: { label: "Rejected", tone: "danger" },
};

const statusChip = (i: InvoiceView) =>
  i.daysLate > 0 ? <Chip label={`${i.daysLate} days late`} tone="danger" /> : <Chip label={INVOICE_STATUS[i.status]?.label ?? titleCase(i.status)} tone={INVOICE_STATUS[i.status]?.tone ?? "neutral"} />;

function AgingSection({ title, side, parties }: { title: string; side: AgingSide; parties: Array<{ orgId: string; name: string; open: number; overdue: number }> }) {
  return (
    <Section title={title} footer={side.averageDaysToPay !== undefined ? `Paid in full on average ${side.averageDaysToPay} days after the invoice.` : undefined}>
      <Row title="Open" value={money(side.open)} />
      {BUCKETS.filter(([b]) => side.buckets[b]?.count).map(([b, label]) => (
        <Row key={b} title={label} subtitle={`${side.buckets[b]!.count} invoice${side.buckets[b]!.count === 1 ? "" : "s"}`} value={money(side.buckets[b]!.amount)} />
      ))}
      {parties.length > 1 ? parties.slice(0, 5).map((p) => <Row key={p.orgId} title={p.name} subtitle={p.overdue ? `${money(p.overdue)} overdue` : "Nothing overdue"} value={money(p.open)} />) : null}
    </Section>
  );
}

export function MoneyScreen() {
  const { me } = useMe();
  const nav = useNav();
  const [invoices, setInvoices] = useState<InvoiceView[]>([]);
  const [ready, setReady] = useState<Load[]>([]);
  const [agingByOrg, setAging] = useState<Aging[]>([]);
  // Aging for every company where this person handles money.
  const payOrgs = (me?.orgs ?? []).filter((o) => o.roles.some((r) => ["OWNER", "ADMIN", "BILLING"].includes(r))).map((o) => o.id).join(",");
  const refresh = useCallback(async () => {
    const [inv, delivered, ag] = await Promise.all([
      api.get<InvoiceView[]>("/v1/invoices"),
      api.get<Load[]>("/v1/loads?status=DELIVERED"),
      Promise.all(payOrgs.split(",").filter(Boolean).map((id) => api.get<Aging>(`/v1/orgs/${id}/aging`).catch(() => ({}) as Aging))),
    ]);
    setInvoices(inv);
    setReady(delivered);
    setAging(ag);
  }, [payOrgs]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  const myOrgs = new Set(me?.orgs.map((o) => o.id));
  const payable = invoices.filter((i) => i.billTo.orgId && myOrgs.has(i.billTo.orgId));
  const receivable = invoices.filter((i) => !payable.includes(i));
  const open = (i: InvoiceView) => ["SENT", "ACKNOWLEDGED", "APPROVED", "PARTIALLY_PAID", "DISPUTED"].includes(i.status);
  const row = (i: InvoiceView, who?: string) => (
    <Row key={i.id} title={`${i.invoiceNumber} · ${money(i.total, i.currency)}`} subtitle={`${who ? `${who} · ` : ""}Load ${i.loadNumber} · ${open(i) ? `due ${i.dueDate}${i.paid ? ` · ${money(i.balance)} left` : ""}` : when(i.issuedAt)}${i.quickPay?.status === "REQUESTED" ? " · quick pay asked" : ""}`} right={statusChip(i)} onPress={() => nav.navigate("InvoiceDetail", { id: i.id })} />
  );
  const receivables = agingByOrg.find((a) => a.receivable)?.receivable;
  const payables = agingByOrg.find((a) => a.payable)?.payable;

  return (
    <Screen onRefresh={refresh}>
      {ready.length ? (
        <Section title="Ready to invoice">
          {ready.map((l) => (
            <Row key={l.id} title={l.loadNumber} subtitle={`Delivered ${when(l.deliveredAt)}`} value={money(l.rate?.amount)} onPress={() => nav.navigate("SendInvoice", { loadId: l.id })} />
          ))}
        </Section>
      ) : null}
      {receivables ? <AgingSection title="Owed to you" side={receivables} parties={receivables.customers} /> : null}
      {receivable.length || !payable.length ? (
        <Section title="Invoices sent">
          {receivable.length === 0 ? <Empty title="No invoices yet" /> : null}
          {receivable.map((i) => row(i, i.billToName))}
        </Section>
      ) : null}
      {payables ? <AgingSection title="You owe" side={payables} parties={payables.carriers} /> : null}
      {payable.length ? (
        <Section title="Invoices to pay">
          {payable.filter(open).map((i) => row(i, i.carrierName))}
          {payable.filter((i) => !open(i)).slice(0, 20).map((i) => row(i, i.carrierName))}
        </Section>
      ) : null}
    </Screen>
  );
}

/**
 * One invoice: what it covers, who gets paid, its paperwork and its
 * history. The payer approves, disputes, approves quick pay and records
 * payments; the carrier asks for quick pay.
 */
export function InvoiceDetailScreen() {
  const { id } = useParams<"InvoiceDetail">();
  const nav = useNav();
  const [inv, setInv] = useState<InvoiceDetail>();
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"ACH" | "CHECK" | "WIRE" | "OTHER">("ACH");
  const [reference, setReference] = useState("");
  const load = useCallback(async () => {
    const i = await api.get<InvoiceDetail>(`/v1/invoices/${id}`);
    setInv(i);
    setAmount(i.balance ? String(i.balance) : "");
    nav.setOptions({ title: i.invoiceNumber });
  }, [id, nav]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  if (!inv) return null;
  const act = (fn: () => Promise<unknown>, ok?: string) => async () => {
    try {
      await fn();
      if (ok) notify(ok);
      setNote("");
      setReference("");
      await load();
    } catch (e) {
      notify("Couldn't update the invoice", errorMessage(e));
    }
  };
  const status = (s: string) => act(() => api.post(`/v1/invoices/${id}/status`, { status: s, note: note.trim() || undefined }));
  const isOpen = ["SENT", "ACKNOWLEDGED", "APPROVED", "PARTIALLY_PAID", "DISPUTED"].includes(inv.status);
  const qp = inv.quickPay;

  return (
    <Screen onRefresh={load}>
      {inv.status === "DISPUTED" || inv.status === "REJECTED" ? <Banner tone="danger" title={inv.status === "DISPUTED" ? "Disputed" : "Rejected"} message={inv.disputeReason} /> : null}
      {inv.daysLate > 0 ? <Banner tone="warning" title={`${inv.daysLate} days past due`} message={`Was due ${inv.dueDate}. ${money(inv.balance)} still owed.`} /> : null}
      <Section title={`${inv.carrierName ?? "Carrier"} to ${inv.billToName ?? "customer"}`}>
        <Row title="Status" right={statusChip(inv)} />
        <Row title="Load" value={inv.loadNumber} onPress={() => nav.navigate("LoadDetail", { id: inv.loadId })} />
        <Row title="Invoice date" value={inv.issuedAt.slice(0, 10)} />
        <Row title="Due" value={`${inv.dueDate}${qp?.status === "APPROVED" ? " (quick pay)" : ` (${inv.terms})`}`} />
        <Row title="Total" value={money(inv.total, inv.currency)} />
        {qp?.status === "APPROVED" ? <Row title={`Quick-pay fee ${qp.feePct}%`} value={`−${money(qp.fee)}`} /> : null}
        {inv.paid ? <Row title="Paid" value={money(inv.paid)} /> : null}
        {isOpen ? <Row title="Balance" value={money(inv.balance)} /> : null}
        {inv.remitTo ? <Row title="Pay to" subtitle={`${inv.remitTo.name}${inv.remitTo.kind === "FACTOR" ? " (factoring company)" : ""}${inv.remitTo.email ? `\n${inv.remitTo.email}` : ""}`} /> : null}
      </Section>
      <Section title="Charges">
        {inv.lines.map((l, i) => (
          <Row key={i} title={l.description} subtitle={l.quantity !== 1 ? `${l.quantity} × ${money(l.rate)}` : undefined} value={money(l.amount)} />
        ))}
      </Section>
      {inv.documents.length ? (
        <Section title="Paperwork">
          {inv.documents.map((d) => (
            <Row key={d.id} title={d.name} subtitle={titleCase(d.kind)} />
          ))}
        </Section>
      ) : null}

      {inv.canBill && isOpen && inv.quickPayOffer && (!qp || qp.status === "DECLINED") && inv.status !== "DISPUTED" ? (
        <Section title="Quick pay" footer={`${inv.billToName} pays in ${inv.quickPayOffer.days} days for a ${inv.quickPayOffer.feePct}% fee: ${money(inv.total * (1 - inv.quickPayOffer.feePct / 100))} instead of ${money(inv.total)} by ${inv.dueDate}.`}>
          <Padded>
            <Button title={qp?.status === "DECLINED" ? "Ask again" : "Ask for quick pay"} variant="tonal" onPress={act(() => api.post(`/v1/invoices/${id}/quick-pay`, {}), "Quick pay requested")} />
          </Padded>
        </Section>
      ) : null}
      {qp?.status === "REQUESTED" ? (
        <Section title="Quick pay requested" footer={`${money(qp.netAmount)} in ${qp.days} days, after a ${qp.feePct}% fee of ${money(qp.fee)}.`}>
          {inv.canPay ? (
            <Padded>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button title="Approve" onPress={act(() => api.post(`/v1/invoices/${id}/quick-pay/decision`, { approve: true }))} style={{ flex: 1 }} />
                <Button title="Decline" variant="destructive" onPress={act(() => api.post(`/v1/invoices/${id}/quick-pay/decision`, { approve: false }))} style={{ flex: 1 }} />
              </View>
            </Padded>
          ) : (
            <Row title="Waiting on the customer" />
          )}
        </Section>
      ) : null}

      {inv.canPay && isOpen ? (
        <>
          <Section title="Review">
            <Padded>
              <Field label="Note (needed to dispute)" value={note} onChangeText={setNote} placeholder="e.g. Detention wasn't on the rate confirmation" />
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                {inv.status === "SENT" ? <Button title="Received" variant="tonal" onPress={status("ACKNOWLEDGED")} style={{ flex: 1 }} /> : null}
                {["SENT", "ACKNOWLEDGED", "DISPUTED"].includes(inv.status) ? <Button title="Approve" variant="tonal" onPress={status("APPROVED")} style={{ flex: 1 }} /> : null}
                {inv.status !== "DISPUTED" ? <Button title="Dispute" variant="destructive" disabled={!note.trim()} onPress={status("DISPUTED")} style={{ flex: 1 }} /> : null}
              </View>
            </Padded>
          </Section>
          {inv.status !== "DISPUTED" ? (
            <Section title="Record a payment">
              <Padded>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Field label="Amount (USD)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field label="Reference" value={reference} onChangeText={setReference} placeholder="ACH trace or check no." />
                  </View>
                </View>
                <Segmented options={[{ value: "ACH", label: "ACH" }, { value: "CHECK", label: "Check" }, { value: "WIRE", label: "Wire" }, { value: "OTHER", label: "Other" }]} value={method} onChange={setMethod} />
                <Button title="Record payment" disabled={!Number(amount)} onPress={act(() => api.post(`/v1/invoices/${id}/payments`, { amount: Number(amount), method, reference: reference.trim() || undefined }), "Payment recorded")} />
              </Padded>
            </Section>
          ) : null}
        </>
      ) : null}

      {inv.payments?.length ? (
        <Section title="Payments">
          {inv.payments.map((p) => (
            <Row key={p.id} title={money(p.amount)} subtitle={`${p.paidOn} · ${p.method}${p.reference ? ` · ${p.reference}` : ""}`} />
          ))}
        </Section>
      ) : null}
      {inv.history?.length ? (
        <Section title="History">
          {[...inv.history].reverse().map((h, i) => (
            <Row key={i} title={INVOICE_STATUS[h.status]?.label ?? titleCase(h.status)} subtitle={`${when(h.at)}${h.note ? ` · ${h.note}` : ""}`} />
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}

const ACCESSORIALS = [
  { value: "DETENTION", label: "Detention" },
  { value: "LUMPER", label: "Lumper" },
  { value: "LAYOVER", label: "Layover" },
  { value: "STOP_OFF", label: "Stop-off" },
] as const;

/**
 * The driver or carrier builds the invoice once. Logistics Pro sends it in
 * whatever format the customer set up: JSON API, XML API or EDI 210.
 */
export function SendInvoiceScreen() {
  const { loadId } = useParams<"SendInvoice">();
  const nav = useNav();
  const { refresh: refreshMe } = useMe();
  const [fuel, setFuel] = useState("");
  const [extras, setExtras] = useState<Array<{ code: string; description: string; quantity: number; rate: number }>>([]);
  const [code, setCode] = useState<(typeof ACCESSORIALS)[number]["value"]>("DETENTION");
  const [qty, setQty] = useState("1");
  const [rate, setRate] = useState("");
  const [owed, setOwed] = useState<DetentionView>();
  useEffect(() => {
    void api.get<DetentionView>(`/v1/loads/${loadId}/detention`).then(setOwed).catch(() => undefined);
  }, [loadId]);

  const send = async () => {
    try {
      const r = await api.post<{ invoice: Invoice; transmissions: Transmission[] }>(`/v1/loads/${loadId}/invoices`, { fuelSurchargePct: Number(fuel) || undefined, lines: extras.length ? extras : undefined });
      const how = r.transmissions.length ? r.transmissions.map((t) => `${METHOD_LABEL[t.method]} to ${t.partnerKey === "receiving" ? "the customer's system" : t.partnerKey}: ${t.status.toLowerCase()}${t.error ? ` (${t.error})` : ""}`).join("\n") : "Delivered in the app to the customer.";
      notify(`Invoice ${r.invoice.invoiceNumber} · ${money(r.invoice.total)}`, how);
      await refreshMe();
      nav.goBack();
    } catch (e) {
      notify("Couldn't send the invoice", errorMessage(e));
    }
  };

  return (
    <Screen>
      <Section title="Charges" footer="Linehaul comes from the agreed rate.">
        <Padded>
          <Field label="Fuel surcharge (%)" value={fuel} onChangeText={setFuel} keyboardType="decimal-pad" />
          {extras.map((x, i) => (
            <Body key={i}>
              {titleCase(x.code)} · {x.quantity} × {money(x.rate)}
            </Body>
          ))}
          <Segmented options={ACCESSORIALS.map((a) => ({ value: a.value, label: a.label }))} value={code} onChange={setCode} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field label="Quantity / hours" value={qty} onChangeText={setQty} keyboardType="decimal-pad" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Rate (USD)" value={rate} onChangeText={setRate} keyboardType="decimal-pad" />
            </View>
          </View>
          <Button
            title="Add charge"
            variant="tonal"
            disabled={!Number(rate) || !Number(qty)}
            onPress={() => {
              setExtras([...extras, { code, description: ACCESSORIALS.find((a) => a.value === code)!.label, quantity: Number(qty), rate: Number(rate) }]);
              setRate("");
              setQty("1");
            }}
          />
        </Padded>
      </Section>
      {owed?.total && !extras.some((x) => x.code === "DETENTION") ? (
        <Section title="Detention" footer="Added to the invoice from the stop times. Add a Detention charge above to replace it.">
          {owed.stops
            .filter((s) => s.billableMinutes > 0 && !s.atStop)
            .map((s) => (
              <Row key={s.stopId} title={`${s.name}, ${s.city}`} subtitle={visitLine(s)} value={money(s.amount)} />
            ))}
        </Section>
      ) : null}
      <Section>
        <Padded>
          <Button title="Send invoice" onPress={send} />
        </Padded>
      </Section>
    </Screen>
  );
}
