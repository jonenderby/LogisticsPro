import { type ReactNode, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, TextInput, type TextInputProps, View, type ViewStyle } from "react-native";
import { Icon } from "./Icon";
import { CONTENT_MAX_WIDTH, useLayout } from "./responsive";
import { isIOS, useTheme } from "./theme";
import { useT } from "../state/MeProvider";
import { titleCase } from "./format";

export function Screen({ children, onRefresh, padded = false }: { children: ReactNode; onRefresh?: () => Promise<void>; padded?: boolean }) {
  const { colors } = useTheme();
  const { wide } = useLayout();
  const [refreshing, setRefreshing] = useState(false);
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: padded ? 16 : 0 }}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await onRefresh().finally(() => setRefreshing(false));
            }}
          />
        ) : undefined
      }
    >
      {/* On wide screens content is centered with a readable maximum width. */}
      <View style={wide ? { width: "100%", maxWidth: CONTENT_MAX_WIDTH, alignSelf: "center", paddingTop: 8 } : undefined}>{children}</View>
    </ScrollView>
  );
}

/** iOS inset-grouped section / Material card with an optional header and footer. */
export function Section({ title, footer, children, style, bare }: { title?: string; footer?: string; children: ReactNode; style?: ViewStyle; bare?: boolean }) {
  const { colors, metrics } = useTheme();
  return (
    <View style={[{ marginTop: 20, marginHorizontal: 16 }, style]}>
      {title ? (
        <Text accessibilityRole="header" style={{ color: isIOS ? colors.textSecondary : colors.primary, fontSize: metrics.caption, fontWeight: isIOS ? "400" : "600", textTransform: isIOS ? "uppercase" : "none", marginBottom: 6, marginLeft: isIOS ? 16 : 4 }}>
          {title}
        </Text>
      ) : null}
      {bare ? children : <View style={{ backgroundColor: colors.surface, borderRadius: metrics.radius, overflow: "hidden", ...(isIOS ? {} : { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator }) }}>{children}</View>}
      {footer ? <Text style={{ color: colors.textSecondary, fontSize: metrics.caption, marginTop: 6, marginHorizontal: 16 }}>{footer}</Text> : null}
    </View>
  );
}

export function Row({ title, subtitle, value, onPress, chevron = !!onPress, left, right, destructive, accessibilityHint }: { title: string; subtitle?: string; value?: string; onPress?: () => void; chevron?: boolean; left?: ReactNode; right?: ReactNode; destructive?: boolean; accessibilityHint?: string }) {
  const { colors, metrics } = useTheme();
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: metrics.minTouch, paddingHorizontal: 16, paddingVertical: subtitle ? 10 : 8, gap: 12 }}>
      {left}
      <View style={{ flex: 1 }}>
        <Text style={{ color: destructive ? colors.danger : colors.text, fontSize: metrics.body }}>{title}</Text>
        {subtitle ? <Text style={{ color: colors.textSecondary, fontSize: metrics.callout, marginTop: 2 }}>{subtitle}</Text> : null}
      </View>
      {value ? <Text style={{ color: colors.textSecondary, fontSize: metrics.body, maxWidth: "50%", textAlign: "right" }}>{value}</Text> : null}
      {right}
      {chevron ? <Icon ios="chevron.right" android="chevron_right" size={16} color={colors.textSecondary} /> : null}
    </View>
  );
  const wrapped = onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityHint={accessibilityHint} android_ripple={{ color: colors.surfaceVariant }} style={({ pressed }) => ({ backgroundColor: pressed && isIOS ? colors.surfaceVariant : "transparent" })}>
      {body}
    </Pressable>
  ) : (
    body
  );
  return (
    <View>
      {wrapped}
      <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: isIOS ? 16 : 0 }} />
    </View>
  );
}

export function Button({ title, onPress, variant = "filled", disabled, loading, accessibilityHint, style }: { title: string; onPress: () => unknown; variant?: "filled" | "tonal" | "plain" | "destructive"; disabled?: boolean; loading?: boolean; accessibilityHint?: string; style?: ViewStyle }) {
  const { colors, metrics } = useTheme();
  const [busy, setBusy] = useState(false);
  const bg = variant === "filled" ? colors.primary : variant === "tonal" ? colors.primaryContainer : variant === "destructive" ? colors.dangerContainer : "transparent";
  const fg = variant === "filled" ? colors.onPrimary : variant === "tonal" ? colors.onPrimaryContainer : variant === "destructive" ? colors.danger : colors.primary;
  const isLoading = loading || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || isLoading, busy: isLoading }}
      accessibilityHint={accessibilityHint}
      disabled={disabled || isLoading}
      android_ripple={{ color: colors.surfaceVariant }}
      onPress={async () => {
        setBusy(true);
        try {
          await onPress();
        } finally {
          setBusy(false);
        }
      }}
      style={({ pressed }) => [{ minHeight: metrics.minTouch, borderRadius: metrics.buttonRadius, backgroundColor: bg, alignItems: "center", justifyContent: "center", paddingHorizontal: 20, opacity: disabled ? 0.4 : pressed && isIOS ? 0.7 : 1 }, style]}
    >
      {isLoading ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontSize: metrics.body, fontWeight: "600" }}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, hint, error, ...props }: TextInputProps & { label: string; hint?: string; error?: string }) {
  const { colors, metrics } = useTheme();
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ color: colors.textSecondary, fontSize: metrics.caption, marginBottom: 4 }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.textSecondary}
        style={{ minHeight: metrics.minTouch, borderRadius: isIOS ? 10 : 4, borderWidth: isIOS ? 0 : 1, borderColor: error ? colors.danger : colors.separator, backgroundColor: isIOS ? colors.surface : "transparent", color: colors.text, fontSize: metrics.body, paddingHorizontal: 12 }}
        {...props}
      />
      {error ? <Text style={{ color: colors.danger, fontSize: metrics.caption, marginTop: 4 }}>{error}</Text> : hint ? <Text style={{ color: colors.textSecondary, fontSize: metrics.caption, marginTop: 4 }}>{hint}</Text> : null}
    </View>
  );
}

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

