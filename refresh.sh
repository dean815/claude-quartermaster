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
python3 - <<'PY'
import json, pathlib
data = json.loads(pathlib.Path("data.json").read_text())
entries = json.loads(pathlib.Path("summaries.json").read_text()).get("entries", {})
stale = []
for s in data["sessions"]:
    # Same dual lookup render.py uses: importing a CLI session into the Desktop
    # app renames it local_<cliSessionId>, and the summary still belongs to it.
    e = entries.get(s.get("cli_session_id") or "") or entries.get(s["id"])
    if not e:
        stale.append(("new", s))
    elif e.get("stamp") != s["last_activity_at"]:
        stale.append(("newer activity", s))
    elif e.get("turns") != s["turns"]:
        stale.append(("more turns", s))
if not stale:
    print("  none — every summary is current")
for why, s in stale:
    print(f"  [{why}] {s['id']}  {s['title'][:58]}")
print(f"\n  {len(stale)} stale · rough cost to rewrite: ~{len(stale)*1.5:.1f}k tokens")
PY
