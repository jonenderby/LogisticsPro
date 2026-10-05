import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { ComponentType } from "react";
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
import { NewLoadScreen } from "../screens/NewLoadScreen";
import { TodayScreen } from "../screens/TodayScreen";
import { AuthFlow } from "../screens/auth/AuthFlow";
import { MeProvider, useMe } from "../state/MeProvider";
import { Icon } from "../ui/Icon";
import { isIOS, useTheme } from "../ui/theme";
import type { StackParams } from "./types";

const Tabs = createBottomTabNavigator();
const Stack = createNativeStackNavigator<StackParams>();

type TabRoot = "Today" | "Loads" | "Navigate" | "Board" | "Messages" | "Money" | "Business" | "More";

const ROOTS: Record<string, { name: TabRoot; component: ComponentType }> = {
  today: { name: "Today", component: TodayScreen },
  loads: { name: "Loads", component: LoadsScreen },
  navigate: { name: "Navigate", component: NavigateScreen },
  board: { name: "Board", component: BoardScreen },
  messages: { name: "Messages", component: MessagesScreen },
  money: { name: "Money", component: MoneyScreen },
  business: { name: "Business", component: BusinessScreen },
  more: { name: "More", component: MoreScreen },
};

/** Screens every tab can push, so the tab bar stays put while drilling in. */
const SHARED: Array<{ name: keyof StackParams; component: ComponentType; title: string }> = [
  { name: "LoadDetail", component: LoadDetailScreen, title: "Load" },
  { name: "Thread", component: ThreadScreen, title: "Messages" },
  { name: "NewLoad", component: NewLoadScreen, title: "New load" },
  { name: "Dispatch", component: DispatchScreen, title: "Plan dispatch" },
  { name: "SendInvoice", component: SendInvoiceScreen, title: "Send invoice" },
  { name: "Integrations", component: IntegrationsScreen, title: "Integrations" },
  { name: "PartnerEdit", component: PartnerEditScreen, title: "Partner" },
  { name: "RegisterCompany", component: RegisterCompanyScreen, title: "Register company" },
  { name: "Security", component: SecurityScreen, title: "Sign-in & security" },
];

function stackFor(root: TabRoot) {
  return function TabStack() {
    const others = Object.values(ROOTS).filter((r) => r.name !== root);
    return (
      <Stack.Navigator screenOptions={{ headerLargeTitle: isIOS, headerTransparent: false }}>
        <Stack.Screen name={root} component={ROOTS[root.toLowerCase()]!.component} />
        {SHARED.map((s) => (
          <Stack.Screen key={s.name} name={s.name} component={s.component} options={{ title: s.title, headerLargeTitle: false }} />
        ))}
        {/* Destinations that overflowed into More are reachable from any tab. */}
        {others.map((r) => (
          <Stack.Screen key={r.name} name={r.name} component={r.component} options={{ headerLargeTitle: false }} />
        ))}
      </Stack.Navigator>
    );
  };
}

const STACKS = Object.fromEntries(Object.values(ROOTS).map((r) => [r.name, stackFor(r.name)])) as unknown as Record<TabRoot, ComponentType>;

function AppTabs() {
  const { me } = useMe();
  const { colors } = useTheme();
  if (!me) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}>
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <Tabs.Navigator screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.primary, tabBarStyle: { backgroundColor: colors.surface } }}>
      {me.workspace.tabs.map((t) => {
        const root = ROOTS[t.id]!;
        return (
          <Tabs.Screen
            key={t.id}
            name={`${root.name}Tab`}
            component={STACKS[root.name]}
            options={{ title: t.title, tabBarIcon: ({ color, size }) => <Icon ios={t.icon.ios} android={t.icon.android} color={color} size={size} /> }}
          />
        );
      })}
    </Tabs.Navigator>
  );
}

export function RootNavigator() {
  const { phase } = useAuth();
  const { dark, colors } = useTheme();
  const base = dark ? DarkTheme : DefaultTheme;
  const theme = { ...base, colors: { ...base.colors, primary: colors.primary, background: colors.background, card: colors.surface, text: colors.text, border: colors.separator } };
  if (phase.name === "loading") return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  if (phase.name !== "signedIn") return <AuthFlow />;
  return (
    <NavigationContainer theme={theme}>
      <MeProvider>
        <AppTabs />
      </MeProvider>
    </NavigationContainer>
  );
}
