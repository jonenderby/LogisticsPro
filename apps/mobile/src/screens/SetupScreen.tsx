import { tx } from "@logisticspro/workspace";
import { useFocusEffect } from "@react-navigation/native";
import Constants from "expo-constants";
import { useCallback, useState } from "react";
import { api, errorMessage } from "../api/client";
import { IS_WEB } from "../config";
import { useT } from "../state/MeProvider";
import { Chip, Empty, Row, Screen, Section, type Tone } from "../ui/components";

interface SetupItem {
  id: string;
  title: string;
  state: "OK" | "WARN" | "OFF";
  detail: string;
  settings: string[];
}

const STATE: Record<SetupItem["state"], { label: string; tone: Tone }> = {
  OK: { label: tx("Ready"), tone: "success" },
  WARN: { label: tx("Needs attention"), tone: "warning" },
  OFF: { label: tx("Not set up"), tone: "neutral" },
};

/**
 * For the people who run this deployment: which outside services are
 * connected and what is still missing, with the settings that change each.
 */
export function SetupScreen() {
  const t = useT();
  const [items, setItems] = useState<SetupItem[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      setItems((await api.get<{ items: SetupItem[] }>("/v1/system/setup")).items);
      setError(undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const projectId = Constants.easConfig?.projectId ?? (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;

  if (error) return <Screen><Empty title={t("Couldn't load setup status")} message={error} /></Screen>;
  if (!items) return <Screen><Empty title={t("Loading…")} /></Screen>;
  const open = items.filter((i) => i.state !== "OK").length;
  return (
    <Screen onRefresh={load}>
      <Section title={t("Server")} footer={open ? t("Change these with the server's environment settings, then restart it.") : t("Everything is set up.")}>
        {items.map((i) => (
          <Row key={i.id} title={i.title} subtitle={`${i.detail}\n${i.settings.join(", ")}`} right={<Chip label={STATE[i.state].label} tone={STATE[i.state].tone} />} />
        ))}
      </Section>
      {IS_WEB ? null : (
        <Section title={t("This app")}>
          <Row
            title={t("Push project")}
            subtitle={projectId ? t("This build can receive push.") : t("This build has no EAS project ID, so phones can't receive push. Set EAS_PROJECT_ID when building.")}
            right={<Chip label={projectId ? STATE.OK.label : STATE.WARN.label} tone={projectId ? "success" : "warning"} />}
          />
        </Section>
      )}
    </Screen>
  );
}
