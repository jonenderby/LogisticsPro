import { useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import { Body, Button, Field, Padded, Row, Section, Segmented, ToggleRow } from "../ui/components";
import { notify } from "../ui/dialog";
import { when } from "../ui/format";
import { useT } from "../state/MeProvider";

interface PayerTerms {
  termsDays: number;
  quickPay?: { days: number; feePct: number };
}

/** A shipper's or broker's terms, shown on every rate confirmation and used for due dates. */
export function PayerTermsSection({ orgId, terms, onSaved }: { orgId: string; terms?: PayerTerms; onSaved: () => unknown }) {
  const t = useT();
  const [days, setDays] = useState(String(terms?.termsDays ?? 30));
  const [offer, setOffer] = useState(!!terms?.quickPay);
  const [qpDays, setQpDays] = useState(String(terms?.quickPay?.days ?? 2));
  const [fee, setFee] = useState(String(terms?.quickPay?.feePct ?? 3));
  const save = async () => {
    try {
      await api.put(`/v1/orgs/${orgId}/payer-terms`, { termsDays: Number(days), quickPay: offer ? { days: Number(qpDays), feePct: Number(fee) } : undefined });
      await onSaved();
      notify(t("Payment terms saved"), t("New rate confirmations and invoices use them."));
    } catch (e) {
      notify(t("Couldn't save"), errorMessage(e));
    }
  };
  return (
    <Section title={t("Paying carriers")} footer={t("Invoices are due this many days after they arrive. With quick pay, a carrier can ask to be paid sooner for a fee; you approve each request.")}>
      <Padded>
        <Field label={t("Pay within (days)")} value={days} onChangeText={setDays} keyboardType="number-pad" />
      </Padded>
      <ToggleRow title={t("Offer quick pay")} value={offer} onChange={setOffer} />
      {offer ? (
        <Padded>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field label={t("Quick pay within (days)")} value={qpDays} onChangeText={setQpDays} keyboardType="number-pad" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label={t("Fee (%)")} value={fee} onChangeText={setFee} keyboardType="decimal-pad" />
            </View>
          </View>
        </Padded>
      ) : null}
      <Padded>
        <Button title={t("Save payment terms")} variant="tonal" disabled={Number.isNaN(Number(days)) || (offer && (Number.isNaN(Number(qpDays)) || Number.isNaN(Number(fee))))} onPress={save} />
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
  const t = useT();
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
      notify(remove ? t("Payments come to you again") : t("Payments go to {company}", { company: company.trim() }), t(r.customersNotified === 1 ? "New invoices use this. {n} customer was told." : "New invoices use this. {n} customers were told.", { n: r.customersNotified }));
    } catch (e) {
      notify(t("Couldn't change where you get paid"), errorMessage(e));
    }
  };
  return (
    <Section title={t("Getting paid")} footer={t("Invoices already sent keep the remit-to they were sent with. Your customers and your owners are told about every change.")}>
      <Row title={t("Remit to")} subtitle={factoring ? `${factoring.company} (${t("factoring")})${factoring.email ? `\n${factoring.email}` : ""}\n${t("Since {date}", { date: when(factoring.since) })}` : t("Your company")} />
      {editing ? (
        <Padded>
          <Field label={t("Factoring company")} value={company} onChangeText={setCompany} />
          <Field label={t("Factoring company email (optional)")} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
          <Field label={t("Authenticator code")} value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={8} hint={t("From your authenticator app, to confirm it's you")} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button title={t("Save")} disabled={!company.trim() || code.length < 6} onPress={() => submit(false)} style={{ flex: 1 }} />
            {factoring ? <Button title={t("Stop factoring")} variant="destructive" disabled={code.length < 6} onPress={() => submit(true)} style={{ flex: 1 }} /> : null}
          </View>
          <Button title={t("Cancel")} variant="plain" onPress={() => setEditing(false)} />
        </Padded>
      ) : (
        <Padded>
          <Button title={t(factoring ? "Change factoring company" : "Use a factoring company")} variant="tonal" onPress={() => setEditing(true)} />
        </Padded>
      )}
      <Body secondary style={{ marginHorizontal: 16, marginBottom: 8 }}>{t("Never change this because of an email or a call. Fraudsters pose as factoring companies to redirect payments.")}</Body>
    </Section>
  );
}

interface PayoutAccount {
  holderName: string;
  routingNumber: string;
  last4: string;
  accountType: "CHECKING" | "SAVINGS";
  setAt: string;
}

/**
 * The bank account a carrier (or its factoring company) is paid to by ACH.
 * Like the remit-to, a change takes an authenticator code and customers are told.
 */
