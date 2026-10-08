#!/usr/bin/env bash
# Pulls the latest code for this copy's branch, backs up its database,
# rebuilds and restarts it, and checks it answers. Run it in either copy:
#
#   ~/LogisticsPro/deploy/update.sh         # production (main)
#   ~/LogisticsPro-test/deploy/update.sh    # test site (test)
#
#   --android     also rebuild the Android app for this copy's download page
#   --no-backup   skip the database backup (it is quick; keep it on for production)
set -euo pipefail
cd "$(dirname "$0")"
ANDROID=false
BACKUP=true
for arg in "$@"; do
  case "$arg" in
    --android) ANDROID=true ;;
    --no-backup) BACKUP=false ;;
    *) echo "usage: deploy/update.sh [--android] [--no-backup]" >&2; exit 2 ;;
  esac
done
[ -f .env ] || { echo "No deploy/.env here. Run deploy/setup.sh first (see docs/DEPLOYMENT.md)." >&2; exit 1; }
set -a; . ./.env; set +a

branch=$(git rev-parse --abbrev-ref HEAD)
echo "== ${LP_PUBLIC_URL:-this copy} (branch $branch)"

# 1. The latest code. Only fast-forwards: local edits on the server stop it here.
before=$(git rev-parse HEAD)
if ! git pull --ff-only --quiet; then
  echo "git pull failed. Local changes on the server? See: git status" >&2
  exit 1
fi
after=$(git rev-parse HEAD)
if [ "$before" = "$after" ]; then
  echo "Code is already up to date ($(git log -1 --format='%h %s'))."
else
  echo "New since last update:"
  git log --format='  %h %s' "$before..$after"
fi

# 2. A backup first, so a bad update can be undone (deploy/backup.sh explains restoring).
if $BACKUP && [ -n "$(docker compose ps --status running --quiet db 2>/dev/null)" ]; then
  ./backup.sh
fi

# 3. Rebuild and restart. Data stays in Docker volumes.
docker compose up -d --build

# 4. Wait until it answers.
port=${LP_HOST_PORT:-8080}
printf "Waiting for the app on port %s" "$port"
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    echo " ok."
    if $ANDROID; then ./build-android.sh; fi
    echo "Updated: ${LP_PUBLIC_URL:-http://127.0.0.1:$port}"
    exit 0
  fi
  printf "."
  sleep 2
done
echo
echo "The app didn't answer within 3 minutes. Its log:" >&2
docker compose logs --tail 40 api >&2
exit 1
