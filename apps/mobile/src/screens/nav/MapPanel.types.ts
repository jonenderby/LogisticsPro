export interface MapPanelProps {
  line: Array<{ lat: number; lng: number }>;
  mode: "STANDARD" | "OVERSIZE";
  position?: { lat: number; lng: number; heading?: number };
  target?: { lat: number; lng: number };
  dark: boolean;
}