export function BankAccountSection({ orgId, account, factoring, onSaved }: { orgId: string; account?: PayoutAccount; factoring?: boolean; onSaved: () => unknown }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [holder, setHolder] = useState("");
  const [routing, setRouting] = useState("");
  const [number, setNumber] = useState("");
  const [type, setType] = useState<"CHECKING" | "SAVINGS">("CHECKING");
  const [code, setCode] = useState("");
  const submit = async (remove: boolean) => {
    try {
      const r = await api.put<{ customersNotified: number }>(`/v1/orgs/${orgId}/payout-account`, remove ? { remove: true, code } : { holderName: holder.trim(), routingNumber: routing.trim(), accountNumber: number.trim(), accountType: type, code });
      setEditing(false);
      setCode("");
      setNumber("");
      await onSaved();
      notify(remove ? t("Bank details removed") : t("Bank details saved"), t(r.customersNotified === 1 ? "New invoices use this. {n} customer was told." : "New invoices use this. {n} customers were told.", { n: r.customersNotified }));
    } catch (e) {
      notify(t("Couldn't change where you get paid"), errorMessage(e));
    }
  };
  return (
    <Section title={t("Bank account for ACH")} footer={factoring ? t("Enter your factoring company's account. Changing the factoring company removes it.") : t("Customers who pay by ACH send to this account. Invoices keep the account they were sent with.")}>
      <Row title={account ? `${account.holderName} · ${t("ending {last4}", { last4: account.last4 })}` : t("No bank account")} subtitle={account ? `${t(account.accountType === "SAVINGS" ? "Savings" : "Checking")} · ${t("routing {n}", { n: account.routingNumber })} · ${t("Since {date}", { date: when(account.setAt) })}` : t("Customers pay you by check or record payments by hand until you add one.")} />
      {editing ? (
        <Padded>
          <Field label={t("Name on the account")} value={holder} onChangeText={setHolder} />
          <Field label={t("Routing number")} value={routing} onChangeText={setRouting} keyboardType="number-pad" maxLength={9} />
          <Field label={t("Account number")} value={number} onChangeText={setNumber} keyboardType="number-pad" maxLength={17} secureTextEntry />
          <Segmented options={[{ value: "CHECKING", label: t("Checking") }, { value: "SAVINGS", label: t("Savings") }]} value={type} onChange={setType} />
          <Field label={t("Authenticator code")} value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={8} hint={t("From your authenticator app, to confirm it's you")} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button title={t("Save")} disabled={!holder.trim() || routing.length !== 9 || number.length < 4 || code.length < 6} onPress={() => submit(false)} style={{ flex: 1 }} />
            {account ? <Button title={t("Remove")} variant="destructive" disabled={code.length < 6} onPress={() => submit(true)} style={{ flex: 1 }} /> : null}
          </View>
          <Button title={t("Cancel")} variant="plain" onPress={() => setEditing(false)} />
        </Padded>
      ) : (
        <Padded>
          <Button title={t(account ? "Change bank account" : "Add bank account")} variant="tonal" onPress={() => setEditing(true)} />
        </Padded>
      )}
    </Section>
  );
}

interface AchOriginator {
  companyName: string;
  companyId: string;
  bankRoutingNumber: string;
  bankName: string;
}

/** A shipper's or broker's bank details for ACH payment files, from its bank's ACH setup. */
export function AchOriginatorSection({ orgId, originator, onSaved }: { orgId: string; originator?: AchOriginator; onSaved: () => unknown }) {
  const t = useT();
  const [name, setName] = useState(originator?.companyName ?? "");
  const [companyId, setCompanyId] = useState(originator?.companyId ?? "");
  const [routing, setRouting] = useState(originator?.bankRoutingNumber ?? "");
  const [bank, setBank] = useState(originator?.bankName ?? "");
  const save = async () => {
    try {
      await api.put(`/v1/orgs/${orgId}/ach-originator`, { companyName: name.trim(), companyId: companyId.trim(), bankRoutingNumber: routing.trim(), bankName: bank.trim() });
      await onSaved();
      notify(t("Saved"), t("You can now pay approved invoices by ACH from Money."));
    } catch (e) {
      notify(t("Couldn't save"), errorMessage(e));
    }
  };
  return (
    <Section title={t("Paying by ACH")} footer={t("From your bank's ACH setup. Payment files are made for your bank to upload.")}>
      <Padded>
        <Field label={t("Company name on statements (16 characters)")} value={name} onChangeText={setName} maxLength={16} />
        <Field label={t("ACH company ID (10 characters)")} value={companyId} onChangeText={setCompanyId} maxLength={10} autoCapitalize="characters" />
        <Field label={t("Your bank's routing number")} value={routing} onChangeText={setRouting} keyboardType="number-pad" maxLength={9} />
        <Field label={t("Your bank's name")} value={bank} onChangeText={setBank} maxLength={23} />
        <Button title={t("Save")} variant="tonal" disabled={!name.trim() || companyId.trim().length !== 10 || routing.length !== 9 || !bank.trim()} onPress={save} />
      </Padded>
    </Section>
  );
}
