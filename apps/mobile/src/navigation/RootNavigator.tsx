import { tx } from "@logisticspro/workspace";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { DarkTheme, DefaultTheme, NavigationContainer, createNavigationContainerRef } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { type ComponentType, useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useAuth } from "../auth/AuthProvider";
import { BoardScreen } from "../screens/BoardScreen";
import { BusinessScreen, RegisterCompanyScreen } from "../screens/BusinessScreens";
import { DispatchScreen } from "../screens/DispatchScreen";
import { IntegrationsScreen, PartnerEditScreen } from "../screens/IntegrationsScreens";
import { LoadDetailScreen } from "../screens/LoadDetailScreen";
import { LoadsScreen } from "../screens/LoadsScreen";
import { MessagesScreen, ThreadScreen } from "../screens/MessagesScreens";
import { MoneyScreen, SendInvoiceScreen } from "../screens/MoneyScreens";
import { MoreScreen, SecurityScreen } from "../screens/MoreScreens";
import { NavigateScreen } from "../screens/NavigateScreen";
import { JoinCarrierScreen, ReliabilityScreen } from "../screens/NetworkScreens";
import { NewLoadScreen } from "../screens/NewLoadScreen";
import { TodayScreen } from "../screens/TodayScreen";
import { TrackScreen } from "../screens/TrackScreen";
import { AuthFlow } from "../screens/auth/AuthFlow";
import { MeProvider, useMe, useT } from "../state/MeProvider";
import { useLocationSharing } from "../state/useLocationSharing";
import { type OpenTarget, useBrowserAlerts, usePushNotifications, useReportTimeZone } from "../state/notifications";
import { AlertsScreen } from "../screens/AlertsScreen";
import { DrivingLock } from "../ui/DrivingLock";
import { SwitchedFrame } from "../ui/SwitchedBanner";
import { HoursScreen } from "../screens/HoursScreen";
import { FuelTaxScreen } from "../screens/FuelTaxScreen";
import { RateConfirmationScreen } from "../screens/RateConfirmationScreen";
import { CarrierCheckScreen } from "../screens/CarrierCheckScreen";
import { SignatureScreen } from "../screens/SignatureScreen";
import { InsightsScreen } from "../screens/InsightsScreen";
import { SetupScreen } from "../screens/SetupScreen";
import { AdminScreen } from "../screens/AdminScreen";
import { HistoryScreen } from "../screens/HistoryScreen";
import { AchPaymentsScreen } from "../screens/AchPaymentsScreen";
import { MyPayScreen, SettlementDetailScreen, SettlementsScreen } from "../screens/SettlementScreens";
import { InvoiceDetailScreen } from "../screens/MoneyScreens";
import { NotificationsScreen } from "../screens/NotificationsScreen";
import { Icon } from "../ui/Icon";
import { useLayout } from "../ui/responsive";
import { isIOS, useTheme } from "../ui/theme";
import { buildLinking } from "./linking";
import type { StackParams } from "./types";

const Tabs = createBottomTabNavigator();
const Stack = createNativeStackNavigator<StackParams>();

type TabRoot = "Today" | "Loads" | "Track" | "Navigate" | "Board" | "Messages" | "Money" | "Business" | "More";

const ROOTS: Record<string, { name: TabRoot; component: ComponentType }> = {
  today: { name: "Today", component: TodayScreen },
  loads: { name: "Loads", component: LoadsScreen },
  track: { name: "Track", component: TrackScreen },
  navigate: { name: "Navigate", component: NavigateScreen },
  board: { name: "Board", component: BoardScreen },
  messages: { name: "Messages", component: MessagesScreen },
  money: { name: "Money", component: MoneyScreen },
  business: { name: "Business", component: BusinessScreen },
  more: { name: "More", component: MoreScreen },
};

