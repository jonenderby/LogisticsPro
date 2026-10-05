import "leaflet/dist/leaflet.css";
import { useEffect } from "react";
import { CircleMarker, MapContainer, TileLayer, Tooltip, useMap } from "react-leaflet";
import { View } from "react-native";
import { type FleetMapProps, TILE_ATTRIBUTION, TILE_URL } from "./FleetMap.types";

function FitBounds({ markers }: Pick<FleetMapProps, "markers">) {
  const map = useMap();
  useEffect(() => {
    // Extra room at the top keeps the labels above each dot inside the map.
    if (markers.length === 1) map.setView([markers[0]!.geo.lat, markers[0]!.geo.lng], 9);
    else if (markers.length > 1) map.fitBounds(markers.map((m) => [m.geo.lat, m.geo.lng] as [number, number]), { paddingTopLeft: [40, 70], paddingBottomRight: [40, 30], maxZoom: 10 });
  }, [map, markers]);
  return null;
}

/** Website: Leaflet map with one colored dot per truck. */
export function FleetMap({ markers, height, dark, onSelect }: FleetMapProps) {
  return (
    <View style={{ height, overflow: "hidden" }} accessibilityLabel={`Map with ${markers.length} trucks`}>
      <MapContainer center={[39.5, -96]} zoom={4} style={{ height: "100%", width: "100%", background: dark ? "#1d2024" : "#e5e7eb" }} scrollWheelZoom={false}>
        <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
        <FitBounds markers={markers} />
        {markers.map((m) => (
          <CircleMarker key={m.id} center={[m.geo.lat, m.geo.lng]} radius={9} pathOptions={{ color: "#ffffff", weight: 2, fillColor: m.color, fillOpacity: 1 }} eventHandlers={{ click: () => onSelect?.(m.id) }}>
            <Tooltip direction="top" offset={[0, -8]} permanent={markers.length <= 12}>
              <strong>{m.title}</strong>
              {m.subtitle ? <><br />{m.subtitle}</> : null}
            </Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>
    </View>
  );
}
