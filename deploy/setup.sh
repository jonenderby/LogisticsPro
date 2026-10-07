#!/usr/bin/env bash
# First-time setup on your server. Writes deploy/.env with fresh secrets.
#
#   deploy/setup.sh lp.example.com you@example.com
#
# The domain must point at this server for HTTPS to work. The email is who
# sees More > Setup status in the app.
set -euo pipefail
cd "$(dirname "$0")"
usage="usage: deploy/setup.sh <domain> <your email>"
DOMAIN=${1:?$usage}
EMAIL=${2:?$usage}
if [ -f .env ]; then
  echo "deploy/.env already exists, so nothing was changed. Its secrets keep everyone signed in and unlock the database."
  exit 0
fi
rand() { openssl rand -hex "$1"; }
umask 077
cat > .env <<ENV
# Logistics Pro settings for this server. Keep a copy somewhere safe:
# without these secrets, sessions, stored ELD keys and the database can't be read.
LP_DOMAIN=$DOMAIN
LP_PUBLIC_URL=https://$DOMAIN
LP_ADMIN_EMAILS=$EMAIL
LP_JWT_SECRET=$(rand 32)
LP_DATA_KEY=$(rand 32)
DB_PASSWORD=$(rand 16)
NOMINATIM_PASSWORD=$(rand 16)
LP_ANDROID_KEY_PASSWORD=$(rand 16)
# Phone push goes through Expo's service, so it is off while everything runs here.
LP_PUSH=off
ENV
echo "Wrote deploy/.env."
echo "Next:"
echo "  cd deploy && docker compose up -d --build"
echo "  deploy/build-android.sh"
