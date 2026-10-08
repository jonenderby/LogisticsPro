import { Platform } from "react-native";

/**
 * Where the API lives. Set EXPO_PUBLIC_API_URL for the phone apps. The
 * website is served by the API itself, so on web it defaults to the page's
 * own origin.
 */
const fromEnv = process.env.EXPO_PUBLIC_API_URL;

/**
 * The path the website is served under when it shares a domain, e.g.
 * "/logistics" for https://example.com/logistics. Set EXPO_PUBLIC_BASE_PATH
 * when building the website; "" at the root.
 */
export const BASE_PATH = (process.env.EXPO_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "").replace(/^(?=[^/])/, "/");

const webOrigin = Platform.OS === "web" && typeof window !== "undefined" ? `${window.location.origin}${BASE_PATH}` : undefined;

export const API_URL = (fromEnv ?? webOrigin ?? "http://localhost:8080").replace(/\/$/, "");
export const IS_WEB = Platform.OS === "web";
