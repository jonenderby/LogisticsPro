import { ON_TIME_GRACE_MINUTES, carrierKeyOf } from "@logisticspro/domain";
import { nextDriverAction, tx } from "@logisticspro/workspace";
import { RATE_CON_STATUS } from "./RateConfirmationScreen";
import { type DocView, DocumentsSection } from "../ui/Documents";
import { type Verdict, VettingChip } from "./CarrierCheckScreen";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { reportStatus } from "../actions";
import { api, errorMessage } from "../api/client";
import type { Bid, LoadDetail } from "../api/types";
import { confirm, notify } from "../ui/dialog";
import { useNav, useParams } from "../navigation/types";
import { useMe } from "../state/MeProvider";
import { Banner, Body, Button, Chip, Field, Padded, Row, Screen, Section, Segmented, StatusPill } from "../ui/components";
import { money, titleCase, when } from "../ui/format";
import { type Score, ScoreChip } from "../ui/Reliability";
import { ArrivalChip, type Eta, ago, time } from "../ui/arrival";
import { MissRow, type MissView } from "../ui/Appointments";
import { type DetentionView, visitLine } from "../ui/detention";

type BidView = Bid & { carrierName?: string; reliability?: { overall: Score; withYou?: Score; truckers: number }; vetting?: { verdict: Verdict; approved: boolean } };
interface CarrierCheck {
  carrier?: { id: string; name?: string; verdict: Verdict; approved: boolean };
  pickup?: { status: "VERIFIED" | "UNVERIFIED" | "PENDING"; detail: string };
}
interface Tracking {
  eta: Eta;
  truck?: { geo: { lat: number; lng: number }; at: string; stale: boolean };
}
interface CarrierScore {
  name: string;
  overall: Score;
  forBusiness?: Score;
}
const TRACKED = ["TENDERED", "BOOKED", "DISPATCHED", "AT_PICKUP", "IN_TRANSIT", "AT_DELIVERY"];
interface LoadExceptionView {
  id: string;
  type: string;
  note: string;
  pieces?: number;
  at: string;
}
const EXCEPTION_TYPES = ["DAMAGE", "SHORTAGE", "OVERAGE", "REFUSED", "OTHER"] as const;

const MODE: Record<string, string> = { FTL: tx("Full truckload"), LTL: "LTL", PARTIAL: tx("Partial") };

