import { useState } from "react";
import { Alert, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { api, errorMessage } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { type StackParams, useNav } from "../navigation/types";
import { useMe } from "../state/MeProvider";
import { Body, Button, Chip, Field, Padded, Row, Screen, Section } from "../ui/components";
import { titleCase } from "../ui/format";

const TARGET: Record<string, keyof StackParams> = {
  loads: "Loads",
  navigate: "Navigate",
  board: "Board",
  messages: "Messages",
  money: "Money",
  business: "Business",
  fleet: "Business",
  "distribution-centers": "Business",
  integrations: "Integrations",
  "register-company": "RegisterCompany",
  account: "Security",
  security: "Security",
};

export function MoreScreen() {
  const { me } = useMe();
  const nav = useNav();
  if (!me) return null;
  return (
    <Screen>
      <Section>
        <Row title={me.account.name} subtitle={`${me.account.email} · ${titleCase(me.account.profileType)}${me.ownerOperator ? " · owner-operator" : ""}`} onPress={() => nav.navigate("Security")} />
      </Section>
      <Section>
        {me.workspace.more
          .filter((m) => m.id !== "account")
          .map((m) => (
            <Row key={m.id} title={m.title} onPress={() => nav.navigate(TARGET[m.id] as never)} />
          ))}
      </Section>
    </Screen>
  );
}

export function SecurityScreen() {
  const { me } = useMe();
  const { signOut } = useAuth();
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>();
  if (!me) return null;
  return (
    <Screen>
      <Section title="Account">
        <Row title="Name" value={me.account.name} />
        <Row title="Email" value={me.account.email} />
        <Row title="Profile" value={titleCase(me.account.profileType)} />
        <Row title="Two-factor authentication" value={me.account.mfaEnabled ? "On" : "Off"} />
      </Section>
      <Section title="Recovery codes" footer="Generating new codes invalidates the old ones.">
        <Padded>
          {codes ? (
            <>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {codes.map((c) => (
                  <Chip key={c} label={c} />
                ))}
              </View>
              <Button title="Copy codes" variant="tonal" onPress={() => Clipboard.setStringAsync(codes.join("\n"))} />
            </>
          ) : (
            <>
              <Body secondary>Enter a code from your authenticator app to create new recovery codes.</Body>
              <Field label="Authenticator code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} textContentType="oneTimeCode" />
              <Button
                title="Create new recovery codes"
                variant="tonal"
                disabled={code.length !== 6}
                onPress={async () => {
                  try {
                    setCodes((await api.post<{ recoveryCodes: string[] }>("/v1/auth/mfa/recovery-codes", { code })).recoveryCodes);
                  } catch (e) {
                    Alert.alert("Couldn't create codes", errorMessage(e));
                  }
                }}
              />
            </>
          )}
        </Padded>
      </Section>
      <Section>
        <Row title="Sign out" destructive onPress={() => void signOut()} />
      </Section>
    </Screen>
  );
}
