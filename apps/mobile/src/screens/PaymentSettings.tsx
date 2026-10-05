import { useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import { Body, Button, Field, Padded, Row, Section, ToggleRow } from "../ui/components";
import { notify } from "../ui/dialog";
import { when } from "../ui/format";

interface PayerTerms {
  termsDays: number;
  quickPay?: { days: number; feePct: number };
}

/** A shipper's or broker's terms, shown on every rate confirmation and used for due dates. */
export function PayerTermsSection({ orgId, terms, onSaved }: { orgId: string; terms?: PayerTerms; onSaved: () => unknown }) {
  const [days, setDays] = useState(String(terms?.termsDays ?? 30));
  const [offer, setOffer] = useState(!!terms?.quickPay);
  const [qpDays, setQpDays] = useState(String(terms?.quickPay?.days ?? 2));
  const [fee, setFee] = useState(String(terms?.quickPay?.feePct ?? 3));
  const save = async () => {
    try {
      await api.put(`/v1/orgs/${orgId}/payer-terms`, { termsDays: Number(days), quickPay: offer ? { days: Number(qpDays), feePct: Number(fee) } : undefined });
      await onSaved();
      notify("Payment terms saved", "New rate confirmations and invoices use them.");
    } catch (e) {
      notify("Couldn't save", errorMessage(e));
    }
  };
  return (
    <Section title="Paying carriers" footer="Invoices are due this many days after they arrive. With quick pay, a carrier can ask to be paid sooner for a fee; you approve each request.">
      <Padded>
        <Field label="Pay within (days)" value={days} onChangeText={setDays} keyboardType="number-pad" />
      </Padded>
      <ToggleRow title="Offer quick pay" value={offer} onChange={setOffer} />
      {offer ? (
        <Padded>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field label="Quick pay within (days)" value={qpDays} onChangeText={setQpDays} keyboardType="number-pad" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Fee (%)" value={fee} onChangeText={setFee} keyboardType="decimal-pad" />
            </View>
          </View>
        </Padded>
      ) : null}
      <Padded>
        <Button title="Save payment terms" variant="tonal" disabled={Number.isNaN(Number(days)) || (offer && (Number.isNaN(Number(qpDays)) || Number.isNaN(Number(fee))))} onPress={save} />
      </Padded>
    </Section>
  );
}

interface Factoring {
  company: string;
  email?: string;
  since: string;
}

/**
 * Who a carrier's invoices are paid to. Changing it takes an authenticator
 * code, and customers are told, because redirecting payments is how freight
 * fraud gets paid.
 */
export function FactoringSection({ orgId, factoring, onSaved }: { orgId: string; factoring?: Factoring; onSaved: () => unknown }) {
  const [editing, setEditing] = useState(false);
  const [company, setCompany] = useState(factoring?.company ?? "");
  const [email, setEmail] = useState(factoring?.email ?? "");
  const [code, setCode] = useState("");
  const submit = async (remove: boolean) => {
    try {
      const r = await api.put<{ customersNotified: number }>(`/v1/orgs/${orgId}/factoring`, remove ? { company: null, code } : { company: company.trim(), email: email.trim() || undefined, code });
      setEditing(false);
      setCode("");
      await onSaved();
      notify(remove ? "Payments come to you again" : `Payments go to ${company.trim()}`, `New invoices use this. ${r.customersNotified} customer${r.customersNotified === 1 ? " was" : "s were"} told.`);
    } catch (e) {
      notify("Couldn't change where you get paid", errorMessage(e));
    }
  };
  return (
    <Section title="Getting paid" footer="Invoices already sent keep the remit-to they were sent with. Your customers and your owners are told about every change.">
      <Row title="Remit to" subtitle={factoring ? `${factoring.company} (factoring)${factoring.email ? `\n${factoring.email}` : ""}\nSince ${when(factoring.since)}` : "Your company"} />
      {editing ? (
        <Padded>
          <Field label="Factoring company" value={company} onChangeText={setCompany} />
          <Field label="Factoring company email (optional)" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
          <Field label="Authenticator code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={8} hint="From your authenticator app, to confirm it's you" />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button title="Save" disabled={!company.trim() || code.length < 6} onPress={() => submit(false)} style={{ flex: 1 }} />
            {factoring ? <Button title="Stop factoring" variant="destructive" disabled={code.length < 6} onPress={() => submit(true)} style={{ flex: 1 }} /> : null}
          </View>
          <Button title="Cancel" variant="plain" onPress={() => setEditing(false)} />
        </Padded>
      ) : (
        <Padded>
          <Button title={factoring ? "Change factoring company" : "Use a factoring company"} variant="tonal" onPress={() => setEditing(true)} />
        </Padded>
      )}
      <Body secondary style={{ marginHorizontal: 16, marginBottom: 8 }}>Never change this because of an email or a call. Fraudsters pose as factoring companies to redirect payments.</Body>
    </Section>
  );
}