export function LoadDetailScreen() {
  const { id } = useParams<"LoadDetail">();
  const nav = useNav();
  const { me, refresh: refreshMe, relation, t } = useMe();
  const [load, setLoad] = useState<LoadDetail>();
  const [bids, setBids] = useState<BidView[]>([]);
  const [exceptions, setExceptions] = useState<LoadExceptionView[]>([]);
  const [tracking, setTracking] = useState<Tracking>();
  const [stopTimes, setStopTimes] = useState<DetentionView>();
  const [misses, setMisses] = useState<MissView[]>([]);
  const [carrierScore, setCarrierScore] = useState<CarrierScore>();
  const [missStop, setMissStop] = useState("");
  const [missKind, setMissKind] = useState<"NO_SHOW" | "LATE">("NO_SHOW");
  const [missMinutes, setMissMinutes] = useState("");
  const [missNote, setMissNote] = useState("");
  const [excType, setExcType] = useState<(typeof EXCEPTION_TYPES)[number]>("DAMAGE");
  const [excNote, setExcNote] = useState("");
  const [notes, setNotes] = useState("");
  const [bidAmount, setBidAmount] = useState("");
  const [bidPlan, setBidPlan] = useState<"SOLO" | "TEAM" | "RELAY" | "CONSOLIDATED">("SOLO");
  const [tenderTo, setTenderTo] = useState("");
  const [tenderKind, setTenderKind] = useState<"carrier" | "partner">("carrier");
  const [pro, setPro] = useState("");
  const [carrierCheck, setCarrierCheck] = useState<CarrierCheck>();
  const [rateCon, setRateCon] = useState<{ version: number; status: keyof typeof RATE_CON_STATUS }>();

  const fetchLoad = useCallback(async () => {
    const l = await api.get<LoadDetail>(`/v1/loads/${id}`);
    setLoad(l);
    setNotes(l.notes ?? "");
    nav.setOptions({ title: l.loadNumber });
    if (l.status === "POSTED") setBids(await api.get<BidView[]>(`/v1/loads/${id}/bids`).catch(() => []));
    setTracking(TRACKED.includes(l.status) ? await api.get<Tracking>(`/v1/loads/${id}/tracking`).catch(() => undefined) : undefined);
    setStopTimes(["DISPATCHED", "AT_PICKUP", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED", "INVOICED"].includes(l.status) ? await api.get<DetentionView>(`/v1/loads/${id}/detention`).catch(() => undefined) : undefined);
    const hasCarrier = !!(l.carrierOrgId || l.externalCarrierKey);
    const myBusiness = [l.brokerOrgId, l.shipperOrgId].find((o) => !!o && me?.orgs.some((x) => x.id === o));
    setMisses(hasCarrier || l.status === "CANCELLED" || l.status === "DRAFT" ? await api.get<MissView[]>(`/v1/loads/${id}/appointment-misses`).catch(() => []) : []);
    setCarrierScore(
      l.carrierOrgId
        ? await api.get<CarrierScore>(`/v1/reliability/carriers/${l.carrierOrgId}${myBusiness ? `?businessOrgId=${myBusiness}` : ""}`).catch(() => undefined)
        : l.externalCarrierKey
          ? await api.get<CarrierScore>(`/v1/reliability/partners/${encodeURIComponent(l.externalCarrierKey)}?orgId=${l.brokerOrgId ?? l.shipperOrgId}`).catch(() => undefined)
          : undefined,
    );
    const rc = hasCarrier && !["DRAFT", "POSTED", "TENDERED"].includes(l.status) ? await api.get<{ current?: { version: number; status: keyof typeof RATE_CON_STATUS } }>(`/v1/loads/${id}/rate-confirmation`).catch(() => undefined) : undefined;
    setRateCon(rc?.current);
    setCarrierCheck(l.carrierOrgId && myBusiness ? await api.get<CarrierCheck>(`/v1/loads/${id}/carrier-check`).catch(() => undefined) : undefined);
    if (l.pickedUpAt) setExceptions(await api.get<LoadExceptionView[]>(`/v1/loads/${id}/exceptions`).catch(() => []));
  }, [id, nav, me]);
  useFocusEffect(
    useCallback(() => {
      void fetchLoad();
    }, [fetchLoad]),
  );

  if (!load || !me) return null;
  const rel = relation(load);
  const myLeg = load.legs.find((l) => l.driverAccountIds.includes(me.account.id) && l.status !== "COMPLETED");
  const next = rel.driver ? nextDriverAction(load, myLeg) : undefined;
  // Stops whose appointment has passed while the current carrier had the load, not yet reported.
  const carrierKey = carrierKeyOf(load);
  const reportable = rel.shipper && carrierKey
    ? load.stops.filter(
        (s) =>
          (s.type === "PICKUP" || s.type === "DELIVERY") &&
          Date.now() > Date.parse(s.window.end) + ON_TIME_GRACE_MINUTES * 60_000 &&
          Date.parse(s.window.end) >= Date.parse(load.carrierSince ?? load.createdAt) &&
          !misses.some((m) => m.stopId === s.id && m.carrierKey === carrierKey && !m.withdrawnAt),
      )
    : [];
  const stopForMiss = reportable.find((s) => s.id === missStop) ?? reportable[0];
  const bidOrgs = me.orgs.filter((o) => o.kinds.includes("CARRIER") && o.roles.some((r) => ["OWNER", "ADMIN", "DISPATCHER"].includes(r)));

  /** `leave`: the action ends this account's access to the load (e.g. declining a tender), so go back instead of reloading it. */
  const run = (fn: () => Promise<unknown>, ok?: string, leave = false) => async () => {
    try {
      const res = (await fn()) as { transmissions?: Array<{ method: string; status: string; partnerKey: string; error?: string }> } | undefined;
      const sent = res?.transmissions?.map((t) => `${t.partnerKey}: ${t.method.replace("_", " ")} ${t.status.toLowerCase()}${t.error ? ` (${t.error})` : ""}`).join("\n");
      if (ok || sent) notify(ok ?? "Done", sent);
      if (leave) {
        await refreshMe();
        if (nav.canGoBack()) nav.goBack();
        else nav.navigate("Today");
        return;
      }
      await Promise.all([fetchLoad(), refreshMe()]);
    } catch (e) {
      notify(t("Couldn't complete that"), errorMessage(e));
    }
  };

  return (
    <Screen onRefresh={fetchLoad}>
      {rel.shipper && !["DELIVERED", "INVOICED", "CANCELLED"].includes(load.status) ? (
        load.refinement.locked ? <Banner tone="neutral" title={t("Details locked")} message={load.refinement.reason} /> : <Banner tone="info" title={t("You can still change this load")} message={t("Edits stay open until the driver picks up or you confirm shipment. Your carrier is notified of every change.")} />
      ) : null}

      {rateCon?.status === "AWAITING_CARRIER" && rel.dispatcher ? <Banner tone="warning" title={t("The shipper changed this load")} message={t("Review and sign the new rate confirmation.")} /> : null}
      <Section title={t("Summary")}>
        <Row title={t("Status")} right={<StatusPill status={load.status} />} />
        <Row title={t("Service")} value={`${t(MODE[load.mode]!)} · ${t(titleCase(load.service))}${load.teamRequired && load.service !== "TEAM_EXPEDITED" ? ` · ${t("team")}` : ""}`} />
        <Row title={t("Equipment")} value={`${t(titleCase(load.equipment.type))} ${load.equipment.lengthFt}'`} />
        {load.rate ? <Row title={t("Rate")} value={money(load.rate.amount, load.rate.currency)} /> : null}
        {carrierCheck?.carrier && carrierCheck.carrier.verdict !== "NOT_CHECKED" ? <Row title={t("Carrier check")} right={<VettingChip verdict={carrierCheck.carrier.verdict} approved={carrierCheck.carrier.approved} />} onPress={() => nav.navigate("CarrierCheck", { orgId: carrierCheck.carrier!.id, payerOrgId: load.brokerOrgId ?? load.shipperOrgId })} /> : null}
        {carrierCheck?.pickup && carrierCheck.pickup.status !== "PENDING" ? <Row title={carrierCheck.pickup.status === "VERIFIED" ? t("Pickup verified by tracking") : t("Pickup not verified")} subtitle={carrierCheck.pickup.detail} right={<Chip label={carrierCheck.pickup.status === "VERIFIED" ? t("Verified") : t("Check")} tone={carrierCheck.pickup.status === "VERIFIED" ? "success" : "warning"} />} /> : null}
        {rateCon ? <Row title={t("Rate confirmation")} subtitle={t("Version {n}", { n: rateCon.version })} right={<Chip label={RATE_CON_STATUS[rateCon.status].label} tone={RATE_CON_STATUS[rateCon.status].tone} />} onPress={() => nav.navigate("RateConfirmation", { loadId: load.id })} /> : null}
        {load.references.bol ? <Row title="BOL" value={load.references.bol} /> : null}
        {load.references.pro ? <Row title="PRO" value={load.references.pro} /> : null}
        {load.references.po.length ? <Row title="PO" value={load.references.po.join(", ")} /> : null}
      </Section>

      {next || rel.driver ? (
        <Section title={t("Driving")} footer={t("Status updates go to your dispatcher and the shipper, in whatever format their systems use.")}>
          <Padded>
            {next ? <Button title={t(next.label)} onPress={run(() => reportStatus(load.id, next.code))} /> : null}
            {["IN_TRANSIT", "AT_PICKUP", "DISPATCHED"].includes(load.status) ? <Button title={t("Report a delay")} variant="tonal" onPress={run(() => reportStatus(load.id, "DELAYED", { reason: "TRAFFIC" }), t("Delay reported"))} /> : null}
            <Button title={load.oversize ? t("Start permitted-route navigation") : t("Navigate")} variant="tonal" onPress={() => nav.navigate("Navigate", { loadId: load.id })} />
          </Padded>
        </Section>
      ) : null}

      {tracking ? (
        <Section title={t("Arrival")} footer={t("Estimated from the truck's latest location, the stops ahead and driving-hour rules. A recent ETA from the carrier takes precedence.")}>
          <Row title={t("Delivery")} right={<ArrivalChip eta={tracking.eta} />} />
          <Row title={tracking.eta.etaSource === "ARRIVED" ? t("Arrived") : tracking.eta.etaSource === "CARRIER" ? t("ETA from carrier") : t("Estimated arrival")} value={time(tracking.eta.eta)} />
          <Row title={t("Window")} value={`${time(tracking.eta.window.start)} – ${time(tracking.eta.window.end)}`} />
          {tracking.eta.remainingMiles != null ? <Row title={t("Miles to go")} value={`${Math.round(tracking.eta.remainingMiles)}`} /> : null}
          {tracking.truck ? <Row title={t("Truck last seen")} value={ago(tracking.truck.at, t)} subtitle={tracking.truck.stale ? t("Location is out of date") : undefined} /> : null}
          {tracking.eta.reasons.map((r) => (
            <Row key={r} title={r} />
          ))}
        </Section>
      ) : null}

      {rel.shipper && carrierScore ? (
        <Section title={t("Carrier reliability")} footer={t("Every carrier is scored on the loads it hauls, including carriers connected by API or EDI. Missed appointments you report count against it.")}>
          <Row title={carrierScore.name} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, paddingHorizontal: 16, paddingBottom: 12 }}>
            <ScoreChip label={t("With you")} score={carrierScore.forBusiness} />
            {load.carrierOrgId ? <ScoreChip label={t("Overall")} score={carrierScore.overall} /> : null}
          </View>
        </Section>
      ) : null}

      {misses.length || reportable.length ? (
        <Section title={t("Appointments")} footer={t("A missed appointment counts against the carrier that was hauling the load at the time, and the drivers on that leg. It never counts against another carrier the driver also works for.")}>
          {misses.map((m) => (
            <MissRow key={m.id} miss={m} canWithdraw={rel.shipper} canDispute={rel.dispatcher} onChanged={fetchLoad} />
          ))}
          {stopForMiss ? (
            <Padded>
              <Body secondary>{t("Did the carrier miss an appointment?")}</Body>
              {reportable.length > 1 ? <Segmented options={reportable.map((s) => ({ value: s.id, label: `${t(titleCase(s.type))} · ${s.address.city}` }))} value={stopForMiss.id} onChange={setMissStop} /> : <Body>{`${titleCase(stopForMiss.type)} at ${stopForMiss.address.city}, ${when(stopForMiss.window.start)} – ${when(stopForMiss.window.end)}`}</Body>}
              <Segmented options={[{ value: "NO_SHOW", label: t("No-show") }, { value: "LATE", label: t("Arrived late") }]} value={missKind} onChange={setMissKind} />
              {missKind === "LATE" ? <Field label={t("Minutes late (optional)")} value={missMinutes} onChangeText={setMissMinutes} keyboardType="number-pad" /> : null}
              <Field label={t("Note (optional)")} value={missNote} onChangeText={setMissNote} multiline />
              <Button
                title={t("Report missed appointment")}
                variant="destructive"
                onPress={async () => {
                  if (!(await confirm(t("Report a missed appointment?"), t("It counts against the carrier's reliability with you and overall. The carrier can respond, and you can withdraw it later."), t("Report"), true))) return;
                  const minutes = parseInt(missMinutes, 10);
                  await run(async () => {
                    await api.post(`/v1/loads/${load.id}/appointment-misses`, { stopId: stopForMiss.id, kind: missKind, minutesLate: missKind === "LATE" && minutes > 0 ? minutes : undefined, note: missNote });
                    setMissNote("");
                    setMissMinutes("");
                  }, t("Missed appointment reported"))();
                }}
              />
            </Padded>
          ) : null}
        </Section>
      ) : null}

      <Section title={t("Stops")} footer={stopTimes?.total ? t("Detention so far: {total} at {rate}/h after {free} h free. It is added to the invoice.", { total: `$${stopTimes.total.toFixed(2)}`, rate: `$${stopTimes.terms.ratePerHour}`, free: stopTimes.terms.freeHours }) : undefined}>
        {[...load.stops].sort((a, b) => a.sequence - b.sequence).map((s) => (
          <Row key={s.id} title={`${t(titleCase(s.type))} · ${s.address.name}`} subtitle={`${s.address.line1}, ${s.address.city}, ${s.address.state} ${s.address.postalCode}\n${when(s.window.start)} – ${when(s.window.end)}${s.appointmentRef ? ` · ${t("appt {ref}", { ref: s.appointmentRef })}` : ""}${s.instructions ? `\n${s.instructions}` : ""}${visitLine(stopTimes?.stops.find((d) => d.stopId === s.id), t) ? `\n${visitLine(stopTimes?.stops.find((d) => d.stopId === s.id), t)}` : ""}`} />
        ))}
      </Section>

      <Section title={t("Freight")}>
        {load.items.map((i, n) => (
          <Row key={n} title={i.description} subtitle={`${i.pieces} ${i.packaging} · ${i.weightLb.toLocaleString()} lb${i.freightClass ? ` · ${t("class {c}", { c: i.freightClass })}` : ""}${i.hazmat ? ` · HAZMAT ${i.hazmat.unNumber}` : ""}`} />
        ))}
        {load.oversize ? <Row title={t("Oversize")} subtitle={`${load.oversize.lengthIn}" L × ${load.oversize.widthIn}" W × ${load.oversize.heightIn}" H · ${load.oversize.grossWeightLb.toLocaleString()} lb · ${load.oversize.permits.length} permit(s)`} /> : null}
      </Section>

      {load.legs.length ? (
        <Section title={t("Dispatch")}>
          {load.legs.map((leg) => {
            const from = load.stops.find((s) => s.id === leg.fromStopId)?.address.city;
            const to = load.stops.find((s) => s.id === leg.toStopId)?.address.city;
            return <Row key={leg.id} title={t("Leg {n}: {from} → {to}", { n: leg.sequence, from, to })} subtitle={`${leg.driverAccountIds.length === 2 ? t("Team") : leg.driverAccountIds.length === 1 ? t("Solo driver") : t("Unassigned")} · ${t(titleCase(leg.status))}`} />;
          })}
        </Section>
      ) : null}

      <Section>
        <Row title={t("Messages")} subtitle={t("Thread with everyone on this load")} onPress={() => nav.navigate("Thread", { loadId: load.id, title: load.loadNumber })} />
      </Section>

      {rel.dispatcher && load.status === "TENDERED" ? (
        <Section title={t("Tender")}>
          <Padded>
            <Body secondary>{t("Accepting books the load to your company. The shipper receives your response in their format (API or EDI 990).")}</Body>
            <Field label={t("Your PRO number (optional)")} value={pro} onChangeText={setPro} autoCapitalize="characters" />
            <Button title={t("Accept tender")} onPress={run(() => api.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT", pro: pro || undefined }))} />
            <Button title={t("Decline")} variant="destructive" onPress={async () => { if (await confirm(t("Decline this tender?"), t("The shipper is told you have no capacity."), t("Decline"), true)) await run(() => api.post(`/v1/loads/${load.id}/tender-response`, { decision: "DECLINE", reason: "No capacity" }), t("Tender declined"), true)(); }} />
          </Padded>
        </Section>
      ) : null}

      {rel.dispatcher && ["BOOKED", "DISPATCHED"].includes(load.status) ? (
        <Section title={t("Carrier")}>
          <Padded>
            <Button title={t("Plan dispatch: drivers, team, relays")} onPress={() => nav.navigate("Dispatch", { loadId: load.id })} />
          </Padded>
        </Section>
      ) : null}

      {rel.shipper ? (
        <Section title={t("Shipper")}>
          <Padded>
            {!load.refinement.locked ? (
              <>
                <Field label={t("Notes for the carrier")} value={notes} onChangeText={setNotes} multiline />
                <Button title={t("Save changes")} variant="tonal" disabled={notes === (load.notes ?? "")} onPress={run(() => api.patch(`/v1/loads/${load.id}`, { notes }))} />
              </>
            ) : null}
            {load.status === "DRAFT" ? (
              <>
                <Button title={t("Post to load board")} onPress={run(() => api.post(`/v1/loads/${load.id}/post`), t("Posted to the board"))} />
                <Segmented options={[{ value: "carrier", label: t("Carrier on Logistics Pro") }, { value: "partner", label: t("Integrated partner") }]} value={tenderKind} onChange={setTenderKind} />
                <Field label={tenderKind === "carrier" ? t("Carrier organization ID") : t("Partner key (e.g. estes, rl-carriers)")} value={tenderTo} onChangeText={setTenderTo} autoCapitalize="none" />
                <Button title={t("Tender directly")} variant="tonal" disabled={!tenderTo} onPress={run(() => api.post(`/v1/loads/${load.id}/tender`, tenderKind === "carrier" ? { carrierOrgId: tenderTo } : { partnerKey: tenderTo }))} />
              </>
            ) : null}
            {["BOOKED", "DISPATCHED", "AT_PICKUP"].includes(load.status) && !load.shipConfirmedAt ? <Button title={t("Confirm shipment")} variant="tonal" onPress={async () => { if (await confirm(t("Confirm shipment?"), t("The load details lock for everyone once confirmed."), t("Confirm"))) await run(() => api.post(`/v1/loads/${load.id}/ship-confirm`), t("Shipment confirmed"))(); }} /> : null}
            {(load.carrierOrgId || load.externalCarrierKey) && !load.pickedUpAt && ["TENDERED", "BOOKED", "DISPATCHED", "AT_PICKUP"].includes(load.status) ? (
              <Button
                title={t("Release carrier")}
                variant="tonal"
                accessibilityHint={t("Take the load back so you can give it to another carrier")}
                onPress={async () => {
                  if (await confirm(t("Release this carrier?"), t("The load comes back to you as a draft so you can tender it to another carrier. The carrier is notified. Missed appointments stay on their record only."), t("Release"), true)) await run(() => api.post(`/v1/loads/${load.id}/release-carrier`), t("Carrier released"))();
                }}
              />
            ) : null}
            {!load.pickedUpAt && load.status !== "CANCELLED" ? <Button title={t("Cancel load")} variant="destructive" onPress={async () => { if (await confirm(t("Cancel this load?"), t("The carrier is notified and the load cannot be reopened."), t("Cancel load"), true)) await run(() => api.post(`/v1/loads/${load.id}/cancel`))(); }} /> : null}
          </Padded>
          {load.status === "POSTED"
            ? bids.map((b) => (
                <View key={b.id}>
                  <Row title={`${money(b.amount.amount)} · ${b.carrierName ?? t("Carrier")}`} subtitle={`${t(titleCase(b.plan))}${b.transitHours ? ` · ${b.transitHours} h transit` : ""}${b.notes ? ` · ${b.notes}` : ""}`} right={<Button title={t("Award")} variant="tonal" onPress={run(() => api.post(`/v1/loads/${load.id}/bids/${b.id}/award`), t("Awarded"))} style={{ minHeight: 36 }} />} />
                  {b.reliability || b.vetting ? (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, paddingHorizontal: 16, paddingBottom: 12, alignItems: "center" }}>
                      {b.vetting ? <VettingChip verdict={b.vetting.verdict} approved={b.vetting.approved} onPress={() => nav.navigate("CarrierCheck", { orgId: b.carrierOrgId, payerOrgId: load.brokerOrgId ?? load.shipperOrgId })} /> : null}
                      {b.reliability ? <ScoreChip label={t("With you")} score={b.reliability.withYou} /> : null}
                      {b.reliability ? <ScoreChip label={t("Overall")} score={b.reliability.overall} /> : null}
                    </View>
                  ) : null}
                </View>
              ))
            : null}
        </Section>
      ) : null}

      {!rel.shipper && load.status === "POSTED" && bidOrgs.length ? (
        <Section title={t("Bid")} footer={load.teamRequired ? t("This load needs a team. Bid with a team or relay plan.") : undefined}>
          <Padded>
            <Field label={t("Your all-in rate (USD)")} value={bidAmount} onChangeText={setBidAmount} keyboardType="decimal-pad" />
            <Segmented options={[{ value: "SOLO", label: t("Solo") }, { value: "TEAM", label: t("Team") }, { value: "RELAY", label: t("Relay") }, { value: "CONSOLIDATED", label: t("Via DC") }]} value={bidPlan} onChange={setBidPlan} />
            <Button title={t("Place bid")} disabled={!Number(bidAmount)} onPress={run(() => api.post(`/v1/loads/${load.id}/bids`, { carrierOrgId: bidOrgs[0]!.id, amount: { amount: Number(bidAmount), currency: "USD" }, plan: bidPlan }), t("Bid placed"))} />
          </Padded>
        </Section>
      ) : null}

      {load.status === "DELIVERED" && (rel.billing || rel.driver) ? (
        <Section title={t("Billing")}>
          <Padded>
            <Button title={t("Send invoice")} onPress={() => nav.navigate("SendInvoice", { loadId: load.id })} />
          </Padded>
        </Section>
      ) : null}

      {load.pickedUpAt && (rel.shipper || rel.driver || rel.dispatcher) ? (
        <Section title={t("Exceptions")} footer={t("Damage reports count against the carrier's and drivers' damage-free rate with this customer.")}>
          {exceptions.map((x) => (
            <Row key={x.id} title={`${t(titleCase(x.type))}${x.pieces ? ` · ${t("{n} pcs", { n: x.pieces })}` : ""}`} subtitle={`${x.note}\n${when(x.at)}`} />
          ))}
          <Padded>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {EXCEPTION_TYPES.map((type) => (
                <Chip key={type} label={t(titleCase(type))} selected={excType === type} onPress={() => setExcType(type)} />
              ))}
            </View>
            <Field label={t("What happened")} value={excNote} onChangeText={setExcNote} multiline />
            <Button
              title={t("Report exception")}
              variant="tonal"
              disabled={!excNote.trim()}
              onPress={run(async () => {
                await api.post(`/v1/loads/${load.id}/exceptions`, { type: excType, note: excNote.trim() });
                setExcNote("");
              }, t("Exception reported"))}
            />
          </Padded>
        </Section>
      ) : null}

      <DocumentsSection
        loadId={load.id}
        docs={load.documents as DocView[]}
        pickupStopId={[...load.stops].sort((a, b) => a.sequence - b.sequence).find((s) => s.type === "PICKUP")?.id}
        deliveryStopId={[...load.stops].sort((a, b) => a.sequence - b.sequence).filter((s) => s.type === "DELIVERY").at(-1)?.id}
        onAdded={fetchLoad}
        onSign={(rel.driver || rel.dispatcher) && ["IN_TRANSIT", "AT_DELIVERY", "DELIVERED"].includes(load.status) ? () => nav.navigate("Signature", { loadId: load.id }) : undefined}
      />
    </Screen>
  );
}