/** Screens every tab can push, so the tab bar stays put while drilling in. */
const SHARED: Array<{ name: keyof StackParams; component: ComponentType; title: string }> = [
  { name: "LoadDetail", component: LoadDetailScreen, title: tx("Load") },
  { name: "Thread", component: ThreadScreen, title: tx("Messages") },
  { name: "NewLoad", component: NewLoadScreen, title: tx("New load") },
  { name: "Dispatch", component: DispatchScreen, title: tx("Plan dispatch") },
  { name: "SendInvoice", component: SendInvoiceScreen, title: tx("Send invoice") },
  { name: "Integrations", component: IntegrationsScreen, title: tx("Integrations") },
  { name: "PartnerEdit", component: PartnerEditScreen, title: tx("Partner") },
  { name: "RegisterCompany", component: RegisterCompanyScreen, title: tx("Register company") },
  { name: "Security", component: SecurityScreen, title: tx("Sign-in & security") },
  { name: "JoinCarrier", component: JoinCarrierScreen, title: tx("Join a carrier") },
  { name: "Reliability", component: ReliabilityScreen, title: tx("My reliability") },
  { name: "Alerts", component: AlertsScreen, title: tx("Arrival alerts") },
  { name: "Hours", component: HoursScreen, title: tx("Hours of service") },
  { name: "FuelTax", component: FuelTaxScreen, title: tx("Fuel tax (IFTA)") },
  { name: "Notifications", component: NotificationsScreen, title: tx("Notifications") },
  { name: "RateConfirmation", component: RateConfirmationScreen, title: tx("Rate confirmation") },
  { name: "InvoiceDetail", component: InvoiceDetailScreen, title: tx("Invoice") },
  { name: "CarrierCheck", component: CarrierCheckScreen, title: tx("Carrier check") },
  { name: "Signature", component: SignatureScreen, title: tx("Delivery signature") },
  { name: "Insights", component: InsightsScreen, title: tx("Insights") },
  { name: "Setup", component: SetupScreen, title: tx("Setup status") },
  { name: "Admin", component: AdminScreen, title: tx("Admin") },
  { name: "History", component: HistoryScreen, title: tx("Older loads") },
  { name: "AchPayments", component: AchPaymentsScreen, title: tx("Pay by ACH") },
  { name: "Settlements", component: SettlementsScreen, title: tx("Driver pay") },
  { name: "SettlementDetail", component: SettlementDetailScreen, title: tx("Pay statement") },
  { name: "MyPay", component: MyPayScreen, title: tx("My pay") },
];

function stackFor(root: TabRoot) {
  return function TabStack() {
    const tr = useT();
    const others = Object.values(ROOTS).filter((r) => r.name !== root);
    return (
      <Stack.Navigator screenOptions={{ headerLargeTitle: isIOS, headerTransparent: false }}>
        <Stack.Screen name={root} component={ROOTS[root.toLowerCase()]!.component} options={{ title: tr(root) }} />
        {SHARED.map((s) => (
          <Stack.Screen key={s.name} name={s.name} component={s.component} options={{ title: tr(s.title), headerLargeTitle: false }} />
        ))}
        {/* Destinations that overflowed into More are reachable from any tab. */}
        {others.map((r) => (
          <Stack.Screen key={r.name} name={r.name} component={r.component} options={{ title: tr(r.name), headerLargeTitle: false }} />
        ))}
      </Stack.Navigator>
    );
  };
}

const STACKS = Object.fromEntries(Object.values(ROOTS).map((r) => [r.name, stackFor(r.name)])) as unknown as Record<TabRoot, ComponentType>;

/** Icons for destinations that live under More on phones but get their own sidebar entry on wide screens. */
const EXTRA_ICONS: Record<string, { ios: string; android: string }> = {
  loads: { ios: "shippingbox", android: "local_shipping" },
  track: { ios: "mappin.and.ellipse", android: "location_on" },
  navigate: { ios: "map", android: "navigation" },
  board: { ios: "list.bullet.rectangle", android: "view_list" },
  messages: { ios: "bubble.left.and.bubble.right", android: "chat" },
  money: { ios: "dollarsign.circle", android: "payments" },
  business: { ios: "building.2", android: "business" },
};

/**
 * Phones: up to four tabs plus More along the bottom (HIG / Material 3).
 * Wide screens (desktop web, tablets): a sidebar with every destination.
 */
const navigationRef = createNavigationContainerRef<Record<string, object | undefined>>();

