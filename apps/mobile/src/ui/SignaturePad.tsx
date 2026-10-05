import { useMemo, useRef, useState } from "react";
import { type LayoutChangeEvent, PanResponder, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useTheme } from "./theme";

export interface Signature {
  width: number;
  height: number;
  strokes: Array<Array<[number, number]>>;
}

const toPath = (s: Array<[number, number]>) => s.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

/**
 * A box to sign in with a finger, a stylus or a mouse. Strokes are kept as
 * points; the server draws the receipt from them.
 */
export function SignaturePad({ value, onChange, height = 180 }: { value: Signature; onChange: (s: Signature) => void; height?: number }) {
  const { colors } = useTheme();
  const [size, setSize] = useState({ width: 0, height });
  const live = useRef<Array<[number, number]> | null>(null);
  const latest = useRef(value);
  latest.current = value;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const [, redraw] = useState(0);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          live.current = [[e.nativeEvent.locationX, e.nativeEvent.locationY]];
          redraw((n) => n + 1);
        },
        onPanResponderMove: (e) => {
          live.current?.push([e.nativeEvent.locationX, e.nativeEvent.locationY]);
          redraw((n) => n + 1);
        },
        onPanResponderRelease: () => {
          const stroke = live.current;
          live.current = null;
          if (stroke?.length) onChange({ width: sizeRef.current.width, height: sizeRef.current.height, strokes: [...latest.current.strokes, stroke] });
        },
      }),
    [onChange],
  );

  return (
    <View
      accessibilityLabel="Signature box"
      accessibilityHint="Sign here with your finger"
      onLayout={(e: LayoutChangeEvent) => setSize({ width: e.nativeEvent.layout.width, height })}
      style={{ height, borderRadius: 12, borderWidth: 1, borderColor: colors.separator, backgroundColor: "#fff", overflow: "hidden" }}
      {...responder.panHandlers}
    >
      <Svg width="100%" height={height} pointerEvents="none">
        {value.strokes.map((s, i) => (
          <Path key={i} d={toPath(s)} stroke="#0b2a6b" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {live.current ? <Path d={toPath(live.current)} stroke="#0b2a6b" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" /> : null}
      </Svg>
      <View pointerEvents="none" style={{ position: "absolute", left: 16, right: 16, bottom: 36, borderBottomWidth: 1, borderColor: "#c8ccd4" }} />
    </View>
  );
}
