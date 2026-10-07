#!/bin/sh
# Signs the built app with this server's own key: the APK goes to /downloads
# for the download page, the app bundle to /play for Google Play (where this
# key is the upload key). The key is made on the first build and kept in
# /keys. Every later build must use the same key, or phones have to uninstall
# the app before updating and Google Play refuses the upload.
set -eu
: "${KEY_PASSWORD:?KEY_PASSWORD is required}"
KS=/keys/release.keystore
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storetype PKCS12 -alias logisticspro -keyalg RSA -keysize 4096 \
    -validity 10000 -storepass "$KEY_PASSWORD" -dname "CN=Logistics Pro" >/dev/null 2>&1
  echo "Made a new signing key in deploy/android-keys. Back it up with deploy/.env."
fi
# Gradle signs release builds with a throwaway debug key; drop that signature first.
unsign() { zip -q -d "$1" 'META-INF/*.SF' 'META-INF/*.RSA' 'META-INF/*.DSA' 'META-INF/*.EC' 'META-INF/MANIFEST.MF' >/dev/null 2>&1 || true; }

unsign /out/built.apk
apksigner sign --v4-signing-enabled false --ks "$KS" --ks-key-alias logisticspro --ks-pass env:KEY_PASSWORD --out /downloads/logistics-pro.apk.new /out/built.apk
apksigner verify /downloads/logistics-pro.apk.new
mv /downloads/logistics-pro.apk.new /downloads/logistics-pro.apk
printf '{"version":"%s (%s)","builtAt":"%s","bundleId":"com.logisticspro.app"}\n' \
  "$(cat /out/version)" "${ANDROID_VERSION_CODE:-1}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /downloads/build.json

if [ -d /play ]; then
  unsign /out/built.aab
  jarsigner -keystore "$KS" -storepass "$KEY_PASSWORD" -sigalg SHA256withRSA -digestalg SHA-256 \
    -signedjar /play/logistics-pro.aab.new /out/built.aab logisticspro >/dev/null
  jarsigner -verify /play/logistics-pro.aab.new >/dev/null
  mv /play/logistics-pro.aab.new /play/logistics-pro.aab
  # Google Play asks for the upload key's certificate when the app is set up.
  keytool -exportcert -rfc -keystore "$KS" -storepass "$KEY_PASSWORD" -alias logisticspro > /play/upload-certificate.pem
fi
