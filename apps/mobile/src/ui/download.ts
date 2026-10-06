import { Platform, Share } from "react-native";

/** Save a text file: a download on the website, the share sheet on phones. */
export async function saveTextFile(name: string, content: string, type = "text/plain"): Promise<void> {
  if (Platform.OS === "web") {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  await Share.share({ title: name, message: content });
}
