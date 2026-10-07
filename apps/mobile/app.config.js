/**
 * Build-time settings from the environment, on top of app.json. Set them as
 * EAS environment variables (or in a local .env) before building:
 *
 *   EAS_PROJECT_ID               the EAS project, needed for push notifications
 *   EXPO_OWNER                   the Expo account or organization that owns the project
 *   GOOGLE_MAPS_ANDROID_API_KEY  Google Maps for the Android maps
 *   EXPO_PUBLIC_API_URL          where the phone apps reach the API
 *   ANDROID_VERSION_CODE         build number for Android, higher on each build (deploy/build-android.sh sets it)
 */
module.exports = ({ config }) => {
  const projectId = process.env.EAS_PROJECT_ID;
  const mapsKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY;
  const versionCode = Number(process.env.ANDROID_VERSION_CODE) || undefined;
  const plugins = (config.plugins ?? []).map((p) => {
    const name = Array.isArray(p) ? p[0] : p;
    return name === "react-native-maps" && mapsKey ? [name, { ...(Array.isArray(p) ? p[1] : {}), androidGoogleMapsApiKey: mapsKey }] : p;
  });
  return {
    ...config,
    ...(process.env.EXPO_OWNER ? { owner: process.env.EXPO_OWNER } : {}),
    plugins,
    ...(versionCode ? { android: { ...config.android, versionCode } } : {}),
    extra: { ...config.extra, ...(projectId ? { eas: { projectId } } : {}) },
  };
};
