#!/usr/bin/env bash
# Sends the latest Android build to Google Play's internal testing track, so
# the testers you invited get it from the Play Store.
#
#   deploy/build-android.sh     # build first
#   deploy/publish-play.sh "What changed in this build"
#
# Needs a Google Play service account key at deploy/play-service-account.json
# (or LP_PLAY_SERVICE_ACCOUNT in deploy/.env). See docs/DEPLOYMENT.md,
# "Google Play private beta". The very first build has to be uploaded by hand
# in Play Console; this script handles every one after that.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
KEY=${LP_PLAY_SERVICE_ACCOUNT:-play-service-account.json}
[ -f "$KEY" ] || { echo "No service account key at deploy/$KEY. See docs/DEPLOYMENT.md, Google Play private beta."; exit 1; }
[ -f play/logistics-pro.aab ] || { echo "No app bundle yet. Run deploy/build-android.sh first."; exit 1; }
KEY_PATH=$(cd "$(dirname "$KEY")" && pwd)/$(basename "$KEY")
docker run --rm -v "$KEY_PATH:/run/play-key.json:ro" -v "$PWD/play:/play:ro" logisticspro-android \
  npx tsx apps/api/src/tools/play-upload.ts --key /run/play-key.json --bundle /play/logistics-pro.aab \
  --track "${LP_PLAY_TRACK:-internal}" ${1:+--notes "$1"}