function AppNavigation() {
  const { me, t: tr } = useMe();
  useLocationSharing();
  // A tapped notification opens its load or thread; one that launched the app waits until navigation is ready.
  const pendingLoad = useRef<OpenTarget | undefined>(undefined);
  const firstTab = useRef("TodayTab");
  const openLoad = useCallback((t: OpenTarget) => {
    if (!navigationRef.isReady()) {
      pendingLoad.current = t;
      return;
    }
    if (t.open === "INVOICE") navigationRef.navigate(firstTab.current, { screen: "InvoiceDetail", params: { id: t.invoiceId } });
    else if (t.open === "SETTLEMENT") navigationRef.navigate(firstTab.current, { screen: "SettlementDetail", params: { id: t.settlementId } });
    else if (t.open === "THREAD") navigationRef.navigate(firstTab.current, { screen: "Thread", params: { loadId: t.loadId, title: t.loadNumber ?? "Messages" } });
    else navigationRef.navigate(firstTab.current, { screen: "LoadDetail", params: { id: t.loadId } });
  }, []);
  const [routeName, setRouteName] = useState<string>();
  const openNavigation = useCallback((loadId?: string) => {
    if (navigationRef.isReady()) navigationRef.navigate(firstTab.current, { screen: "Navigate", params: loadId ? { loadId } : undefined });
  }, []);
  usePushNotifications(!!me, openLoad);
  useReportTimeZone(!!me);
  useBrowserAlerts(!!me, openLoad);
  const { dark, colors } = useTheme();
  const { wide } = useLayout();
  const tabs = useMemo(() => {
    if (!me) return [];
    const primary = me.workspace.tabs.filter((t) => t.id !== "more");
    const more = me.workspace.tabs.find((t) => t.id === "more")!;
    const extra = wide
      ? me.workspace.more.filter((m) => ROOTS[m.id] && !primary.some((p) => p.id === m.id)).map((m) => ({ id: m.id as typeof more.id, title: tr(m.title), icon: EXTRA_ICONS[m.id]! }))
      : [];
    return [...primary, ...extra, more].map((t) => ({ ...t, root: ROOTS[t.id]!.name }));
  }, [me, wide, tr]);
  const linking = useMemo(() => buildLinking(tabs, Object.values(ROOTS).map((r) => r.name)), [tabs]);
  if (tabs[0]) firstTab.current = `${tabs[0].root}Tab`;

  if (!me) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}>
        <ActivityIndicator />
      </View>
    );
  }
  const base = dark ? DarkTheme : DefaultTheme;
  const theme = { ...base, colors: { ...base.colors, primary: colors.primary, background: colors.background, card: colors.surface, text: colors.text, border: colors.separator } };
  return (
    <NavigationContainer
      ref={navigationRef}
      onReady={() => {
        const id = pendingLoad.current;
        pendingLoad.current = undefined;
        if (id) openLoad(id);
      }}
      theme={theme}
      linking={linking}
      onStateChange={() => setRouteName(navigationRef.getCurrentRoute()?.name)}
      documentTitle={{ formatter: (options, route) => `${options?.title ?? route?.name ?? "Home"} · Logistics Pro` }}>
      <Tabs.Navigator
        key={wide ? "wide" : "narrow"}
        screenOptions={{
          headerShown: false,
          tabBarPosition: wide ? "left" : "bottom",
          tabBarVariant: wide ? "material" : "uikit",
          tabBarActiveTintColor: colors.primary,
          tabBarStyle: { backgroundColor: colors.surface },
          tabBarLabelPosition: wide ? "beside-icon" : undefined,
        }}
      >
        {tabs.map((t) => (
          <Tabs.Screen
            key={t.id}
            name={`${t.root}Tab`}
            component={STACKS[t.root]}
            options={{ title: tr(t.title), tabBarIcon: ({ color, size }) => <Icon ios={t.icon.ios} android={t.icon.android} color={color} size={size} /> }}
          />
        ))}
      </Tabs.Navigator>
      <DrivingLock onNavigate={openNavigation} routeName={routeName} />
    </NavigationContainer>
  );
}

export function RootNavigator() {
  const { phase, epoch } = useAuth();
  const { colors } = useTheme();
  if (phase.name === "loading") return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  if (phase.name !== "signedIn") return <AuthFlow />;
  return (
    // A new epoch (an admin switched account) starts the signed-in app over as that account.
    <MeProvider key={epoch}>
      <SwitchedFrame>
        <AppNavigation />
      </SwitchedFrame>
    </MeProvider>
  );
}
