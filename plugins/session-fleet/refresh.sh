#!/usr/bin/env bash
# Rebuild the Session Fleet snapshot: rescan sessions, re-render both pages.
#
#   ./refresh.sh              last 7 days
#   ./refresh.sh 14           last 14 days
#   ./refresh.sh 7 --include-archived
#
# For an always-on view use ./serve.py instead — it does this on every page load.
#
# Purpose/next-steps are NOT regenerated here; that needs a model. A summary is
# stale once the session's last-activity time OR its turn count has moved, and
# both the page and this script flag it.

set -euo pipefail
cd "$(dirname "$0")"

DAYS="${1:-7}"
shift || true

python3 collect.py --days "$DAYS" "$@"
python3 render.py                                  # fleetview.html — artifact build
python3 render.py --local --out local.html         # local.html    — with controls

python3 linear.py | head -1

echo
echo "Stale or missing summaries:"
python3 stale.py
