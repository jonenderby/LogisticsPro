import { useFocusEffect } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import { useNav } from "../navigation/types";
import { useMe } from "../state/MeProvider";
import { Banner, Body, Button, Chip, Empty, Field, Padded, Row, Screen, Section } from "../ui/components";
import { confirm, notify } from "../ui/dialog";
import { when } from "../ui/format";
import { type Score, ScoreRow } from "../ui/Reliability";

interface JoinRequest {
  id: string;
  carrierOrgId: string;
  carrierName?: string;
  status: "PENDING" | "APPROVED" | "DECLINED" | "CANCELLED";
  createdAt: string;
  account: { id: string; name: string; email: string };
}

/** Truckers join a carrier with the code it shares; self-employed truckers register their own company. */
export function JoinCarrierScreen() {
  const nav = useNav();
  const { me, refresh } = useMe();
  const [code, setCode] = useState("");
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const load = useCallback(async () => setRequests(await api.get<JoinRequest[]>("/v1/me/join-requests")), []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const carriers = (me?.orgs ?? []).filter((o) => o.kinds.includes("CARRIER") && o.roles.includes("DRIVER"));
  return (
    <Screen onRefresh={load}>
      {carriers.length ? <Banner tone="success" title={`You drive for ${carriers.map((c) => c.name).join(", ")}`} /> : <Banner tone="info" title="Every trucker drives for a carrier" message="Enter the join code your carrier gave you. They approve the request before you can be dispatched." />}
      <Section title="Join with a code">
        <Padded>
          <Field label="Join code" value={code} onChangeText={(t) => setCode(t.toUpperCase())} autoCapitalize="characters" autoCorrect={false} placeholder="ABCD-2345" maxLength={9} />
          <Button
            title="Request to join"
            disabled={code.replace(/[^A-Z0-9]/g, "").length < 8}
            onPress={async () => {
              try {
                const r = await api.post<JoinRequest>("/v1/carriers/join", { code });
                notify("Request sent", `${r.carrierName} will review your request.`);
                setCode("");
                await load();
              } catch (e) {
                notify("Couldn't send the request", errorMessage(e));
              }
            }}
          />
        </Padded>
      </Section>
      {requests.length ? (
        <Section title="Your requests">
          {requests.map((r) => (
            <Row
              key={r.id}
              title={r.carrierName ?? "Carrier"}
              subtitle={`Sent ${when(r.createdAt)}`}
              right={
                r.status === "PENDING" ? (
                  <Button title="Cancel" variant="plain" style={{ minHeight: 36 }} onPress={async () => { await api.post(`/v1/join-requests/${r.id}/cancel`); await Promise.all([load(), refresh()]); }} />
                ) : (
                  <Chip label={r.status.toLowerCase()} tone={r.status === "APPROVED" ? "success" : "neutral"} />
                )
              }
            />
          ))}
        </Section>
      ) : null}
      <Section title="Self-employed?" footer="Registering your own trucking company makes you its owner-operator: your driving and your company's dispatch, bids and invoices share one Today screen.">
        <Padded>
          <Button title="Register my trucking company" variant="tonal" onPress={() => nav.navigate("RegisterCompany")} />
        </Padded>
      </Section>
    </Screen>
  );
}

/** Carrier side: the join code, pending requests and the people in the network. */
export function DriverNetworkSection({ orgId, onChange }: { orgId: string; onChange: () => Promise<void> }) {
  const [code, setCode] = useState<{ code: string; expiresAt: string; rotatesEveryHours: number }>();
  const [pending, setPending] = useState<JoinRequest[]>([]);
  const load = useCallback(async () => {
    const [c, p] = await Promise.all([api.get<typeof code>(`/v1/orgs/${orgId}/join-code`), api.get<JoinRequest[]>(`/v1/orgs/${orgId}/join-requests?status=PENDING`)]);
    setCode(c);
    setPending(p);
  }, [orgId]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const decide = (id: string, decision: "approve" | "decline") => async () => {
    try {
      await api.post(`/v1/orgs/${orgId}/join-requests/${id}/${decision}`);
      await Promise.all([load(), onChange()]);
    } catch (e) {
      notify("Couldn't update the request", errorMessage(e));
    }
  };
  return (
    <>
      <Section title="Driver join code" footer={code ? `Truckers enter this code to request to join. It changes automatically every ${Math.round(code.rotatesEveryHours / 24)} days; rotate it now if it was shared too widely. Requests still need your approval.` : undefined}>
        {code ? (
          <Padded>
            <Body style={{ fontSize: 32, fontWeight: "700", letterSpacing: 4, textAlign: "center" }}>{code.code}</Body>
            <Body secondary style={{ textAlign: "center" }}>Valid until {when(code.expiresAt)}</Body>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button title="Copy code" variant="tonal" style={{ flex: 1 }} onPress={() => Clipboard.setStringAsync(code.code)} />
              <Button
                title="Rotate now"
                variant="plain"
                style={{ flex: 1 }}
                onPress={async () => {
                  if (await confirm("Rotate the join code?", "The current code stops working immediately.", "Rotate")) setCode(await api.post(`/v1/orgs/${orgId}/join-code/rotate`));
                }}
              />
            </View>
          </Padded>
        ) : null}
      </Section>
      <Section title="Requests to join">
        {pending.length === 0 ? <Empty title="No pending requests" /> : null}
        {pending.map((r) => (
          <View key={r.id}>
            <Row title={r.account.name} subtitle={`${r.account.email} · ${when(r.createdAt)}`} />
            <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 12 }}>
              <Button title="Approve" style={{ flex: 1 }} onPress={decide(r.id, "approve")} />
              <Button title="Decline" variant="destructive" style={{ flex: 1 }} onPress={decide(r.id, "decline")} />
            </View>
          </View>
        ))}
      </Section>
    </>
  );
}

interface Profile {
  overall: Score;
  forBusiness?: Score;
  byBusiness?: Array<Score & { businessOrgId: string; businessName: string }>;
  windows: { overall: number; perBusiness: number };
  truckers?: number;
}

export function ReliabilitySections({ profile, subject }: { profile: Profile; subject: "carrier" | "driver" }) {
  return (
    <>
      <Section
        title={subject === "carrier" ? "Reliability" : "Your reliability"}
        footer={subject === "carrier" ? `Based on the last ${profile.windows.overall.toLocaleString()} shipments overall and ${profile.windows.perBusiness.toLocaleString()} per customer (${profile.truckers ?? 1} trucker${profile.truckers === 1 ? "" : "s"} × 1,000 and × 100).` : "Based on your last 1,000 shipments overall and your last 100 with each customer."}
      >
        <ScoreRow title="Overall" score={profile.overall} />
      </Section>
      {profile.byBusiness?.length ? (
        <Section title="By customer" footer="Each customer sees only its own relationship, plus the overall score.">
          {profile.byBusiness.map((b) => (
            <ScoreRow key={b.businessOrgId} title={b.businessName} score={b} />
          ))}
        </Section>
      ) : null}
    </>
  );
}

export function ReliabilityScreen() {
  const { me } = useMe();
  const [profile, setProfile] = useState<Profile>();
  const load = useCallback(async () => {
    if (me) setProfile(await api.get<Profile>(`/v1/reliability/drivers/${me.account.id}`));
  }, [me]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  return <Screen onRefresh={load}>{profile ? <ReliabilitySections profile={profile} subject="driver" /> : null}</Screen>;
}
