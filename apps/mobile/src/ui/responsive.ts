import { useWindowDimensions } from "react-native";

/** Desktop browsers and tablets in landscape get the wide layout: sidebar, tables, multi-column. */
export const WIDE_BREAKPOINT = 900;
export const CONTENT_MAX_WIDTH = 1120;

export function useLayout() {
  const { width } = useWindowDimensions();
  return { wide: width >= WIDE_BREAKPOINT, width };
}
