export interface MapMarker {
  id: string;
  geo: { lat: number; lng: number };
  color: string;
  title: string;
  subtitle?: string;
}

export interface FleetMapProps {
  markers: MapMarker[];
  height: number;
  dark: boolean;
  onSelect?: (id: string) => void;
}

/** Tile source for the web map. OpenStreetMap's own tiles are for light use only; set a provider for production. */
export const TILE_URL = process.env.EXPO_PUBLIC_MAP_TILE_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const TILE_ATTRIBUTION = process.env.EXPO_PUBLIC_MAP_ATTRIBUTION ?? "&copy; OpenStreetMap contributors";
