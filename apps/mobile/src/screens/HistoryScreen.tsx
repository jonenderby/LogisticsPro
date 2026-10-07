import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import type { Load } from "../api/types";
import { useNav } from "../navigation/types";
import { useT } from "../state/MeProvider";
import { Button, Empty, Field, Padded, Screen, Section } from "../ui/components";
import { LoadRow } from "./LoadsScreen";

/**
 * Loads finished in earlier months. They are kept in the database rather than
 * in the working lists; search by load number, reference or city.
 */
export function HistoryScreen() {
  const t = useT();
  const nav = useNav();
  const [q, setQ] = useState("");
  const [loads, setLoads] = useState<Load[]>();
  const [next, setNext] = useState<string>();
  const [error, setError] = useState<string>();

  const fetchPage = useCallback(
    async (before?: string) => {
      try {
        const params = new URLSearchParams();
        if (q.trim()) params.set("q", q.trim());
        if (before) params.set("before", before);
        const query = params.toString();
        const page = await api.get<{ loads: Load[]; next?: string }>(`/v1/loads/history${query ? `?${query}` : ""}`);
        setLoads((prev) => (before ? [...(prev ?? []), ...page.loads] : page.loads));
        setNext(page.next);
        setError(undefined);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [q],
  );
  // Search as you type, after a short pause.
  useEffect(() => {
    const timer = setTimeout(() => void fetchPage(), 300);
    return () => clearTimeout(timer);
  }, [fetchPage]);

  return (
    <Screen onRefresh={() => fetchPage()}>
      <Padded>
        <Field label={t("Search")} value={q} onChangeText={setQ} placeholder={t("Load number, BOL, PO or city")} autoCapitalize="none" />
      </Padded>
      <Section>
        {error ? <Empty title={t("Couldn't load older loads")} message={error} /> : null}
        {loads && !loads.length && !error ? <Empty title={t("No older loads")} message={q ? t("Nothing matches your search.") : t("Loads appear here a few months after they are finished.")} /> : null}
        {loads?.map((l) => <LoadRow key={l.id} load={l} onOpen={(id) => nav.navigate("LoadDetail", { id })} />)}
      </Section>
      {next ? (
        <Padded>
          <Button title={t("Show more")} variant="tonal" onPress={() => void fetchPage(next)} />
        </Padded>
      ) : null}
    </Screen>
  );
}
