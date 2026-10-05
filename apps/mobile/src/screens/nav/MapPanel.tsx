import { Text, View } from "react-native";
import type { MapPanelProps } from "./MapPanel.types";

/** Web build: maps run in the iOS and Android apps; guidance still works here. */
export function MapPanel({ line, mode }: MapPanelProps) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
      <Text style={{ textAlign: "center", color: "#6C6C70" }}>
        {mode === "OVERSIZE" ? "Permitted route" : "Route"} with {line.length} points. The live map is available in the iOS and Android apps.
      </Text>
    </View>
  );
}
