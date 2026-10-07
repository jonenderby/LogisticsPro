import { useState } from "react";
import { type LayoutChangeEvent, Platform, Pressable, Text, View } from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { useTheme } from "./theme";

/**
 * Chart pieces for the Insights screen, following one set of rules: a single
 * blue series (validated against both card surfaces), thin marks, hairline
 * gridlines, text in text colors (never the series color), a readout on
 * hover or press, and a table view for every chart.
 */
export function useChartColors() {
  const { dark, colors } = useTheme();
  return {
    series: dark ? "#3987e5" : "#2a78d6",
    wash: dark ? "rgba(57,135,229,0.12)" : "rgba(42,120,214,0.10)",
    grid: dark ? "#2c2c2a" : "#e1e0d9",
    baseline: dark ? "#383835" : "#c3c2b7",
    surface: colors.surface,
    text: colors.text,
    secondary: colors.textSecondary,
    good: colors.success,
    bad: colors.danger,
  };
}

/** A headline number with its change against the previous period. Up is good or bad depending on the measure. */
export function StatTile({ label, value, delta, upIsGood = true, width }: { label: string; value: string; delta?: { text: string; direction: "up" | "down" | "flat" }; upIsGood?: boolean; width?: number | `${number}%` }) {
  const c = useChartColors();
  const good = delta && delta.direction !== "flat" && (delta.direction === "up") === upIsGood;
  return (
    <View accessible accessibilityLabel={`${label}: ${value}${delta ? `, ${delta.text}` : ""}`} style={{ backgroundColor: c.surface, borderRadius: 12, padding: 14, gap: 4, width, minWidth: 140, flexGrow: 1 }}>
      <Text style={{ color: c.secondary, fontSize: 13 }}>{label}</Text>
      <Text style={{ color: c.text, fontSize: 26, fontWeight: "600" }}>{value}</Text>
      {delta ? (
        <Text style={{ color: delta.direction === "flat" ? c.secondary : good ? c.good : c.bad, fontSize: 13 }}>
          {`${delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "–"} ${delta.text}`}
        </Text>
      ) : null}
    </View>
  );
}

export interface BarRow {
  key: string;
  label: string;
  /** 0 to `max`. */
  value: number;
  valueLabel: string;
  detail?: string;
}

/**
 * Horizontal bars from one baseline: one row per item, value at the tip.
 * Pressing (or hovering on the web) a row shows its detail line.
 */
