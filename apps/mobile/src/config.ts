/** Point the app at your API, e.g. EXPO_PUBLIC_API_URL=https://api.example.com */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
