import { useEffect, useRef } from "react";
import MapView, { Marker } from "react-native-maps";
import type { FleetMapProps } from "./FleetMap.types";

/** iOS and Android: Apple Maps / Google Maps with one pin per truck. */
export function FleetMap({ markers, height, dark, onSelect }: FleetMapProps) {
  const map = useRef<MapView>(null);
  useEffect(() => {
    if (markers.length) map.current?.fitToCoordinates(markers.map((m) => ({ latitude: m.geo.lat, longitude: m.geo.lng })), { edgePadding: { top: 48, right: 48, bottom: 48, left: 48 }, animated: true });
  }, [markers]);
  return (
    <MapView ref={map} style={{ height }} userInterfaceStyle={dark ? "dark" : "light"} accessibilityLabel={`Map with ${markers.length} trucks`}>
      {markers.map((m) => (
        <Marker key={m.id} coordinate={{ latitude: m.geo.lat, longitude: m.geo.lng }} pinColor={m.color} title={m.title} description={m.subtitle} onCalloutPress={() => onSelect?.(m.id)} />
      ))}
    </MapView>
  );
}
