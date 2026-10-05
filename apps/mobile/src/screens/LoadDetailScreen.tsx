import { ON_TIME_GRACE_MINUTES, carrierKeyOf } from "@logisticspro/domain";
import { nextDriverAction } from "@logisticspro/workspace";
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

type BidView = Bid & { carrierName?: string; reliability?: { overall: Score; withYou?: Score; truckers: number } };
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

const MODE: Record<string, string> = { FTL: "Full truckload", LTL: "LTL", PARTIAL: "Partial" };

export function LoadDetailScreen() {
  const { id } = useParams<"LoadDetail">();
  const nav = useNav();
  const { me, refresh: refreshMe, relation } = useMe();
  const [load, setLoad] = useState<LoadDetail>();
  const [bids, setBids] = useState<BidView[]>([]);
  const [exceptions, setExceptions] = useState<LoadExceptionView[]>([]);
  const [tracking, setTracking] = useState<Tracking>();
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
  const [docName, setDocName] = useState("");
  const [docUrl, setDocUrl] = useState("");

  const fetchLoad = useCallback(async () => {
    const l = await api.get<LoadDetail>(`/v1/loads/${id}`);
    setLoad(l);
    setNotes(l.notes ?? "");
    nav.setOptions({ title: l.loadNumber });
    if (l.status === "POSTED") setBids(await api.get<BidView[]>(`/v1/loads/${id}/bids`).catch(() => []));
    setTracking(TRACKED.includes(l.status) ? await api.get<Tracking>(`/v1/loads/${id}/tracking`).catch(() => undefined) : undefined);
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
      notify("Couldn't complete that", errorMessage(e));
    }
  };

  return (
    <Screen onRefresh={fetchLoad}>
      {rel.shipper && !["DELIVERED", "INVOICED", "CANCELLED"].includes(load.status) ? (
        load.refinement.locked ? <Banner tone="neutral" title="Details locked" message={load.refinement.reason} /> : <Banner tone="info" title="You can still change this load" message="Edits stay open until the driver picks up or you confirm shipment. Your carrier is notified of every change." />
      ) : null}

      <Section title="Summary">
        <Row title="Status" right={<StatusPill status={load.status} />} />
        <Row title="Service" value={`${MODE[load.mode]} · ${titleCase(load.service)}${load.teamRequired && load.service !== "TEAM_EXPEDITED" ? " · team" : ""}`} />
        <Row title="Equipment" value={`${titleCase(load.equipment.type)} ${load.equipment.lengthFt}'`} />
        {load.rate ? <Row title="Rate" value={money(load.rate.amount, load.rate.currency)} /> : null}
        {load.references.bol ? <Row title="BOL" value={load.references.bol} /> : null}
        {load.references.pro ? <Row title="PRO" value={load.references.pro} /> : null}
        {load.references.po.length ? <Row title="PO" value={load.references.po.join(", ")} /> : null}
      </Section>

      {next || rel.driver ? (
        <Section title="Driving" footer="Status updates go to your dispatcher and the shipper, in whatever format their systems use.">
          <Padded>
            {next ? <Button title={next.label} onPress={run(() => reportStatus(load.id, next.code))} /> : null}
            {["IN_TRANSIT", "AT_PICKUP", "DISPATCHED"].includes(load.status) ? <Button title="Report a delay" variant="tonal" onPress={run(() => reportStatus(load.id, "DELAYED", { reason: "TRAFFIC" }), "Delay reported")} /> : null}
            <Button title={load.oversize ? "Start permitted-route navigation" : "Navigate"} variant="tonal" onPress={() => nav.navigate("Navigate", { loadId: load.id })} />
          </Padded>
        </Section>
      ) : null}

      {tracking ? (
        <Section title="Arrival" footer="Estimated from the truck's latest location, the stops ahead and driving-hour rules. A recent ETA from the carrier takes precedence.">
          <Row title="Delivery" right={<ArrivalChip eta={tracking.eta} />} />
          <Row title={tracking.eta.etaSource === "ARRIVED" ? "Arrived" : tracking.eta.etaSource === "CARRIER" ? "ETA from carrier" : "Estimated arrival"} value={time(tracking.eta.eta)} />
          <Row title="Window" value={`${time(tracking.eta.window.start)} – ${time(tracking.eta.window.end)}`} />
          {tracking.eta.remainingMiles != null ? <Row title="Miles to go" value={`${Math.round(tracking.eta.remainingMiles)}`} /> : null}
          {tracking.truck ? <Row title="Truck last seen" value={ago(tracking.truck.at)} subtitle={tracking.truck.stale ? "Location is out of date" : undefined} /> : null}
          {tracking.eta.reasons.map((r) => (
            <Row key={r} title={r} />
          ))}
        </Section>
      ) : null}

      {rel.shipper && carrierScore ? (
        <Section title="Carrier reliability" footer="Every carrier is scored on the loads it hauls, including carriers connected by API or EDI. Missed appointments you report count against it.">
          <Row title={carrierScore.name} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, paddingHorizontal: 16, paddingBottom: 12 }}>
            <ScoreChip label="With you" score={carrierScore.forBusiness} />
            {load.carrierOrgId ? <ScoreChip label="Overall" score={carrierScore.overall} /> : null}
          </View>
        </Section>
      ) : null}

      {misses.length || reportable.length ? (
        <Section title="Appointments" footer="A missed appointment counts against the carrier that was hauling the load at the time, and the drivers on that leg. It never counts against another carrier the driver also works for.">
          {misses.map((m) => (
            <MissRow key={m.id} miss={m} canWithdraw={rel.shipper} canDispute={rel.dispatcher} onChanged={fetchLoad} />
          ))}
          {stopForMiss ? (
            <Padded>
              <Body secondary>Did the carrier miss an appointment?</Body>
              {reportable.length > 1 ? <Segmented options={reportable.map((s) => ({ value: s.id, label: `${titleCase(s.type)} · ${s.address.city}` }))} value={stopForMiss.id} onChange={setMissStop} /> : <Body>{`${titleCase(stopForMiss.type)} at ${stopForMiss.address.city}, ${when(stopForMiss.window.start)} – ${when(stopForMiss.window.end)}`}</Body>}
              <Segmented options={[{ value: "NO_SHOW", label: "No-show" }, { value: "LATE", label: "Arrived late" }]} value={missKind} onChange={setMissKind} />
              {missKind === "LATE" ? <Field label="Minutes late (optional)" value={missMinutes} onChangeText={setMissMinutes} keyboardType="number-pad" /> : null}
              <Field label="Note (optional)" value={missNote} onChangeText={setMissNote} multiline />
              <Button
                title="Report missed appointment"
                variant="destructive"
                onPress={async () => {
                  if (!(await confirm("Report a missed appointment?", "It counts against the carrier's reliability with you and overall. The carrier can respond, and you can withdraw it later.", "Report", true))) return;
                  const minutes = parseInt(missMinutes, 10);
                  await run(async () => {
                    await api.post(`/v1/loads/${load.id}/appointment-misses`, { stopId: stopForMiss.id, kind: missKind, minutesLate: missKind === "LATE" && minutes > 0 ? minutes : undefined, note: missNote });
                    setMissNote("");
                    setMissMinutes("");
                  }, "Missed appointment reported")();
                }}
              />
            </Padded>
          ) : null}
        </Section>
      ) : null}

      <Section title="Stops">
        {[...load.stops].sort((a, b) => a.sequence - b.sequence).map((s) => (
          <Row key={s.id} title={`${titleCase(s.type)} · ${s.address.name}`} subtitle={`${s.address.line1}, ${s.address.city}, ${s.address.state} ${s.address.postalCode}\n${when(s.window.start)} – ${when(s.window.end)}${s.appointmentRef ? ` · appt ${s.appointmentRef}` : ""}${s.instructions ? `\n${s.instructions}` : ""}`} />
        ))}
      </Section>

      <Section title="Freight">
        {load.items.map((i, n) => (
          <Row key={n} title={i.description} subtitle={`${i.pieces} ${i.packaging} · ${i.weightLb.toLocaleString()} lb${i.freightClass ? ` · class ${i.freightClass}` : ""}${i.hazmat ? ` · HAZMAT ${i.hazmat.unNumber}` : ""}`} />
        ))}
        {load.oversize ? <Row title="Oversize" subtitle={`${load.oversize.lengthIn}" L × ${load.oversize.widthIn}" W × ${load.oversize.heightIn}" H · ${load.oversize.grossWeightLb.toLocaleString()} lb · ${load.oversize.permits.length} permit(s)`} /> : null}
      </Section>

      {load.legs.length ? (
        <Section title="Dispatch">
          {load.legs.map((leg) => {
            const from = load.stops.find((s) => s.id === leg.fromStopId)?.address.city;
            const to = load.stops.find((s) => s.id === leg.toStopId)?.address.city;
            return <Row key={leg.id} title={`Leg ${leg.sequence}: ${from} → ${to}`} subtitle={`${leg.driverAccountIds.length === 2 ? "Team" : leg.driverAccountIds.length === 1 ? "Solo driver" : "Unassigned"} · ${titleCase(leg.status)}`} />;
          })}
        </Section>
      ) : null}

      <Section>
        <Row title="Messages" subtitle="Thread with everyone on this load" onPress={() => nav.navigate("Thread", { loadId: load.id, title: load.loadNumber })} />
      </Section>

      {rel.dispatcher && load.status === "TENDERED" ? (
        <Section title="Tender">
          <Padded>
            <Body secondary>Accepting books the load to your company. The shipper receives your response in their format (API or EDI 990).</Body>
            <Field label="Your PRO number (optional)" value={pro} onChangeText={setPro} autoCapitalize="characters" />
            <Button title="Accept tender" onPress={run(() => api.post(`/v1/loads/${load.id}/tender-response`, { decision: "ACCEPT", pro: pro || undefined }))} />
            <Button title="Decline" variant="destructive" onPress={async () => { if (await confirm("Decline this tender?", "The shipper is told you have no capacity.", "Decline", true)) await run(() => api.post(`/v1/loads/${load.id}/tender-response`, { decision: "DECLINE", reason: "No capacity" }), "Tender declined", true)(); }} />
          </Padded>
        </Section>
      ) : null}

      {rel.dispatcher && ["BOOKED", "DISPATCHED"].includes(load.status) ? (
        <Section title="Carrier">
          <Padded>
            <Button title="Plan dispatch: drivers, team, relays" onPress={() => nav.navigate("Dispatch", { loadId: load.id })} />
          </Padded>
        </Section>
      ) : null}

      {rel.shipper ? (
        <Section title="Shipper">
          <Padded>
            {!load.refinement.locked ? (
              <>
                <Field label="Notes for the carrier" value={notes} onChangeText={setNotes} multiline />
                <Button title="Save changes" variant="tonal" disabled={notes === (load.notes ?? "")} onPress={run(() => api.patch(`/v1/loads/${load.id}`, { notes }))} />
              </>
            ) : null}
            {load.status === "DRAFT" ? (
              <>
                <Button title="Post to load board" onPress={run(() => api.post(`/v1/loads/${load.id}/post`), "Posted to the board")} />
                <Segmented options={[{ value: "carrier", label: "Carrier on Logistics Pro" }, { value: "partner", label: "Integrated partner" }]} value={tenderKind} onChange={setTenderKind} />
                <Field label={tenderKind === "carrier" ? "Carrier organization ID" : "Partner key (e.g. estes, rl-carriers)"} value={tenderTo} onChangeText={setTenderTo} autoCapitalize="none" />
                <Button title="Tender directly" variant="tonal" disabled={!tenderTo} onPress={run(() => api.post(`/v1/loads/${load.id}/tender`, tenderKind === "carrier" ? { carrierOrgId: tenderTo } : { partnerKey: tenderTo }))} />
              </>
            ) : null}
            {["BOOKED", "DISPATCHED", "AT_PICKUP"].includes(load.status) && !load.shipConfirmedAt ? <Button title="Confirm shipment" variant="tonal" onPress={async () => { if (await confirm("Confirm shipment?", "The load details lock for everyone once confirmed.", "Confirm")) await run(() => api.post(`/v1/loads/${load.id}/ship-confirm`), "Shipment confirmed")(); }} /> : null}
            {(load.carrierOrgId || load.externalCarrierKey) && !load.pickedUpAt && ["TENDERED", "BOOKED", "DISPATCHED", "AT_PICKUP"].includes(load.status) ? (
              <Button
                title="Release carrier"
                variant="tonal"
                accessibilityHint="Take the load back so you can give it to another carrier"
                onPress={async () => {
                  if (await confirm("Release this carrier?", "The load comes back to you as a draft so you can tender it to another carrier. The carrier is notified. Missed appointments stay on their record only.", "Release", true)) await run(() => api.post(`/v1/loads/${load.id}/release-carrier`), "Carrier released")();
                }}
              />
            ) : null}
            {!load.pickedUpAt && load.status !== "CANCELLED" ? <Button title="Cancel load" variant="destructive" onPress={async () => { if (await confirm("Cancel this load?", "The carrier is notified and the load cannot be reopened.", "Cancel load", true)) await run(() => api.post(`/v1/loads/${load.id}/cancel`))(); }} /> : null}
          </Padded>
          {load.status === "POSTED"
            ? bids.map((b) => (
                <View key={b.id}>
                  <Row title={`${money(b.amount.amount)} · ${b.carrierName ?? "Carrier"}`} subtitle={`${titleCase(b.plan)}${b.transitHours ? ` · ${b.transitHours} h transit` : ""}${b.notes ? ` · ${b.notes}` : ""}`} right={<Button title="Award" variant="tonal" onPress={run(() => api.post(`/v1/loads/${load.id}/bids/${b.id}/award`), "Awarded")} style={{ minHeight: 36 }} />} />
                  {b.reliability ? (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, paddingHorizontal: 16, paddingBottom: 12 }}>
                      <ScoreChip label="With you" score={b.reliability.withYou} />
                      <ScoreChip label="Overall" score={b.reliability.overall} />
                    </View>
                  ) : null}
                </View>
              ))
            : null}
        </Section>
      ) : null}

      {!rel.shipper && load.status === "POSTED" && bidOrgs.length ? (
        <Section title="Bid" footer={load.teamRequired ? "This load needs a team. Bid with a team or relay plan." : undefined}>
          <Padded>
            <Field label="Your all-in rate (USD)" value={bidAmount} onChangeText={setBidAmount} keyboardType="decimal-pad" />
            <Segmented options={[{ value: "SOLO", label: "Solo" }, { value: "TEAM", label: "Team" }, { value: "RELAY", label: "Relay" }, { value: "CONSOLIDATED", label: "Via DC" }]} value={bidPlan} onChange={setBidPlan} />
            <Button title="Place bid" disabled={!Number(bidAmount)} onPress={run(() => api.post(`/v1/loads/${load.id}/bids`, { carrierOrgId: bidOrgs[0]!.id, amount: { amount: Number(bidAmount), currency: "USD" }, plan: bidPlan }), "Bid placed")} />
          </Padded>
        </Section>
      ) : null}

      {load.status === "DELIVERED" && (rel.billing || rel.driver) ? (
        <Section title="Billing">
          <Padded>
            <Button title="Send invoice" onPress={() => nav.navigate("SendInvoice", { loadId: load.id })} />
          </Padded>
        </Section>
      ) : null}

      {load.pickedUpAt && (rel.shipper || rel.driver || rel.dispatcher) ? (
        <Section title="Exceptions" footer="Damage reports count against the carrier's and drivers' damage-free rate with this customer.">
          {exceptions.map((x) => (
            <Row key={x.id} title={`${titleCase(x.type)}${x.pieces ? ` · ${x.pieces} pcs` : ""}`} subtitle={`${x.note}\n${when(x.at)}`} />
          ))}
          <Padded>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {EXCEPTION_TYPES.map((t) => (
                <Chip key={t} label={titleCase(t)} selected={excType === t} onPress={() => setExcType(t)} />
              ))}
            </View>
            <Field label="What happened" value={excNote} onChangeText={setExcNote} multiline />
            <Button
              title="Report exception"
              variant="tonal"
              disabled={!excNote.trim()}
              onPress={run(async () => {
                await api.post(`/v1/loads/${load.id}/exceptions`, { type: excType, note: excNote.trim() });
                setExcNote("");
              }, "Exception reported")}
            />
          </Padded>
        </Section>
      ) : null}

      <Section title="Documents">
        {load.documents.map((d) => (
          <Row key={d.id} title={d.name} subtitle={`${titleCase(d.kind)} · ${when(d.at)}`} />
        ))}
        <View style={{ padding: 16 }}>
          <Field label="Document name (e.g. Signed POD)" value={docName} onChangeText={setDocName} />
          <Field label="File link" value={docUrl} onChangeText={setDocUrl} autoCapitalize="none" keyboardType="url" hint="Link to the uploaded scan" />
          <Button
            title="Add document"
            variant="tonal"
            disabled={!docName || !docUrl}
            onPress={run(async () => {
              await api.post(`/v1/loads/${load.id}/documents`, { kind: /pod|deliver/i.test(docName) ? "POD" : /bol|lading/i.test(docName) ? "BOL" : "OTHER", name: docName, url: docUrl });
              setDocName("");
              setDocUrl("");
            })}
          />
        </View>
      </Section>
    </Screen>
  );
}
