#!/usr/bin/env bash
# Backs up everything Logistics Pro stores on this server into deploy/backups:
# the database (loads, accounts, documents), the AS2 certificate, the Android
# signing key and deploy/.env. Copy the folder off the server too.
#
#   deploy/backup.sh
#
# Run it every night from cron, for example:
#   15 3 * * * /path/to/LogisticsPro/deploy/backup.sh >> /var/log/lp-backup.log 2>&1
#
# Restore the database with:
#   docker compose exec -T db pg_restore -U logisticspro -d logisticspro --clean --if-exists < backups/lp-<time>.dump
set -euo pipefail
cd "$(dirname "$0")"
umask 077
mkdir -p backups
stamp=$(date -u +%Y%m%d-%H%M%S)
docker compose exec -T db pg_dump -U logisticspro -Fc logisticspro > "backups/lp-$stamp.dump"
docker compose cp api:/data/as2 "backups/as2-$stamp" >/dev/null
tar -czf "backups/keys-$stamp.tgz" .env $( [ -d android-keys ] && echo android-keys ) "backups/as2-$stamp"
rm -rf "backups/as2-$stamp"
# Keep two weeks.
find backups -name 'lp-*.dump' -mtime +"${KEEP_DAYS:-14}" -delete
find backups -name 'keys-*.tgz' -mtime +"${KEEP_DAYS:-14}" -delete
echo "Backed up to deploy/backups/lp-$stamp.dump and keys-$stamp.tgz"
