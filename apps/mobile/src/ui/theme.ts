import { Platform, useColorScheme } from "react-native";

/**
 * Platform-adaptive design tokens. iOS follows Human Interface Guidelines
 * (system grouped backgrounds, 44pt targets, 17pt body); Android follows
 * Material 3 (tonal surfaces, 48dp targets, rounded pill buttons).
 */
export const isIOS = Platform.OS === "ios";

const light = {
  background: isIOS ? "#F2F2F7" : "#F8F9FF",
  surface: "#FFFFFF",
  surfaceVariant: isIOS ? "#E5E5EA" : "#E1E2EC",
  text: isIOS ? "#000000" : "#191C20",
  textSecondary: isIOS ? "#6C6C70" : "#44474E",
  separator: isIOS ? "#C6C6C8" : "#C4C6D0",
  primary: "#1D5FD1",
  onPrimary: "#FFFFFF",
  primaryContainer: isIOS ? "#E3ECFB" : "#D8E2FF",
  onPrimaryContainer: "#001A41",
  danger: isIOS ? "#FF3B30" : "#BA1A1A",
  dangerContainer: "#FFDAD6",
  success: isIOS ? "#248A3D" : "#1E6B2F",
  successContainer: "#D4F5DC",
  warning: isIOS ? "#C93400" : "#8B5000",
  warningContainer: "#FFE2C7",
};

const dark: typeof light = {
  background: isIOS ? "#000000" : "#111318",
  surface: isIOS ? "#1C1C1E" : "#1D2024",
  surfaceVariant: isIOS ? "#2C2C2E" : "#44474E",
  text: isIOS ? "#FFFFFF" : "#E2E2E9",
  textSecondary: isIOS ? "#AEAEB2" : "#C4C6D0",
  separator: isIOS ? "#38383A" : "#44474E",
  primary: "#8AB4FF",
  onPrimary: "#002E6A",
  primaryContainer: isIOS ? "#0A2A5C" : "#00458F",
  onPrimaryContainer: "#D8E2FF",
  danger: isIOS ? "#FF453A" : "#FFB4AB",
  dangerContainer: "#93000A",
  success: isIOS ? "#30D158" : "#8CD99A",
  successContainer: "#0D3B18",
  warning: isIOS ? "#FF9F0A" : "#FFB870",
  warningContainer: "#4A2800",
};

export type Colors = typeof light;

export const metrics = {
  minTouch: isIOS ? 44 : 48,
  radius: isIOS ? 10 : 12,
  buttonRadius: isIOS ? 12 : 24,
  gutter: 16,
  body: isIOS ? 17 : 16,
  callout: isIOS ? 15 : 14,
  caption: isIOS ? 13 : 12,
  title: isIOS ? 22 : 22,
};

export function useTheme() {
  const scheme = useColorScheme();
  const colors = scheme === "dark" ? dark : light;
  return { colors, dark: scheme === "dark", metrics };
}
