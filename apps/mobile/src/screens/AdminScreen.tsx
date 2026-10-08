import { tx } from "@logisticspro/workspace";
import { useFocusEffect } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { useT } from "../state/MeProvider";
import { notify } from "../ui/dialog";
import { Body, Button, Chip, Empty, Field, Padded, Row, Screen, Section } from "../ui/components";

type Profile = "TRUCKER" | "CARRIER" | "BROKER_3PL" | "BUSINESS";
type Kind = "CARRIER" | "BROKER_3PL" | "SHIPPER";

interface AdminAccount {
  id: string;
  name: string;
  email: string;
  profileType: Profile;
  test: boolean;
  platformAdmin: boolean;
  orgs: Array<{ id: string; name: string; kinds: Kind[]; roles: string[] }>;
}
interface AdminOrg {
  id: string;
  name: string;
  kinds: Kind[];
  members: number;
}

const PROFILES: Array<{ value: Profile; label: string }> = [
  { value: "TRUCKER", label: tx("Trucker") },
  { value: "CARRIER", label: tx("Carrier") },
  { value: "BROKER_3PL", label: tx("3PL") },
  { value: "BUSINESS", label: tx("Business") },
];
const PROFILE_LABEL = Object.fromEntries(PROFILES.map((p) => [p.value, p.label])) as Record<Profile, string>;
const KIND_LABEL: Record<Kind, string> = { CARRIER: tx("Carrier"), BROKER_3PL: tx("3PL"), SHIPPER: tx("Shipper") };

/**
 * For the people who run this deployment (LP_ADMIN_EMAILS): every account and
 * company, new accounts and companies for setup, and test accounts of each
 * kind to switch into and see the app as that user.
 */
export function AdminScreen() {
  const t = useT();
  const { switchTo } = useAuth();
  const [accounts, setAccounts] = useState<AdminAccount[]>();
  const [orgs, setOrgs] = useState<AdminOrg[]>();
  const [error, setError] = useState<string>();

  const [test, setTest] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [profile, setProfile] = useState<Profile>("CARRIER");
  const [company, setCompany] = useState("");
  const [driverFor, setDriverFor] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [handover, setHandover] = useState<{ name: string; email: string; password: string }>();

  const load = useCallback(async () => {
    try {
      const [a, o] = await Promise.all([api.get<AdminAccount[]>("/v1/admin/accounts"), api.get<AdminOrg[]>("/v1/admin/orgs")]);
      setAccounts(a);
      setOrgs(o);
      setError(undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ account: AdminAccount; temporaryPassword?: string }>("/v1/admin/accounts", {
        name: name.trim(),
        profileType: profile,
        test,
        ...(test ? {} : { email: email.trim() }),
        ...(company.trim() ? { company: { name: company.trim() } } : {}),
        ...(profile === "TRUCKER" && driverFor ? { driverFor } : {}),
      });
      if (r.temporaryPassword) setHandover({ name: r.account.name, email: r.account.email, password: r.temporaryPassword });
      setName("");
      setEmail("");
      setCompany("");
      setDriverFor(undefined);
      await load();
    } catch (e) {
      notify(t("Couldn't create the account"), errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const describe = (a: AdminAccount) => [t(PROFILE_LABEL[a.profileType]), ...a.orgs.map((o) => o.name)].join(" · ");

  if (error) return <Screen><Empty title={t("Couldn't load accounts")} message={error} /></Screen>;
  if (!accounts || !orgs) return <Screen><Empty title={t("Loading…")} /></Screen>;
  const testAccounts = accounts.filter((a) => a.test);
  const people = accounts.filter((a) => !a.test);
  const carriers = orgs.filter((o) => o.kinds.includes("CARRIER"));

  return (
    <Screen onRefresh={load}>
      <Section
        title={t("New account")}
        footer={test ? t("Test accounts are for trying the app as each kind of user. Nobody can sign in to them; switch into them below.") : t("They sign in with their email and a one-time password, then set up two-factor themselves.")}
      >
        <Padded>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Chip label={t("Test account")} selected={test} onPress={() => setTest(true)} />
            <Chip label={t("Real person")} selected={!test} onPress={() => setTest(false)} />
          </View>
          <Field label={t("Name")} value={name} onChangeText={setName} placeholder={test ? t("e.g. Test Driver") : undefined} />
          {test ? null : <Field label={t("Email")} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />}
          <Body secondary>{t("Kind of account")}</Body>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {PROFILES.map((p) => (
              <Chip key={p.value} label={t(p.label)} selected={profile === p.value} onPress={() => setProfile(p.value)} />
            ))}
          </View>
          <Field label={t("Company")} hint={profile === "TRUCKER" ? t("Optional. A trucker with a company is an owner-operator.") : t("Optional. The account owns this company.")} value={company} onChangeText={setCompany} />
          {profile === "TRUCKER" && carriers.length ? (
            <>
              <Body secondary>{t("Drives for")}</Body>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <Chip label={t("No carrier")} selected={!driverFor} onPress={() => setDriverFor(undefined)} />
                {carriers.map((c) => (
                  <Chip key={c.id} label={c.name} selected={driverFor === c.id} onPress={() => setDriverFor(c.id)} />
                ))}
              </View>
            </>
          ) : null}
          <Button title={t("Create account")} onPress={create} loading={busy} disabled={!name.trim() || (!test && !email.trim())} />
        </Padded>
      </Section>

      {handover ? (
        <Section title={t("One-time password")} footer={t("Shown only now. Give it to {name} with their email, {email}.", { name: handover.name, email: handover.email })}>
          <Row title={handover.password} />
          <Padded>
            <Button title={t("Copy password")} variant="tonal" onPress={() => Clipboard.setStringAsync(handover.password)} />
          </Padded>
        </Section>
      ) : null}

      <Section title={t("Test accounts")} footer={testAccounts.length ? t("Tap one to use the app as it. A bar at the top takes you back.") : undefined}>
        {testAccounts.length ? (
          testAccounts.map((a) => (
            <Row
              key={a.id}
              title={a.name}
              subtitle={describe(a)}
              value={t("Switch")}
              accessibilityHint={t("Use the app as this account")}
              onPress={() => void switchTo(a.id).catch((e) => notify(t("Couldn't switch"), errorMessage(e)))}
            />
          ))
        ) : (
          <Row title={t("No test accounts yet")} subtitle={t("Make one of each kind above to see how the app looks for them.")} />
        )}
      </Section>

      <Section title={t("People")}>
        {people.map((a) => (
          <Row key={a.id} title={a.name} subtitle={`${a.email}\n${describe(a)}`} right={a.platformAdmin ? <Chip label={t("Admin")} tone="info" /> : undefined} />
        ))}
      </Section>

      <Section title={t("Companies")}>
        {orgs.length ? (
          orgs.map((o) => <Row key={o.id} title={o.name} subtitle={`${o.kinds.map((k) => t(KIND_LABEL[k])).join(", ")} · ${t(o.members === 1 ? "{n} member" : "{n} members", { n: o.members })}`} />)
        ) : (
          <Row title={t("No companies yet")} />
        )}
      </Section>
    </Screen>
  );
}
