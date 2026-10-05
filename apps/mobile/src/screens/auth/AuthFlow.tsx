import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { errorMessage } from "../../api/client";
import { type ProfileType, useAuth } from "../../auth/AuthProvider";
import { Banner, Button, Chip, Field, Segmented } from "../../ui/components";
import { useTheme } from "../../ui/theme";

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  const { colors, metrics } = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 24, gap: 8, width: "100%", maxWidth: 480, alignSelf: "center" }} keyboardShouldPersistTaps="handled">
          <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 34, fontWeight: "700", marginTop: 24 }}>
            {title}
          </Text>
          {subtitle ? <Text style={{ color: colors.textSecondary, fontSize: metrics.body, marginBottom: 16 }}>{subtitle}</Text> : null}
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const PROFILES: Array<{ value: ProfileType; label: string; help: string }> = [
  { value: "TRUCKER", label: "Trucker", help: "Drive loads, update status, navigate and invoice. Register your own company later to run it from the same app." },
  { value: "CARRIER", label: "Carrier", help: "Dispatch drivers, bid on loads, plan relays and teams, and invoice customers." },
  { value: "BROKER_3PL", label: "3PL", help: "Post and broker loads, award bids and connect carriers." },
  { value: "BUSINESS", label: "Business", help: "Ship freight, tender to carriers and connect your ERP." },
];

export function AuthFlow() {
  const auth = useAuth();
  const [mode, setMode] = useState<"welcome" | "signIn" | "register">("welcome");
  const [error, setError] = useState<string>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [profileType, setProfileType] = useState<ProfileType>("TRUCKER");
  const [code, setCode] = useState("");
  const { colors } = useTheme();

  const run = (fn: () => Promise<void>) => async () => {
    setError(undefined);
    try {
      await fn();
      setCode("");
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const err = error ? <Banner tone="danger" title="Couldn't continue" message={error} /> : null;
  const phase = auth.phase;

  if (phase.name === "enroll") {
    return (
      <Shell title="Protect your account" subtitle="Two-factor authentication is required. Add Logistics Pro to an authenticator app, then enter the 6-digit code it shows.">
        <Button title="Open authenticator app" variant="tonal" onPress={() => Linking.openURL(phase.otpauthUrl)} accessibilityHint="Adds this account to an installed authenticator app" />
        <View style={{ marginVertical: 12 }}>
          <Text style={{ color: colors.textSecondary }}>Or enter this setup key manually:</Text>
          <Text selectable style={{ color: colors.text, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 16, marginVertical: 6 }}>
            {phase.secret.match(/.{1,4}/g)?.join(" ")}
          </Text>
          <Button title="Copy setup key" variant="plain" onPress={() => Clipboard.setStringAsync(phase.secret)} />
        </View>
        <Field label="6-digit code" value={code} onChangeText={setCode} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={6} returnKeyType="go" onSubmitEditing={() => code.length === 6 && void run(() => auth.activate(code))()} />
        {err}
        <Button title="Turn on two-factor" disabled={code.length !== 6} onPress={run(() => auth.activate(code))} />
        <Button title="Cancel" variant="plain" onPress={auth.cancel} />
      </Shell>
    );
  }

  if (phase.name === "recoveryCodes") {
    return (
      <Shell title="Save your recovery codes" subtitle="Each code signs you in once if you lose your phone. Store them somewhere safe; they will not be shown again.">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: 12 }}>
          {phase.codes.map((c) => (
            <Chip key={c} label={c} />
          ))}
        </View>
        <Button title="Copy codes" variant="tonal" onPress={() => Clipboard.setStringAsync(phase.codes.join("\n"))} />
        <Button title="I saved them" onPress={auth.finishRecoveryCodes} />
      </Shell>
    );
  }

  if (phase.name === "mfa") {
    return (
      <Shell title="Enter your code" subtitle="Open your authenticator app and enter the 6-digit code for Logistics Pro, or use a recovery code.">
        <Field label="Code" value={code} onChangeText={setCode} autoCapitalize="none" textContentType="oneTimeCode" autoComplete="one-time-code" autoFocus returnKeyType="go" onSubmitEditing={() => code.length >= 6 && void run(() => auth.verify(code))()} />
        {err}
        <Button title="Verify" disabled={code.length < 6} onPress={run(() => auth.verify(code))} />
        <Button title="Cancel" variant="plain" onPress={auth.cancel} />
      </Shell>
    );
  }

  if (mode === "signIn") {
    return (
      <Shell title="Sign in">
        <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" textContentType="username" autoComplete="email" />
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="current-password" returnKeyType="go" onSubmitEditing={() => email && password && void run(() => auth.signIn(email, password))()} />
        {err}
        <Button title="Continue" disabled={!email || !password} onPress={run(() => auth.signIn(email, password))} />
        <Button title="Create an account instead" variant="plain" onPress={() => setMode("register")} />
      </Shell>
    );
  }

  if (mode === "register") {
    const help = PROFILES.find((p) => p.value === profileType)!.help;
    return (
      <Shell title="Create account">
        <Text style={{ color: colors.textSecondary, marginBottom: 6 }}>I am a…</Text>
        <Segmented options={PROFILES.map(({ value, label }) => ({ value, label }))} value={profileType} onChange={setProfileType} />
        <Text style={{ color: colors.textSecondary, marginVertical: 10 }}>{help}</Text>
        <Field label="Full name" value={name} onChangeText={setName} textContentType="name" autoComplete="name" />
        <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" textContentType="username" autoComplete="email" />
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry textContentType="newPassword" autoComplete="new-password" hint="At least 12 characters. A passphrase works well." />
        {err}
        <Button title="Create account" disabled={!email || !name || password.length < 12} onPress={run(() => auth.register({ email, password, name, profileType }))} />
        <Button title="I already have an account" variant="plain" onPress={() => setMode("signIn")} />
      </Shell>
    );
  }

  return (
    <Shell title="Logistics Pro" subtitle="Every load, every partner, one app. Drive, dispatch, ship and invoice, with your ERP connected by API or EDI.">
      <View style={{ height: 24 }} />
      <Button title="Create account" onPress={() => setMode("register")} />
      <Button title="Sign in" variant="tonal" onPress={() => setMode("signIn")} />
    </Shell>
  );
}
