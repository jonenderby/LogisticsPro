import { useFocusEffect } from "@react-navigation/native";
import { type DetentionView, visitLine } from "../ui/detention";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import type { Invoice, Load, Transmission } from "../api/types";
import { notify } from "../ui/dialog";
import { useNav, useParams } from "../navigation/types";
import { useMe } from "../state/MeProvider";
import { Body, Button, Chip, Empty, Field, Padded, Row, Screen, Section, Segmented } from "../ui/components";
import { money, titleCase, when } from "../ui/format";

const METHOD_LABEL: Record<string, string> = { API_JSON: "JSON API", API_XML: "XML API", EDI_X12: "EDI 210" };

export function MoneyScreen() {
  const { me, refresh: refreshMe } = useMe();
  const nav = useNav();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [ready, setReady] = useState<Load[]>([]);
  const refresh = useCallback(async () => {
    const [inv, delivered] = await Promise.all([api.get<Invoice[]>("/v1/invoices"), api.get<Load[]>("/v1/loads?status=DELIVERED")]);
    setInvoices(inv);
    setReady(delivered);
  }, []);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  const myOrgs = new Set(me?.orgs.map((o) => o.id));
  const payable = invoices.filter((i) => i.billTo.orgId && myOrgs.has(i.billTo.orgId));
  const receivable = invoices.filter((i) => !payable.includes(i));
  const setStatus = (id: string, status: string) => async () => {
    try {
      await api.post(`/v1/invoices/${id}/status`, { status });
      await Promise.all([refresh(), refreshMe()]);
    } catch (e) {
      notify("Couldn't update invoice", errorMessage(e));
    }
  };

  return (
    <Screen onRefresh={refresh}>
      {ready.length ? (
        <Section title="Ready to invoice">
          {ready.map((l) => (
            <Row key={l.id} title={l.loadNumber} subtitle={`Delivered ${when(l.deliveredAt)}`} value={money(l.rate?.amount)} onPress={() => nav.navigate("SendInvoice", { loadId: l.id })} />
          ))}
        </Section>
      ) : null}
      <Section title="Invoices sent">
        {receivable.length === 0 ? <Empty title="No invoices yet" /> : null}
        {receivable.map((i) => (
          <Row key={i.id} title={`${i.invoiceNumber} · ${money(i.total, i.currency)}`} subtitle={`Load ${i.loadNumber} · ${when(i.issuedAt)}`} right={<Chip label={titleCase(i.status)} tone={i.status === "PAID" ? "success" : i.status === "REJECTED" ? "danger" : "neutral"} />} />
        ))}
      </Section>
      {payable.length ? (
        <Section title="Invoices to pay">
          {payable.map((i) => (
            <View key={i.id}>
              <Row title={`${i.invoiceNumber} · ${money(i.total, i.currency)}`} subtitle={`Load ${i.loadNumber} · ${i.lines.map((l) => `${titleCase(l.code)} ${money(l.amount)}`).join(", ")}`} right={<Chip label={titleCase(i.status)} />} />
              {i.status === "SENT" || i.status === "ACKNOWLEDGED" ? (
                <View style={{ flexDirection: "row", gap: 8, padding: 12 }}>
                  <Button title="Mark paid" onPress={setStatus(i.id, "PAID")} style={{ flex: 1 }} />
                  <Button title="Dispute" variant="destructive" onPress={setStatus(i.id, "REJECTED")} style={{ flex: 1 }} />
                </View>
              ) : null}
            </View>
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
