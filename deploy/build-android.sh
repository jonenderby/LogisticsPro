#!/usr/bin/env bash
# Builds the Android app on this server and offers it at <your address>/download.
# Also writes deploy/play/logistics-pro.aab for Google Play (deploy/publish-play.sh).
#
#   deploy/build-android.sh
#
# Needs only Docker. Reads LP_PUBLIC_URL and LP_ANDROID_KEY_PASSWORD from
# deploy/.env, which deploy/setup.sh writes. The first build downloads the
# Android tools (a few GB) and takes 20 to 40 minutes; later builds are faster.
# Run it again after updating the code, and phones install the new version
# over the old one.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${LP_PUBLIC_URL:?Set LP_PUBLIC_URL in deploy/.env (run deploy/setup.sh first)}"
: "${LP_ANDROID_KEY_PASSWORD:?Set LP_ANDROID_KEY_PASSWORD in deploy/.env (run deploy/setup.sh first)}"
mkdir -p downloads android-keys play
chmod 700 android-keys

# The build number goes up by one every minute, so each build installs over the last.
VERSION_CODE=$(( $(date +%s) / 60 ))
DOCKER_BUILDKIT=1 docker build -f android/Dockerfile \
  --build-arg EXPO_PUBLIC_API_URL="$LP_PUBLIC_URL" \
  --build-arg ANDROID_VERSION_CODE="$VERSION_CODE" \
  --build-arg ABIS="${LP_ANDROID_ABIS:-arm64-v8a,armeabi-v7a}" \
  -t logisticspro-android ..
docker run --rm -e KEY_PASSWORD="$LP_ANDROID_KEY_PASSWORD" -e ANDROID_VERSION_CODE="$VERSION_CODE" \
  -v "$PWD/android-keys:/keys" -v "$PWD/downloads:/downloads" -v "$PWD/play:/play" logisticspro-android
echo "Built. Phones can install it from $LP_PUBLIC_URL/download"