export function BarList({ rows, max, accessibilityLabel }: { rows: BarRow[]; max: number; accessibilityLabel: string }) {
  const c = useChartColors();
  const [active, setActive] = useState<string>();
  const [width, setWidth] = useState(0);
  const BAR = 14;
  const LABEL_W = 64;
  return (
    <View accessibilityLabel={accessibilityLabel} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)} style={{ gap: 10 }}>
      {rows.map((r) => {
        const track = Math.max(0, width - LABEL_W);
        const w = max > 0 ? Math.max(r.value > 0 ? 2 : 0, (r.value / max) * track) : 0;
        const on = active === r.key;
        return (
          <Pressable
            key={r.key}
            accessibilityRole="button"
            accessibilityLabel={`${r.label}: ${r.valueLabel}${r.detail ? `, ${r.detail}` : ""}`}
            onPress={() => setActive(on ? undefined : r.key)}
            onHoverIn={() => setActive(r.key)}
            onHoverOut={() => setActive((k) => (k === r.key ? undefined : k))}
            style={{ paddingVertical: 2 }}
          >
            <Text style={{ color: c.text, fontSize: 14, marginBottom: 4 }} numberOfLines={1}>
              {r.label}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", height: BAR + 4 }}>
              <Svg width={Math.max(w, 1)} height={BAR}>
                {w > 0 ? <Path d={roundedEnd(w, BAR, 4)} fill={c.series} opacity={active && !on ? 0.55 : 1} /> : null}
              </Svg>
              <Text style={{ color: c.secondary, fontSize: 13, marginLeft: 8 }}>{r.valueLabel}</Text>
            </View>
            {on && r.detail ? <Text style={{ color: c.secondary, fontSize: 12, marginTop: 2 }}>{r.detail}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** A bar square at the baseline (left) with a 4px rounded data end (right). */
function roundedEnd(w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  return `M0 0 H${w - rr} Q${w} 0 ${w} ${rr} V${h - rr} Q${w} ${h} ${w - rr} ${h} H0 Z`;
}

export interface LinePoint {
  key: string;
  label: string;
  value?: number;
  detail?: string;
}

const niceStep = (span: number) => {
  const raw = span / 4;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
};

/**
 * One series over time: a 2px line with gaps where there's no data, the
 * last value labeled, and a crosshair that snaps to the nearest point on
 * hover, drag or press, with its readout above the chart.
 */
export function LineChart({ points, format, height = 180, accessibilityLabel }: { points: LinePoint[]; format: (v: number) => string; height?: number; accessibilityLabel: string }) {
  const c = useChartColors();
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number>();
  const values = points.map((p) => p.value).filter((v): v is number => v !== undefined);
  const padL = 44;
  const padR = 12;
  const padT = 10;
  const padB = 22;
  const innerW = Math.max(1, width - padL - padR);
  const innerH = height - padT - padB;
  const lo0 = values.length ? Math.min(...values) : 0;
  const hi0 = values.length ? Math.max(...values) : 1;
  const step = niceStep(Math.max(hi0 - lo0, hi0 * 0.2, 0.01));
  const lo = Math.max(0, Math.floor((lo0 - step / 2) / step) * step);
  const hi = Math.ceil((hi0 + step / 2) / step) * step;
  const x = (i: number) => padL + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - ((v - lo) / (hi - lo || 1)) * innerH;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 1000; t += step) ticks.push(t);

  // Segments break where a week has no value.
  const segs: string[] = [];
  let cur = "";
  points.forEach((p, i) => {
    if (p.value === undefined) {
      if (cur) segs.push(cur);
      cur = "";
      return;
    }
    cur += `${cur ? "L" : "M"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)} `;
  });
  if (cur) segs.push(cur);
  const lastIdx = points.map((p) => p.value !== undefined).lastIndexOf(true);
  const shown = active ?? (lastIdx >= 0 ? lastIdx : undefined);
  const nearest = (px: number) => Math.max(0, Math.min(points.length - 1, Math.round(((px - padL) / innerW) * (points.length - 1))));
  const track = (px: number) => setActive(nearest(px));
  const readout = shown !== undefined ? points[shown] : undefined;
  const webHover = Platform.OS === "web" ? { onPointerMove: (e: { nativeEvent: { offsetX?: number; locationX?: number } }) => track(e.nativeEvent.offsetX ?? e.nativeEvent.locationX ?? 0), onPointerLeave: () => setActive(undefined) } : {};

  return (
    <View accessibilityLabel={accessibilityLabel}>
      <Text style={{ color: c.secondary, fontSize: 13, minHeight: 18 }}>
        {readout ? `${readout.label} · ` : ""}
        <Text style={{ color: c.text, fontWeight: "600" }}>{readout?.value !== undefined ? format(readout.value) : readout ? "No loads" : ""}</Text>
        {readout?.detail ? ` · ${readout.detail}` : ""}
      </Text>
      <View
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(e) => track(e.nativeEvent.locationX)}
        onResponderMove={(e) => track(e.nativeEvent.locationX)}
        style={{ height }}
        {...(webHover as object)}
      >
        {width > 0 ? (
          <Svg width={width} height={height} pointerEvents="none">
            {ticks.map((t) => (
              <Line key={t} x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke={t === lo ? c.baseline : c.grid} strokeWidth={1} />
            ))}
            {segs.map((d, i) => (
              <Path key={i} d={d} stroke={c.series} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {/* Lone weeks between gaps still show as dots. */}
            {points.map((p, i) => (p.value !== undefined && points[i - 1]?.value === undefined && points[i + 1]?.value === undefined ? <Circle key={p.key} cx={x(i)} cy={y(p.value)} r={3} fill={c.series} /> : null))}
            {shown !== undefined ? <Line x1={x(shown)} x2={x(shown)} y1={padT} y2={padT + innerH} stroke={c.baseline} strokeWidth={1} /> : null}
            {readout?.value !== undefined && shown !== undefined ? <Circle cx={x(shown)} cy={y(readout.value)} r={5} fill={c.series} stroke={c.surface} strokeWidth={2} /> : null}
          </Svg>
        ) : null}
        {width > 0
          ? ticks.map((t) => (
              <Text key={t} pointerEvents="none" style={{ position: "absolute", left: 0, width: padL - 6, textAlign: "right", top: y(t) - 8, fontSize: 11, color: c.secondary }}>
                {format(t)}
              </Text>
            ))
          : null}
        {width > 0 && points.length
          ? [0, points.length - 1].filter((i, n, a) => a.indexOf(i) === n).map((i) => (
              <Text key={i} pointerEvents="none" style={{ position: "absolute", top: height - padB + 6, left: Math.min(Math.max(x(i) - 40, 0), width - 80), width: 80, textAlign: i === 0 ? "left" : "right", fontSize: 11, color: c.secondary }}>
                {points[i]!.label}
              </Text>
            ))
          : null}
      </View>
    </View>
  );
}

/** A small table, for the lanes and as the table view of each chart. */
export function DataTable({ columns, rows }: { columns: Array<{ title: string; align?: "left" | "right"; flex?: number }>; rows: string[][] }) {
  const c = useChartColors();
  return (
    <View accessibilityRole="list">
      <View style={{ flexDirection: "row", paddingVertical: 6, borderBottomWidth: 1, borderColor: c.baseline }}>
        {columns.map((col) => (
          <Text key={col.title} style={{ flex: col.flex ?? 1, textAlign: col.align ?? "left", color: c.secondary, fontSize: 12, fontWeight: "600" }}>
            {col.title}
          </Text>
        ))}
      </View>
      {rows.map((r, i) => (
        <View key={i} style={{ flexDirection: "row", paddingVertical: 8, borderBottomWidth: 1, borderColor: c.grid }}>
          {r.map((cell, j) => (
            <Text key={j} style={{ flex: columns[j]?.flex ?? 1, textAlign: columns[j]?.align ?? "left", color: c.text, fontSize: 13, fontVariant: columns[j]?.align === "right" ? ["tabular-nums"] : undefined }}>
              {cell}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

export function ChartCard({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  const c = useChartColors();
  return (
    <View style={{ backgroundColor: c.surface, borderRadius: 12, padding: 16, gap: 10 }}>
      <View>
        <Text accessibilityRole="header" style={{ color: c.text, fontSize: 16, fontWeight: "600" }}>
          {title}
        </Text>
        {subtitle ? <Text style={{ color: c.secondary, fontSize: 13 }}>{subtitle}</Text> : null}
      </View>
      {children}
      {footer}
    </View>
  );
}

