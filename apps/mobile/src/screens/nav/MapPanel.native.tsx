import { useEffect, useRef } from "react";
import MapView, { Marker, Polyline } from "react-native-maps";
import { useT } from "../../state/MeProvider";
import type { MapPanelProps } from "./MapPanel.types";

const ll = (p: { lat: number; lng: number }) => ({ latitude: p.lat, longitude: p.lng });

export function MapPanel({ line, mode, position, target, dark }: MapPanelProps) {
  const map = useRef<MapView>(null);
  const t = useT();
  useEffect(() => {
    if (position) map.current?.animateCamera({ center: ll(position), heading: position.heading ?? 0, pitch: 45, zoom: 16 }, { duration: 600 });
  }, [position]);
  const first = line[0];
  return (
    <MapView
      ref={map}
      style={{ flex: 1 }}
      showsUserLocation
      showsTraffic={mode === "STANDARD"}
      showsCompass
      userInterfaceStyle={dark ? "dark" : "light"}
      initialRegion={first ? { ...ll(first), latitudeDelta: 0.5, longitudeDelta: 0.5 } : undefined}
      accessibilityLabel={t(mode === "OVERSIZE" ? "Map with the permitted oversize route" : "Map with your route")}
    >
      {line.length > 1 ? <Polyline coordinates={line.map(ll)} strokeWidth={mode === "OVERSIZE" ? 12 : 6} strokeColor={mode === "OVERSIZE" ? "rgba(230,120,0,0.85)" : "#1D5FD1"} /> : null}
      {target ? <Marker coordinate={ll(target)} title={t("Rejoin the permitted route here")} pinColor="orange" /> : null}
    </MapView>
  );
}
