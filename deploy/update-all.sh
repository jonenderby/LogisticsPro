#!/usr/bin/env bash
# Updates every copy of Logistics Pro on this server, test first, so a
# broken build shows up on the test site before production.
#
#   deploy/update-all.sh [--android] [--no-backup]
#
# Copies are found next to this one: folders named LogisticsPro* that have
# a deploy/.env. Set LP_COPIES to list them yourself, e.g.
#   LP_COPIES="/root/LogisticsPro-test /root/LogisticsPro" deploy/update-all.sh
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
if [ -n "${LP_COPIES:-}" ]; then
  read -r -a copies <<<"$LP_COPIES"
else
  copies=()
  last=()
  # Test copies (on any branch but main) first, then production.
  for d in "$(dirname "$here")"/LogisticsPro*; do
    [ -f "$d/deploy/.env" ] || continue
    if [ "$(git -C "$d" rev-parse --abbrev-ref HEAD)" = "main" ]; then last+=("$d"); else copies+=("$d"); fi
  done
  copies+=(${last[@]+"${last[@]}"})
fi
[ ${#copies[@]} -gt 0 ] || { echo "No copies found next to $here." >&2; exit 1; }
for d in "${copies[@]}"; do
  "$d/deploy/update.sh" "$@"
  echo
done
