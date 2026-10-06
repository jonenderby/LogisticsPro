import { tx, type Translate } from "@logisticspro/workspace";
import { useFocusEffect } from "@react-navigation/native";
import { type DetentionView, visitLine } from "../ui/detention";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import type { Invoice, Load, Transmission } from "../api/types";
import { notify } from "../ui/dialog";
import { useNav, useParams } from "../navigation/types";
import { useMe, useT } from "../state/MeProvider";
import { Banner, Body, Button, Chip, Empty, Field, Padded, Row, Screen, Section, Segmented } from "../ui/components";
import { money, titleCase, when } from "../ui/format";
import { type DocView, DocumentRows } from "../ui/Documents";

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
  documents: DocView[];
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
  ["CURRENT", tx("Not due yet")],
  ["DAYS_1_30", tx("1–30 days late")],
  ["DAYS_31_60", tx("31–60 days late")],
  ["DAYS_61_90", tx("61–90 days late")],
  ["DAYS_90_PLUS", tx("Over 90 days late")],
];

export const INVOICE_STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info" }> = {
  DRAFT: { label: tx("Draft"), tone: "neutral" },
  SENT: { label: tx("Sent"), tone: "info" },
  ACKNOWLEDGED: { label: tx("Received"), tone: "info" },
  APPROVED: { label: tx("Approved"), tone: "info" },
  PARTIALLY_PAID: { label: tx("Part paid"), tone: "warning" },
  PAID: { label: tx("Paid"), tone: "success" },
  DISPUTED: { label: tx("Disputed"), tone: "danger" },
  REJECTED: { label: tx("Rejected"), tone: "danger" },
};

const statusChip = (i: InvoiceView, t: Translate) =>
  i.daysLate > 0 ? <Chip label={t("{n} days late", { n: i.daysLate })} tone="danger" /> : <Chip label={t(INVOICE_STATUS[i.status]?.label ?? titleCase(i.status))} tone={INVOICE_STATUS[i.status]?.tone ?? "neutral"} />;

function AgingSection({ title, side, parties }: { title: string; side: AgingSide; parties: Array<{ orgId: string; name: string; open: number; overdue: number }> }) {
  const t = useT();
  return (
    <Section title={title} footer={side.averageDaysToPay !== undefined ? t("Paid in full on average {n} days after the invoice.", { n: side.averageDaysToPay }) : undefined}>
      <Row title={t("Open")} value={money(side.open)} />
      {BUCKETS.filter(([b]) => side.buckets[b]?.count).map(([b, bucket]) => (
        <Row key={b} title={t(bucket)} subtitle={t(side.buckets[b]!.count === 1 ? "1 invoice" : "{n} invoices", { n: side.buckets[b]!.count })} value={money(side.buckets[b]!.amount)} />
      ))}
      {parties.length > 1 ? parties.slice(0, 5).map((p) => <Row key={p.orgId} title={p.name} subtitle={p.overdue ? t("{amount} overdue", { amount: money(p.overdue) }) : t("Nothing overdue")} value={money(p.open)} />) : null}
    </Section>
  );
}

