import { Text, View } from "react-native";
import { useT } from "../../state/MeProvider";
import type { MapPanelProps } from "./MapPanel.types";

/** Web build: maps run in the iOS and Android apps; guidance still works here. */
export function MapPanel({ line, mode }: MapPanelProps) {
  const t = useT();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
      <Text style={{ textAlign: "center", color: "#6C6C70" }}>
        {t(mode === "OVERSIZE" ? "Permitted route with {n} points. The live map is available in the iOS and Android apps." : "Route with {n} points. The live map is available in the iOS and Android apps.", { n: line.length })}
      </Text>
    </View>
  );
}
