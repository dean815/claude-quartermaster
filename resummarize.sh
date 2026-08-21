#!/usr/bin/env bash
# Rewrite every stale purpose / next-steps summary, headless.
#
#   ./resummarize.sh
#
# Runs the /session-fleet refresh skill in a non-interactive Claude, which
# rescans, reads the excerpts for the stale ids, writes the bullets into
# author_summaries.py and republishes both pages.
#
# This is the one part of Session Fleet that puts a model to work — roughly 15
# seconds a session. Auth is an OAuth subscription, so it spends rate-limit
# headroom rather than money. Everything else here is free either way.
#
# Exits non-zero and prints the reason if the run fails, so the menu bar can
# tell you rather than silently doing nothing.

set -euo pipefail
cd "$(dirname "$0")"

# launchd hands the menu bar agent a bare PATH with no ~/.local/bin, so the
# usual `claude` lookup finds nothing when this is run from the menu.
CLAUDE="$(command -v claude || true)"
[ -x "$CLAUDE" ] || CLAUDE="$HOME/.local/bin/claude"
if [ ! -x "$CLAUDE" ]; then
  echo "claude CLI not found (looked on PATH and in ~/.local/bin)" >&2
  exit 127
fi

if [ "$(python3 stale.py | tail -1)" = "none — every summary is current" ]; then
  echo "nothing stale"
  exit 0
fi

# acceptEdits plus an explicit allowlist: headless runs auto-deny anything that
# would otherwise prompt, and the skill needs to edit author_summaries.py and
# shell out to refresh.sh.
"$CLAUDE" -p "/session-fleet refresh" \
  --permission-mode acceptEdits \
  --allowed-tools "Bash Read Edit Write Glob Grep"