export function MoneyScreen() {
  const t = useT();
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
    <Row key={i.id} title={`${i.invoiceNumber} · ${money(i.total, i.currency)}`} subtitle={`${who ? `${who} · ` : ""}${t("Load {n}", { n: i.loadNumber })} · ${open(i) ? `${t("due {date}", { date: i.dueDate })}${i.paid ? ` · ${t("{amount} left", { amount: money(i.balance) })}` : ""}` : when(i.issuedAt)}${i.quickPay?.status === "REQUESTED" ? ` · ${t("quick pay asked")}` : ""}`} right={statusChip(i, t)} onPress={() => nav.navigate("InvoiceDetail", { id: i.id })} />
  );
  const payerOrgs = (me?.orgs ?? []).filter((o) => o.kinds.some((k) => k === "SHIPPER" || k === "BROKER_3PL") && o.roles.some((r) => ["OWNER", "ADMIN", "BILLING"].includes(r)));
  const receivables = agingByOrg.find((a) => a.receivable)?.receivable;
  const payables = agingByOrg.find((a) => a.payable)?.payable;

  return (
    <Screen onRefresh={refresh}>
      {ready.length ? (
        <Section title={t("Ready to invoice")}>
          {ready.map((l) => (
            <Row key={l.id} title={l.loadNumber} subtitle={t("Delivered {date}", { date: when(l.deliveredAt) })} value={money(l.rate?.amount)} onPress={() => nav.navigate("SendInvoice", { loadId: l.id })} />
          ))}
        </Section>
      ) : null}
      {receivables ? <AgingSection title={t("Owed to you")} side={receivables} parties={receivables.customers} /> : null}
      {receivable.length || !payable.length ? (
        <Section title={t("Invoices sent")}>
          {receivable.length === 0 ? <Empty title={t("No invoices yet")} /> : null}
          {receivable.map((i) => row(i, i.billToName))}
        </Section>
      ) : null}
      {payables ? <AgingSection title={t("You owe")} side={payables} parties={payables.carriers} /> : null}
      {payable.length ? (
        <Section title={t("Invoices to pay")}>
          {payerOrgs.map((o) => (
            <Row key={o.id} title={t("Pay by ACH")} subtitle={payerOrgs.length > 1 ? o.name : t("Make a payment file for your bank")} onPress={() => nav.navigate("AchPayments", { orgId: o.id })} />
          ))}
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
  const t = useT();
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
      notify(t("Couldn't update the invoice"), errorMessage(e));
    }
  };
  const status = (s: string) => act(() => api.post(`/v1/invoices/${id}/status`, { status: s, note: note.trim() || undefined }));
  const isOpen = ["SENT", "ACKNOWLEDGED", "APPROVED", "PARTIALLY_PAID", "DISPUTED"].includes(inv.status);
  const qp = inv.quickPay;

  return (
    <Screen onRefresh={load}>
      {inv.status === "DISPUTED" || inv.status === "REJECTED" ? <Banner tone="danger" title={inv.status === "DISPUTED" ? tx("Disputed") : tx("Rejected")} message={inv.disputeReason} /> : null}
      {inv.daysLate > 0 ? <Banner tone="warning" title={t("{n} days past due", { n: inv.daysLate })} message={t("Was due {date}. {amount} still owed.", { date: inv.dueDate, amount: money(inv.balance) })} /> : null}
      <Section title={`${inv.carrierName ?? "Carrier"} to ${inv.billToName ?? "customer"}`}>
        <Row title={t("Status")} right={statusChip(inv, t)} />
        <Row title={t("Load")} value={inv.loadNumber} onPress={() => nav.navigate("LoadDetail", { id: inv.loadId })} />
        <Row title={t("Invoice date")} value={inv.issuedAt.slice(0, 10)} />
        <Row title={t("Due")} value={`${inv.dueDate} (${qp?.status === "APPROVED" ? t("quick pay") : inv.terms})`} />
        <Row title={t("Total")} value={money(inv.total, inv.currency)} />
        {qp?.status === "APPROVED" ? <Row title={t("Quick-pay fee {pct}%", { pct: qp.feePct })} value={`−${money(qp.fee)}`} /> : null}
        {inv.paid ? <Row title={t("Paid")} value={money(inv.paid)} /> : null}
        {isOpen ? <Row title={t("Balance")} value={money(inv.balance)} /> : null}
        {inv.remitTo ? <Row title={t("Pay to")} subtitle={`${inv.remitTo.name}${inv.remitTo.kind === "FACTOR" ? ` (${t("factoring company")})` : ""}${inv.remitTo.email ? `\n${inv.remitTo.email}` : ""}`} /> : null}
      </Section>
      <Section title={t("Charges")}>
        {inv.lines.map((l, i) => (
          <Row key={i} title={l.description} subtitle={l.quantity !== 1 ? `${l.quantity} × ${money(l.rate)}` : undefined} value={money(l.amount)} />
        ))}
      </Section>
      {inv.documents.length ? (
        <Section title={t("Paperwork")}>
          <DocumentRows docs={inv.documents} />
        </Section>
      ) : null}

      {inv.canBill && isOpen && inv.quickPayOffer && (!qp || qp.status === "DECLINED") && inv.status !== "DISPUTED" ? (
        <Section title={t("Quick pay")} footer={t("{payer} pays in {days} days for a {pct}% fee: {net} instead of {total} by {due}.", { payer: inv.billToName, days: inv.quickPayOffer.days, pct: inv.quickPayOffer.feePct, net: money(inv.total * (1 - inv.quickPayOffer.feePct / 100)), total: money(inv.total), due: inv.dueDate })}>
          <Padded>
            <Button title={qp?.status === "DECLINED" ? t("Ask again") : t("Ask for quick pay")} variant="tonal" onPress={act(() => api.post(`/v1/invoices/${id}/quick-pay`, {}), t("Quick pay requested"))} />
          </Padded>
        </Section>
      ) : null}
      {qp?.status === "REQUESTED" ? (
        <Section title={t("Quick pay requested")} footer={t("{net} in {days} days, after a {pct}% fee of {fee}.", { net: money(qp.netAmount), days: qp.days, pct: qp.feePct, fee: money(qp.fee) })}>
          {inv.canPay ? (
            <Padded>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button title={t("Approve")} onPress={act(() => api.post(`/v1/invoices/${id}/quick-pay/decision`, { approve: true }))} style={{ flex: 1 }} />
                <Button title={t("Decline")} variant="destructive" onPress={act(() => api.post(`/v1/invoices/${id}/quick-pay/decision`, { approve: false }))} style={{ flex: 1 }} />
              </View>
            </Padded>
          ) : (
            <Row title={t("Waiting on the customer")} />
          )}
        </Section>
      ) : null}

      {inv.canPay && isOpen ? (
        <>
          <Section title={t("Review")}>
            <Padded>
              <Field label={t("Note (needed to dispute)")} value={note} onChangeText={setNote} placeholder={t("e.g. Detention wasn't on the rate confirmation")} />
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                {inv.status === "SENT" ? <Button title={t("Received")} variant="tonal" onPress={status("ACKNOWLEDGED")} style={{ flex: 1 }} /> : null}
                {["SENT", "ACKNOWLEDGED", "DISPUTED"].includes(inv.status) ? <Button title={t("Approve")} variant="tonal" onPress={status("APPROVED")} style={{ flex: 1 }} /> : null}
                {inv.status !== "DISPUTED" ? <Button title={t("Dispute")} variant="destructive" disabled={!note.trim()} onPress={status("DISPUTED")} style={{ flex: 1 }} /> : null}
              </View>
            </Padded>
          </Section>
          {inv.status !== "DISPUTED" ? (
            <Section title={t("Record a payment")}>
              <Padded>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Field label={t("Amount (USD)")} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field label={t("Reference")} value={reference} onChangeText={setReference} placeholder={t("ACH trace or check no.")} />
                  </View>
                </View>
                <Segmented options={[{ value: "ACH", label: "ACH" }, { value: "CHECK", label: t("Check") }, { value: "WIRE", label: t("Wire") }, { value: "OTHER", label: t("Other") }]} value={method} onChange={setMethod} />
                <Button title={t("Record payment")} disabled={!Number(amount)} onPress={act(() => api.post(`/v1/invoices/${id}/payments`, { amount: Number(amount), method, reference: reference.trim() || undefined }), t("Payment recorded"))} />
              </Padded>
            </Section>
          ) : null}
        </>
      ) : null}

      {inv.payments?.length ? (
        <Section title={t("Payments")}>
          {inv.payments.map((p) => (
            <Row key={p.id} title={money(p.amount)} subtitle={`${p.paidOn} · ${p.method}${p.reference ? ` · ${p.reference}` : ""}`} />
          ))}
        </Section>
      ) : null}
      {inv.history?.length ? (
        <Section title={t("History")}>
          {[...inv.history].reverse().map((h, i) => (
            <Row key={i} title={t(INVOICE_STATUS[h.status]?.label ?? titleCase(h.status))} subtitle={`${when(h.at)}${h.note ? ` · ${h.note}` : ""}`} />
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}

const ACCESSORIALS = [
  { value: "DETENTION", label: tx("Detention") },
  { value: "LUMPER", label: tx("Lumper") },
  { value: "LAYOVER", label: tx("Layover") },
  { value: "STOP_OFF", label: tx("Stop-off") },
] as const;

/**
 * The driver or carrier builds the invoice once. Logistics Pro sends it in
 * whatever format the customer set up: JSON API, XML API or EDI 210.
 */
export function SendInvoiceScreen() {
  const t = useT();
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
      const how = r.transmissions.length ? r.transmissions.map((x) => `${METHOD_LABEL[x.method]} → ${x.partnerKey === "receiving" ? t("the customer's system") : x.partnerKey}: ${t(titleCase(x.status))}${x.error ? ` (${x.error})` : ""}`).join("\n") : t("Delivered in the app to the customer.");
      notify(`${t("Invoice {n}", { n: r.invoice.invoiceNumber })} · ${money(r.invoice.total)}`, how);
      await refreshMe();
      nav.goBack();
    } catch (e) {
      notify(t("Couldn't send the invoice"), errorMessage(e));
    }
  };

  return (
    <Screen>
      <Section title={t("Charges")} footer={t("Linehaul comes from the agreed rate.")}>
        <Padded>
          <Field label={t("Fuel surcharge (%)")} value={fuel} onChangeText={setFuel} keyboardType="decimal-pad" />
          {extras.map((x, i) => (
            <Body key={i}>
              {titleCase(x.code)} · {x.quantity} × {money(x.rate)}
            </Body>
          ))}
          <Segmented options={ACCESSORIALS.map((a) => ({ value: a.value, label: t(a.label) }))} value={code} onChange={setCode} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field label={t("Quantity / hours")} value={qty} onChangeText={setQty} keyboardType="decimal-pad" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label={t("Rate (USD)")} value={rate} onChangeText={setRate} keyboardType="decimal-pad" />
            </View>
          </View>
          <Button
            title={t("Add charge")}
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
        <Section title={t("Detention")} footer={t("Added to the invoice from the stop times. Add a Detention charge above to replace it.")}>
          {owed.stops
            .filter((s) => s.billableMinutes > 0 && !s.atStop)
            .map((s) => (
              <Row key={s.stopId} title={`${s.name}, ${s.city}`} subtitle={visitLine(s, t)} value={money(s.amount)} />
            ))}
        </Section>
      ) : null}
      <Section>
        <Padded>
          <Button title={t("Send invoice")} onPress={send} />
        </Padded>
      </Section>
    </Screen>
  );
}
