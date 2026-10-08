#!/usr/bin/env bash
# Releases what is on the test branch to production: opens a pull request
# from test to main on GitHub, waits for CI to pass, merges it, then
# updates this production copy. Run it in the production clone:
#
#   ~/LogisticsPro/deploy/promote.sh
#
#   --yes        don't ask before merging
#   --no-update  merge only; update production later with deploy/update.sh
#
# Needs the GitHub CLI signed in to an account that can merge into main,
# once per server: sudo apt install gh && gh auth login
# (Use sudo for both or neither, the same way you run these scripts.)
set -euo pipefail
cd "$(dirname "$0")"
YES=false
UPDATE=true
for arg in "$@"; do
  case "$arg" in
    --yes) YES=true ;;
    --no-update) UPDATE=false ;;
    *) echo "usage: deploy/promote.sh [--yes] [--no-update]" >&2; exit 2 ;;
  esac
done

repo_url=$(git remote get-url origin)
repo=$(printf '%s' "$repo_url" | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##')
if [ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]; then
  echo "Run this in the production copy (the clone on the main branch), e.g. ~/LogisticsPro/deploy/promote.sh" >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "The GitHub CLI isn't installed. Install it with: sudo apt install gh, then: gh auth login" >&2
  echo "Or release by hand: https://github.com/$repo/compare/main...test" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "Sign the GitHub CLI in first: gh auth login" >&2
  exit 1
fi

# What test has that production doesn't.
ahead=$(gh api "repos/$repo/compare/main...test" --jq .ahead_by)
if [ "$ahead" = "0" ]; then
  echo "Production already has everything on test. Nothing to release."
  exit 0
fi
echo "On test, not yet in production:"
gh api "repos/$repo/compare/main...test" --jq '.commits[] | "  " + .sha[0:7] + " " + (.commit.message | split("\n")[0])' | grep -v " Merge " || true
if ! $YES; then
  read -r -p "Release these to production? [y/N] " answer
  case "$answer" in y|Y|yes|Yes) ;; *) echo "Nothing released."; exit 0 ;; esac
fi

# One pull request from test to main; reuse it if one is already open.
pr=$(gh pr list --repo "$repo" --base main --head test --state open --json number --jq '.[0].number // empty')
if [ -z "$pr" ]; then
  gh pr create --repo "$repo" --base main --head test \
    --title "Release to production $(date +%Y-%m-%d)" \
    --body "Everything on test that production doesn't have yet. Opened by deploy/promote.sh." >/dev/null
  pr=$(gh pr list --repo "$repo" --base main --head test --state open --json number --jq '.[0].number')
fi
echo "Pull request #$pr: https://github.com/$repo/pull/$pr"

# Wait for CI. Checks take a moment to appear on a new pull request.
echo "Waiting for CI (about 15 minutes)..."
for _ in $(seq 1 30); do
  case "$(gh pr checks "$pr" --repo "$repo" 2>&1 || true)" in
    *"no checks reported"*) sleep 10 ;;
    *) break ;;
  esac
done
if ! gh pr checks "$pr" --repo "$repo" --watch --interval 30; then
  echo "CI failed, so nothing was merged. Details: https://github.com/$repo/pull/$pr/checks" >&2
  exit 1
fi

gh pr merge "$pr" --repo "$repo" --merge
echo "Merged test into main."
if $UPDATE; then ./update.sh; fi
