import { useFocusEffect } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { api, errorMessage } from "../api/client";
import { useNav } from "../navigation/types";
import { useMe, useT } from "../state/MeProvider";
import { MissRow, type MissView } from "../ui/Appointments";
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
  const t = useT();
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
      {carriers.length ? <Banner tone="success" title={t("You drive for {carriers}", { carriers: carriers.map((c) => c.name).join(", ") })} /> : <Banner tone="info" title={t("Every trucker drives for a carrier")} message={t("Enter the join code your carrier gave you. They approve the request before you can be dispatched.")} />}
      <Section title={t("Join with a code")}>
        <Padded>
          <Field label={t("Join code")} value={code} onChangeText={(t) => setCode(t.toUpperCase())} autoCapitalize="characters" autoCorrect={false} placeholder="ABCD-2345" maxLength={9} />
          <Button
            title={t("Request to join")}
            disabled={code.replace(/[^A-Z0-9]/g, "").length < 8}
            onPress={async () => {
              try {
                const r = await api.post<JoinRequest>("/v1/carriers/join", { code });
                notify(t("Request sent"), t("{carrier} will review your request.", { carrier: r.carrierName }));
                setCode("");
                await load();
              } catch (e) {
                notify(t("Couldn't send the request"), errorMessage(e));
              }
            }}
          />
        </Padded>
      </Section>
      {requests.length ? (
        <Section title={t("Your requests")}>
          {requests.map((r) => (
            <Row
              key={r.id}
              title={r.carrierName ?? "Carrier"}
              subtitle={`Sent ${when(r.createdAt)}`}
              right={
                r.status === "PENDING" ? (
                  <Button title={t("Cancel")} variant="plain" style={{ minHeight: 36 }} onPress={async () => { await api.post(`/v1/join-requests/${r.id}/cancel`); await Promise.all([load(), refresh()]); }} />
                ) : (
                  <Chip label={r.status.toLowerCase()} tone={r.status === "APPROVED" ? "success" : "neutral"} />
                )
              }
            />
          ))}
        </Section>
      ) : null}
      <Section title={t("Self-employed?")} footer={t("Registering your own trucking company makes you its owner-operator: your driving and your company's dispatch, bids and invoices share one Today screen.")}>
        <Padded>
          <Button title={t("Register my trucking company")} variant="tonal" onPress={() => nav.navigate("RegisterCompany")} />
        </Padded>
      </Section>
    </Screen>
  );
}

/** Carrier side: the join code, pending requests and the people in the network. */
export function DriverNetworkSection({ orgId, onChange }: { orgId: string; onChange: () => Promise<void> }) {
  const t = useT();
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
      notify(t("Couldn't update the request"), errorMessage(e));
    }
  };
  return (
    <>
      <Section title={t("Driver join code")} footer={code ? t("Truckers enter this code to request to join. It changes automatically every {n} days; rotate it now if it was shared too widely. Requests still need your approval.", { n: Math.round(code.rotatesEveryHours / 24) }) : undefined}>
        {code ? (
          <Padded>
            <Body style={{ fontSize: 32, fontWeight: "700", letterSpacing: 4, textAlign: "center" }}>{code.code}</Body>
            <Body secondary style={{ textAlign: "center" }}>Valid until {when(code.expiresAt)}</Body>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button title={t("Copy code")} variant="tonal" style={{ flex: 1 }} onPress={() => Clipboard.setStringAsync(code.code)} />
              <Button
                title={t("Rotate now")}
                variant="plain"
                style={{ flex: 1 }}
                onPress={async () => {
                  if (await confirm(t("Rotate the join code?"), t("The current code stops working immediately."), t("Rotate"))) setCode(await api.post(`/v1/orgs/${orgId}/join-code/rotate`));
                }}
              />
            </View>
          </Padded>
        ) : null}
      </Section>
      <Section title={t("Requests to join")}>
        {pending.length === 0 ? <Empty title={t("No pending requests")} /> : null}
        {pending.map((r) => (
          <View key={r.id}>
            <Row title={r.account.name} subtitle={`${r.account.email} · ${when(r.createdAt)}`} />
            <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 12 }}>
              <Button title={t("Approve")} style={{ flex: 1 }} onPress={decide(r.id, "approve")} />
              <Button title={t("Decline")} variant="destructive" style={{ flex: 1 }} onPress={decide(r.id, "decline")} />
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
  byCarrier?: Array<Score & { carrierKey: string; carrierName: string }>;
  appointmentMisses?: MissView[];
  windows: { overall: number; perBusiness: number };
  truckers?: number;
}

export function ReliabilitySections({ profile, subject, canDispute, onChanged }: { profile: Profile; subject: "carrier" | "driver"; canDispute?: boolean; onChanged?: () => unknown }) {
  const t = useT();
  return (
    <>
      <Section
        title={subject === "carrier" ? t("Reliability") : t("Your reliability")}
        footer={subject === "carrier" ? t("Based on the last {overall} shipments overall and {per} per customer ({n} truckers × 1,000 and × 100).", { overall: profile.windows.overall.toLocaleString(), per: profile.windows.perBusiness.toLocaleString(), n: profile.truckers ?? 1 }) : t("Based on your last 1,000 shipments overall and your last 100 with each customer.")}
      >
        <ScoreRow title={t("Overall")} score={profile.overall} />
      </Section>
      {profile.byBusiness?.length ? (
        <Section title={t("By customer")} footer={t("Each customer sees only its own relationship, plus the overall score.")}>
          {profile.byBusiness.map((b) => (
            <ScoreRow key={b.businessOrgId} title={b.businessName} score={b} />
          ))}
        </Section>
      ) : null}
      {profile.byCarrier?.length ? (
        <Section title={t("By carrier")} footer={t("You drive for more than one carrier. Each carrier is scored only on the loads you hauled for it.")}>
          {profile.byCarrier.map((c) => (
            <ScoreRow key={c.carrierKey} title={c.carrierName} score={c} />
          ))}
        </Section>
      ) : null}
      {profile.appointmentMisses?.length ? (
        <Section title={t("Missed appointments")} footer={t("Reported by customers. Each counts as a missed on-time pickup or delivery until the customer withdraws it.")}>
          {profile.appointmentMisses.map((m) => (
            <MissRow key={m.id} miss={m} showLoad canDispute={canDispute} onChanged={onChanged ?? (() => undefined)} />
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
