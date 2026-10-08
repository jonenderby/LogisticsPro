#!/usr/bin/env bash
# First-time setup on your server. Writes deploy/.env with fresh secrets.
#
#   deploy/setup.sh lp.example.com you@example.com
#   deploy/setup.sh jonnysserver.com/logistics you@example.com --nginx
#   deploy/setup.sh jonnysserver.com/logistics-test you@example.com --nginx --port 8091
#
# The address is where people will open Logistics Pro. It can have a path
# when the domain is shared with another site. Its domain must point at this
# server. The email is who sees More > Setup status in the app.
#
# --nginx   another web server (nginx, Pterodactyl's panel) already has ports
#           80 and 443. Caddy stays off, the app listens on 127.0.0.1:8090,
#           and this writes deploy/nginx-logistics.conf to add to that server.
# --port N  listen on 127.0.0.1:N instead, e.g. for a test copy next to
#           production (each copy is its own clone, with its own database).
#
# To change the address later, edit LP_PUBLIC_URL in deploy/.env, then run
# `docker compose up -d --build` and deploy/build-android.sh.
set -euo pipefail
cd "$(dirname "$0")"
usage="usage: deploy/setup.sh <address> <your email> [--nginx] [--port N]"
ADDRESS=${1:?$usage}
EMAIL=${2:?$usage}
shift 2
NGINX=false
PORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --nginx) NGINX=true ;;
    --port) PORT=${2:?$usage}; shift ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
  shift
done

# "jonnysserver.com/logistics/" -> https://jonnysserver.com/logistics
ADDRESS=${ADDRESS#http://}
ADDRESS=${ADDRESS#https://}
ADDRESS=${ADDRESS%/}
DOMAIN=${ADDRESS%%/*}
BASE_PATH=${ADDRESS#"$DOMAIN"}
PUBLIC_URL="https://$ADDRESS"
if $NGINX; then PROFILES=""; else PROFILES=caddy; fi
PORT=${PORT:-$($NGINX && echo 8090 || echo 8080)}
# Docker names this copy's containers and data after it, so copies never mix.
SLUG=$(printf '%s' "${BASE_PATH:-$DOMAIN}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' '-' | sed 's/^-*//; s/-*$//')
PROJECT="lp-${SLUG:-site}"

if [ -f .env ]; then
  echo "deploy/.env already exists, so nothing was changed. Its secrets keep everyone signed in and unlock the database."
  echo "To change the address, edit LP_PUBLIC_URL in deploy/.env."
  exit 0
fi
rand() { openssl rand -hex "$1"; }
umask 077
cat > .env <<ENV
# Logistics Pro settings for this server. Keep a copy somewhere safe:
# without these secrets, sessions, stored ELD keys and the database can't be read.

# Where people open Logistics Pro. Everything follows this one address.
LP_PUBLIC_URL=$PUBLIC_URL
LP_DOMAIN=$DOMAIN
# caddy: Caddy serves HTTPS on ports 80 and 443. Empty: your own web server does.
COMPOSE_PROFILES=$PROFILES
# The port the app listens on, on this machine only.
LP_HOST_PORT=$PORT
# Docker's name for this copy's containers and data. Never change it once
# running: a new name starts with an empty database.
COMPOSE_PROJECT_NAME=$PROJECT

LP_ADMIN_EMAILS=$EMAIL
# Your company's legal name, shown on the privacy policy at /privacy.
LP_OPERATOR_NAME="Logistics Pro"
LP_JWT_SECRET=$(rand 32)
LP_DATA_KEY=$(rand 32)
DB_PASSWORD=$(rand 16)
NOMINATIM_PASSWORD=$(rand 16)
LP_ANDROID_KEY_PASSWORD=$(rand 16)
# Phone push goes through Expo's service, so it is off while everything runs here.
LP_PUSH=off
ENV
echo "Wrote deploy/.env for $PUBLIC_URL."

if $NGINX; then
  umask 022
  if [ -n "$BASE_PATH" ]; then
    cat > nginx-logistics.conf <<CONF
# Logistics Pro at $PUBLIC_URL
# Paste these lines inside the "server { ... }" block for $DOMAIN, for example
# /etc/nginx/sites-available/logistics.conf (see docs/DEPLOYMENT.md if $DOMAIN
# has no server block yet), then run: sudo nginx -t && sudo systemctl reload nginx
location = $BASE_PATH { return 301 $BASE_PATH/; }
# ^~ keeps the panel's own rules (such as its PHP handler) away from these addresses.
location ^~ $BASE_PATH/ {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    client_max_body_size 25m;
    proxy_read_timeout 120s;
}
CONF
  else
    cat > nginx-logistics.conf <<CONF
# Logistics Pro at $PUBLIC_URL
# Put this "location /" block in a server block of its own for $DOMAIN, with
# its HTTPS certificate (for example from: sudo certbot --nginx -d $DOMAIN),
# then run: sudo nginx -t && sudo systemctl reload nginx
location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    client_max_body_size 25m;
    proxy_read_timeout 120s;
}
CONF
  fi
  echo "Wrote deploy/nginx-logistics.conf. Add it to nginx as it says at the top."
fi
echo "Next:"
echo "  cd deploy && docker compose up -d --build"
echo "  deploy/build-android.sh"
