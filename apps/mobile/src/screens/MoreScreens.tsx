import { useState } from "react";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { api, errorMessage } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { type StackParams, useNav } from "../navigation/types";
import { notify } from "../ui/dialog";
import { useMe, useT } from "../state/MeProvider";
import { Body, Button, Chip, Field, Padded, Row, Screen, Section } from "../ui/components";
import { titleCase } from "../ui/format";
import { type Lang, PICKABLE_LANGUAGES } from "@logisticspro/workspace";

const TARGET: Record<string, keyof StackParams> = {
  loads: "Loads",
  track: "Track",
  navigate: "Navigate",
  board: "Board",
  messages: "Messages",
  money: "Money",
  business: "Business",
  fleet: "Business",
  "distribution-centers": "Business",
  integrations: "Integrations",
  "register-company": "RegisterCompany",
  "join-carrier": "JoinCarrier",
  reliability: "Reliability",
  alerts: "Alerts",
  hours: "Hours",
  "fuel-tax": "FuelTax",
  insights: "Insights",
  notifications: "Notifications",
  account: "Security",
  security: "Security",
};

export function MoreScreen() {
  const { me, t, lang, setLanguage } = useMe();
  const nav = useNav();
  if (!me) return null;
  return (
    <Screen>
      <Section>
        <Row title={me.account.name} subtitle={`${me.account.email} · ${t(titleCase(me.account.profileType))}${me.ownerOperator ? ` · ${t("owner-operator")}` : ""}`} onPress={() => nav.navigate("Security")} />
      </Section>
      <Section>
        {me.workspace.more
          .filter((m) => m.id !== "account")
          .map((m) => (
            <Row key={m.id} title={t(m.title)} onPress={() => nav.navigate(TARGET[m.id] as never)} />
          ))}
      </Section>
      {me.capabilities.includes("DRIVE") ? (
        <Section>
          <Row title={t("My pay")} subtitle={t("Pay statements from your carrier")} onPress={() => nav.navigate("MyPay")} />
        </Section>
      ) : null}
      {me.platformAdmin ? (
        <Section>
          <Row title={t("Setup status")} subtitle={t("What this deployment is connected to")} onPress={() => nav.navigate("Setup")} />
        </Section>
      ) : null}
      <Section title={t("Language")} footer={t("Also used for your Today list and notifications.")}>
        <View style={{ flexDirection: "row", gap: 8, padding: 16 }}>
          {PICKABLE_LANGUAGES.map((l) => (
            <Chip key={l.code} label={l.name} selected={lang === l.code} onPress={() => void setLanguage(l.code as Lang).catch((e) => notify(t("Couldn't save"), errorMessage(e)))} />
          ))}
        </View>
      </Section>
    </Screen>
  );
}

export function SecurityScreen() {
  const t = useT();
  const { me } = useMe();
  const { signOut } = useAuth();
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>();
  if (!me) return null;
  return (
    <Screen>
      <Section title={t("Account")}>
        <Row title={t("Name")} value={me.account.name} />
        <Row title={t("Email")} value={me.account.email} />
        <Row title={t("Profile")} value={t(titleCase(me.account.profileType))} />
        <Row title={t("Two-factor authentication")} value={t(me.account.mfaEnabled ? "On" : "Off")} />
      </Section>
      <Section title={t("Recovery codes")} footer={t("Generating new codes invalidates the old ones.")}>
        <Padded>
          {codes ? (
            <>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {codes.map((c) => (
                  <Chip key={c} label={c} />
                ))}
              </View>
              <Button title={t("Copy codes")} variant="tonal" onPress={() => Clipboard.setStringAsync(codes.join("\n"))} />
            </>
          ) : (
            <>
              <Body secondary>{t("Enter a code from your authenticator app to create new recovery codes.")}</Body>
              <Field label={t("Authenticator code")} value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} textContentType="oneTimeCode" />
              <Button
                title={t("Create new recovery codes")}
                variant="tonal"
                disabled={code.length !== 6}
                onPress={async () => {
                  try {
                    setCodes((await api.post<{ recoveryCodes: string[] }>("/v1/auth/mfa/recovery-codes", { code })).recoveryCodes);
                  } catch (e) {
                    notify(t("Couldn't create codes"), errorMessage(e));
                  }
                }}
              />
            </>
          )}
        </Padded>
      </Section>
      <Section>
        <Row title={t("Sign out")} destructive onPress={() => void signOut()} />
      </Section>
    </Screen>
  );
}
