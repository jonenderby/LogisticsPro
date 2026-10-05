import * as DocumentPicker from "expo-document-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";
import { api } from "../api/client";

export type DocKind = "BOL" | "POD" | "LUMPER_RECEIPT" | "SCALE_TICKET" | "OTHER";
interface Picked {
  data: string;
  contentType: "image/jpeg" | "application/pdf";
}

/** Long edge of a scanned page: sharp enough to read, small enough for a weak signal. */
const MAX_EDGE = 1800;

/**
 * Photograph a page (or pick a photo), crop it on phones, and shrink it to a
 * readable JPEG. On the website the camera opens through the browser's file
 * picker.
 */
export async function captureImage(source: "camera" | "library"): Promise<Picked | undefined> {
  if (source === "camera" && Platform.OS !== "web") {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error("Allow camera access in Settings to scan paperwork.");
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 1, allowsEditing: Platform.OS !== "web", exif: false };
  const result = source === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return undefined;
  const page = ImageManipulator.manipulate(asset.uri);
  const long = Math.max(asset.width, asset.height);
  if (long > MAX_EDGE) page.resize(asset.width >= asset.height ? { width: MAX_EDGE } : { height: MAX_EDGE });
  const saved = await (await page.renderAsync()).saveAsync({ base64: true, compress: 0.6, format: SaveFormat.JPEG });
  if (!saved.base64) throw new Error("Couldn't read the photo");
  return { data: saved.base64.replace(/^data:[^,]+,/, ""), contentType: "image/jpeg" };
}

/** Pick a PDF someone already has (an emailed BOL, a lumper receipt). */
export async function pickPdf(): Promise<Picked | undefined> {
  const result = await DocumentPicker.getDocumentAsync({ type: "application/pdf", copyToCacheDirectory: true, multiple: false });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return undefined;
  const blob = asset.file ?? (await (await fetch(asset.uri)).blob());
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(blob);
  });
  return { data: url.replace(/^data:[^,]+,/, ""), contentType: "application/pdf" };
}

export function uploadDocument(loadId: string, kind: DocKind, name: string, file: Picked, stopId?: string) {
  return api.post(`/v1/loads/${loadId}/documents/upload`, { kind, name, contentType: file.contentType, data: file.data, stopId });
}