function toneColors(tone: Tone, c: ReturnType<typeof useTheme>["colors"]) {
  switch (tone) {
    case "info":
      return { bg: c.primaryContainer, fg: c.onPrimaryContainer };
    case "success":
      return { bg: c.successContainer, fg: c.success };
    case "warning":
      return { bg: c.warningContainer, fg: c.warning };
    case "danger":
      return { bg: c.dangerContainer, fg: c.danger };
    default:
      return { bg: c.surfaceVariant, fg: c.textSecondary };
  }
}

export function Chip({ label: raw, tone = "neutral", selected, onPress }: { label: string; tone?: Tone; selected?: boolean; onPress?: () => void }) {
  const { colors, metrics } = useTheme();
  // Labels from lookup tables (marked with tx) are translated here.
  const label = useT()(raw);
  // A selected chip takes the selection color unless it carries its own meaning (a status tone).
  const t = toneColors(selected && tone === "neutral" ? "info" : tone, colors);
  return (
    <Pressable disabled={!onPress} onPress={onPress} accessibilityRole={onPress ? "button" : "text"} accessibilityState={{ selected }} style={{ backgroundColor: t.bg, borderRadius: 8, paddingHorizontal: 10, paddingVertical: onPress ? 8 : 3, alignSelf: "flex-start", minHeight: onPress ? 32 : undefined, justifyContent: "center" }}>
      <Text style={{ color: t.fg, fontSize: metrics.caption, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

export function Banner({ tone, title, message }: { tone: Tone; title: string; message?: string }) {
  const { colors, metrics } = useTheme();
  const t = toneColors(tone, colors);
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: t.bg, borderRadius: metrics.radius, padding: 12, marginHorizontal: 16, marginTop: 12 }}>
      <Text style={{ color: t.fg, fontWeight: "700", fontSize: metrics.callout }}>{title}</Text>
      {message ? <Text style={{ color: t.fg, fontSize: metrics.callout, marginTop: 2 }}>{message}</Text> : null}
    </View>
  );
}

/** iOS segmented control look; Material segmented buttons on Android. */
export function Segmented<T extends string>({ options: raw, value, onChange }: { options: Array<{ value: T; label: string }>; value: T; onChange: (v: T) => void }) {
  const { colors, metrics } = useTheme();
  const tr = useT();
  const options = raw.map((o) => ({ ...o, label: tr(o.label) }));
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", backgroundColor: isIOS ? colors.surfaceVariant : "transparent", borderRadius: isIOS ? 9 : 20, padding: isIOS ? 2 : 0, borderWidth: isIOS ? 0 : 1, borderColor: colors.separator, overflow: "hidden" }}>
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(o.value)}
            style={{ flex: 1, minHeight: isIOS ? 32 : 40, alignItems: "center", justifyContent: "center", borderRadius: isIOS ? 7 : 0, backgroundColor: selected ? (isIOS ? colors.surface : colors.primaryContainer) : "transparent", borderLeftWidth: !isIOS && i > 0 ? 1 : 0, borderColor: colors.separator }}
          >
            <Text numberOfLines={1} style={{ color: selected && !isIOS ? colors.onPrimaryContainer : colors.text, fontSize: metrics.callout, fontWeight: selected ? "600" : "400" }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Empty({ title, message, action }: { title: string; message?: string; action?: ReactNode }) {
  const { colors, metrics } = useTheme();
  return (
    <View style={{ alignItems: "center", padding: 32, gap: 8 }}>
      <Text style={{ color: colors.text, fontSize: metrics.title, fontWeight: "600", textAlign: "center" }}>{title}</Text>
      {message ? <Text style={{ color: colors.textSecondary, fontSize: metrics.body, textAlign: "center" }}>{message}</Text> : null}
      {action}
    </View>
  );
}

export function Body({ children, secondary, style }: { children: ReactNode; secondary?: boolean; style?: object }) {
  const { colors, metrics } = useTheme();
  return <Text style={[{ color: secondary ? colors.textSecondary : colors.text, fontSize: metrics.body }, style]}>{children}</Text>;
}

export function Padded({ children }: { children: ReactNode }) {
  return <View style={{ padding: 16, gap: 10 }}>{children}</View>;
}

const STATUS_TONE: Record<string, Tone> = {
  DRAFT: "neutral",
  POSTED: "info",
  TENDERED: "warning",
  BOOKED: "info",
  DISPATCHED: "info",
  AT_PICKUP: "warning",
  IN_TRANSIT: "info",
  AT_DELIVERY: "warning",
  DELIVERED: "success",
  INVOICED: "success",
  CANCELLED: "danger",
};

export function StatusPill({ status }: { status: string }) {
  const t = useT();
  return <Chip label={t(titleCase(status)).toUpperCase()} tone={STATUS_TONE[status] ?? "neutral"} />;
}

/** A settings row with a platform switch (UISwitch on iOS, Material switch on Android). */
export function ToggleRow({ title, subtitle, value, onChange }: { title: string; subtitle?: string; value: boolean; onChange: (v: boolean) => void }) {
  const { colors } = useTheme();
  return <Row title={title} subtitle={subtitle} right={<Switch accessibilityLabel={title} value={value} onValueChange={onChange} trackColor={{ true: colors.primary }} />} />;
}
