import { type NavigationProp, type RouteProp, useNavigation, useRoute } from "@react-navigation/native";

export type StackParams = {
  Today: undefined;
  Loads: { filter?: string } | undefined;
  Navigate: { loadId?: string } | undefined;
  Board: undefined;
  Messages: undefined;
  Money: undefined;
  Business: undefined;
  More: undefined;
  LoadDetail: { id: string };
  Thread: { loadId: string; title: string };
  NewLoad: undefined;
  Dispatch: { loadId: string };
  SendInvoice: { loadId: string };
  Integrations: undefined;
  PartnerEdit: { orgId: string; key: string };
  RegisterCompany: undefined;
  Security: undefined;
};

export const useNav = () => useNavigation<NavigationProp<StackParams>>();
export const useParams = <K extends keyof StackParams>() => useRoute<RouteProp<StackParams, K>>().params as StackParams[K];
