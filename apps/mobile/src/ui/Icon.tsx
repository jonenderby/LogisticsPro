import { SymbolView } from "expo-symbols";
import type { ComponentProps } from "react";
import { Text } from "react-native";

type Name = ComponentProps<typeof SymbolView>["name"];

/** SF Symbols on iOS, Material Symbols on Android and web. */
export function Icon({ ios, android, size = 24, color }: { ios: string; android: string; size?: number; color: string }) {
  return (
    <SymbolView
      name={{ ios, android, web: android } as Name}
      size={size}
      tintColor={color}
      fallback={<Text style={{ color, fontSize: size * 0.6 }}>•</Text>}
    />
  );
}
