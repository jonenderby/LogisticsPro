import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Text, TextInput, View } from "react-native";
import { api } from "../api/client";
import type { ThreadMessage } from "../api/types";
import { useNav, useParams } from "../navigation/types";
import { useMe, useT } from "../state/MeProvider";
import { Button, Chip, Empty, Row, Screen, Section } from "../ui/components";
import { when } from "../ui/format";
import { useTheme } from "../ui/theme";

interface Thread {
  loadId: string;
  loadNumber: string;
  unread: number;
  last: ThreadMessage;
}

export function MessagesScreen() {
  const t = useT();
  const nav = useNav();
  const [threads, setThreads] = useState<Thread[]>([]);
  const refresh = useCallback(async () => setThreads(await api.get<Thread[]>("/v1/messages/threads")), []);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  return (
    <Screen onRefresh={refresh}>
      <Section>
        {threads.length === 0 ? <Empty title={t("No conversations")} message={t("Every load has a thread shared by the driver, carrier and shipper.")} /> : null}
        {threads.map((t) => (
          <Row key={t.loadId} title={t.loadNumber} subtitle={t.last.body} value={when(t.last.createdAt)} right={t.unread ? <Chip label={String(t.unread)} tone="info" /> : undefined} onPress={() => nav.navigate("Thread", { loadId: t.loadId, title: t.loadNumber })} />
        ))}
      </Section>
    </Screen>
  );
}

/** Load thread: free text plus status updates posted automatically by the app. */
export function ThreadScreen() {
  const t = useT();
  const { loadId, title } = useParams<"Thread">();
  const nav = useNav();
  const { me } = useMe();
  const { colors, metrics } = useTheme();
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [draft, setDraft] = useState("");
  const list = useRef<FlatList<ThreadMessage>>(null);

  const refresh = useCallback(async () => setMessages(await api.get<ThreadMessage[]>(`/v1/loads/${loadId}/messages`)), [loadId]);
  useEffect(() => {
    nav.setOptions({ title });
    void refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [nav, refresh, title]);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.background }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        renderItem={({ item }) => {
          const mine = item.senderAccountId === me?.account.id;
          if (item.kind !== "TEXT") {
            return (
              <View style={{ alignItems: "center" }}>
                <Chip label={`${item.body} · ${when(item.createdAt)}`} tone={item.kind === "STATUS" ? "info" : "neutral"} />
              </View>
            );
          }
          return (
            <View style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "80%", backgroundColor: mine ? colors.primary : colors.surface, borderRadius: 16, padding: 10 }}>
              {!mine ? <Text style={{ color: colors.textSecondary, fontSize: metrics.caption }}>{item.senderName}</Text> : null}
              <Text style={{ color: mine ? colors.onPrimary : colors.text, fontSize: metrics.body }}>{item.body}</Text>
            </View>
          );
        }}
      />
      <View style={{ flexDirection: "row", gap: 8, padding: 8, borderTopWidth: 0.5, borderTopColor: colors.separator, backgroundColor: colors.surface }}>
        <TextInput accessibilityLabel={t("Message")} value={draft} onChangeText={setDraft} placeholder={t("Message")} placeholderTextColor={colors.textSecondary} multiline style={{ flex: 1, minHeight: metrics.minTouch, color: colors.text, fontSize: metrics.body, paddingHorizontal: 12, borderRadius: 20, backgroundColor: colors.background }} />
        <Button
          title={t("Send")}
          disabled={!draft.trim()}
          onPress={async () => {
            await api.post(`/v1/loads/${loadId}/messages`, { body: draft.trim() });
            setDraft("");
            await refresh();
          }}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
