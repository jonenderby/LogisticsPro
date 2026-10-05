import { useState } from "react";
import { Image, Linking, Platform, View } from "react-native";
import { errorMessage } from "../api/client";
import { API_URL } from "../config";
import { type DocKind, captureImage, pickPdf, uploadDocument } from "./capture";
import { Button, Row, Section, Segmented } from "./components";
import { notify } from "./dialog";
import { titleCase, when } from "./format";

export interface DocView {
  id: string;
  kind: string;
  name: string;
  at: string;
  contentType?: string;
  signedBy?: string;
  viewUrl?: string;
  url: string;
}

const KINDS: Array<{ value: DocKind; label: string }> = [
  { value: "BOL", label: "BOL" },
  { value: "POD", label: "POD" },
  { value: "LUMPER_RECEIPT", label: "Lumper" },
  { value: "SCALE_TICKET", label: "Scale" },
  { value: "OTHER", label: "Other" },
];

const KIND_LABEL: Record<string, string> = { BOL: "Bill of lading", POD: "Proof of delivery", LUMPER_RECEIPT: "Lumper receipt", SCALE_TICKET: "Scale ticket", RATE_CONFIRMATION: "Rate confirmation", PERMIT: "Permit", INVOICE: "Invoice", OTHER: "Document" };

/** Open a document in the browser or the phone's viewer. Links last an hour. */
export function openDocument(d: Pick<DocView, "viewUrl" | "url">) {
  const link = d.viewUrl ?? d.url;
  const url = /^https?:/.test(link) ? link : `${API_URL}${link}`;
  if (Platform.OS === "web") window.open(url, "_blank", "noopener");
  else void Linking.openURL(url);
}

function Thumb({ d }: { d: DocView }) {
  const raster = d.contentType && /^image\/(jpeg|png|webp)$/.test(d.contentType);
  // Signed receipts are SVG, which the phone's Image can't draw; the browser can.
  const svgOnWeb = d.contentType === "image/svg+xml" && Platform.OS === "web";
  if ((raster || svgOnWeb) && d.viewUrl) return <Image source={{ uri: `${API_URL}${d.viewUrl}` }} style={{ width: 44, height: 44, borderRadius: 6, marginRight: 12, backgroundColor: "#eee" }} resizeMode="cover" accessibilityIgnoresInvertColors />;
  return null;
}

export function DocumentRows({ docs }: { docs: DocView[] }) {
  return (
    <>
      {docs.map((d) => (
        <Row key={d.id} left={<Thumb d={d} />} title={d.name} subtitle={`${KIND_LABEL[d.kind] ?? titleCase(d.kind)}${d.signedBy ? ` · signed by ${d.signedBy}` : ""} · ${when(d.at)}`} onPress={d.viewUrl || /^https?:/.test(d.url) ? () => openDocument(d) : undefined} />
      ))}
    </>
  );
}

/**
 * Load paperwork: everyone on the load sees it; anyone can add a scan,
 * photo or PDF. The driver also collects the delivery signature here.
 */
export function DocumentsSection({ loadId, docs, pickupStopId, deliveryStopId, onAdded, onSign }: { loadId: string; docs: DocView[]; pickupStopId?: string; deliveryStopId?: string; onAdded: () => unknown; onSign?: () => void }) {
  const [kind, setKind] = useState<DocKind>("BOL");
  const [busy, setBusy] = useState(false);
  const add = (how: "camera" | "library" | "pdf") => async () => {
    try {
      setBusy(true);
      const file = how === "pdf" ? await pickPdf() : await captureImage(how);
      if (!file) return;
      const label = KINDS.find((k) => k.value === kind)!.label;
      const n = docs.filter((d) => d.kind === kind).length + 1;
      const stopId = kind === "BOL" ? pickupStopId : kind === "POD" ? deliveryStopId : undefined;
      await uploadDocument(loadId, kind, `${label === "Other" ? "Document" : label}${n > 1 ? ` page ${n}` : ""}`, file, stopId);
      await onAdded();
    } catch (e) {
      notify("Couldn't add the document", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Documents" footer="Scans are shrunk to a readable size before they upload. Everyone on the load can open them, and they go with the invoice.">
      <DocumentRows docs={docs} />
      <View style={{ padding: 16, gap: 8 }}>
        {onSign ? <Button title="Get delivery signature" onPress={onSign} /> : null}
        <Segmented options={KINDS} value={kind} onChange={setKind} />
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Button title={Platform.OS === "web" ? "Take or upload a photo" : "Scan with camera"} variant="tonal" loading={busy} onPress={add("camera")} style={{ flex: 1 }} />
          {Platform.OS !== "web" ? <Button title="Choose photo" variant="tonal" disabled={busy} onPress={add("library")} style={{ flex: 1 }} /> : null}
          <Button title="Attach PDF" variant="tonal" disabled={busy} onPress={add("pdf")} style={{ flex: 1 }} />
        </View>
      </View>
    </Section>
  );
}
