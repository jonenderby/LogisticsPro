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
import { Banner, Body, Button, Field, Padded, Row, Screen, Section, Segmented, StatusPill } from "../ui/components";
import { money, titleCase, when } from "../ui/format";

const MODE: Record<string, string> = { FTL: "Full truckload", LTL: "LTL", PARTIAL: "Partial" };

export function LoadDetailScreen() {
  const { id } = useParams<"LoadDetail">();
  const nav = useNav();
  const { me, refresh: refreshMe, relation } = useMe();
  const [load, setLoad] = useState<LoadDetail>();
  const [bids, setBids] = useState<Bid[]>([]);
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
    if (l.status === "POSTED") setBids(await api.get<Bid[]>(`/v1/loads/${id}/bids`).catch(() => []));
  }, [id, nav]);
  useFocusEffect(
    useCallback(() => {
      void fetchLoad();
    }, [fetchLoad]),
  );

  if (!load || !me) return null;
  const rel = relation(load);
  const myLeg = load.legs.find((l) => l.driverAccountIds.includes(me.account.id) && l.status !== "COMPLETED");
  const next = rel.driver ? nextDriverAction(load, myLeg) : undefined;
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
            {!load.pickedUpAt && load.status !== "CANCELLED" ? <Button title="Cancel load" variant="destructive" onPress={async () => { if (await confirm("Cancel this load?", "The carrier is notified and the load cannot be reopened.", "Cancel load", true)) await run(() => api.post(`/v1/loads/${load.id}/cancel`))(); }} /> : null}
          </Padded>
          {load.status === "POSTED"
            ? bids.map((b) => <Row key={b.id} title={`${money(b.amount.amount)} · ${titleCase(b.plan)}`} subtitle={`${b.transitHours ? `${b.transitHours} h transit · ` : ""}${b.notes ?? ""}`} right={<Button title="Award" variant="tonal" onPress={run(() => api.post(`/v1/loads/${load.id}/bids/${b.id}/award`), "Awarded")} style={{ minHeight: 36 }} />} />)
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
