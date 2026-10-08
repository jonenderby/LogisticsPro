import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../auth/AuthProvider";
import { useMe } from "../state/MeProvider";
import { notify } from "./dialog";
import { errorMessage } from "../api/client";
import { useTheme } from "./theme";

const PROFILE: Record<string, string> = { TRUCKER: "Trucker", CARRIER: "Carrier", BROKER_3PL: "3PL", BUSINESS: "Business" };

/**
 * While a platform admin uses the app as a test account, a bar across the top
 * says whose app this is and takes them back to their own account.
 */
export function SwitchedFrame({ children }: { children: ReactNode }) {
  const { me, t } = useMe();
  const { switchBack } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  if (!me?.actingAs) return <>{children}</>;
  const who = `${me.account.name} · ${t(PROFILE[me.account.profileType] ?? me.account.profileType)}`;
  return (
    <View style={{ flex: 1 }}>
      <View
        accessibilityRole="summary"
        style={{ backgroundColor: colors.warningContainer, paddingTop: insets.top + 6, paddingBottom: 6, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 12 }}
      >
        <Text style={{ flex: 1, color: colors.text, fontSize: 14 }} numberOfLines={2}>
          {t("Viewing as {who}", { who })}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void switchBack().catch((e) => notify(t("Couldn't switch back"), errorMessage(e)))}
          style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderRadius: 999, backgroundColor: colors.surface }}
        >
          <Text style={{ color: colors.primary, fontWeight: "600", fontSize: 14 }}>{t("Back to my account")}</Text>
        </Pressable>
      </View>
      {/* The bar already covers the status bar, so screens below don't pad for it again. */}
      <SafeAreaInsetsContext.Provider value={{ ...insets, top: 0 }}>{children}</SafeAreaInsetsContext.Provider>
    </View>
  );
}
