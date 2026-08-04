#!/usr/bin/env bash
#
# Install the weekly live-oracle check as a launchd agent (DEA-118).
#
# Run this yourself. `qm` never does: loading a launchd agent is a write to the live
# environment, and this tool's promise is that it makes none. Everything the installer
# touches is listed before it touches it, and `--uninstall` reverses all of it.
#
# Usage:
#   scripts/install-oracle-schedule.sh <LINEAR_TEAM_KEY> [path/to/token-file]
#   scripts/install-oracle-schedule.sh --uninstall
#
set -euo pipefail

LABEL="com.dean.quartermaster.oracle"
AGENTS="$HOME/Library/LaunchAgents"
TARGET="$AGENTS/$LABEL.plist"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/claude-quartermaster"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$TARGET"
  echo "removed $TARGET"
  echo "left in place: $STATE (the run record and logs — delete them yourself if you want them gone)"
  exit 0
fi

TEAM="${1:-}"
TOKEN_FILE="${2:-$HOME/.config/claude-quartermaster/linear-token}"

if [[ -z "$TEAM" ]]; then
  echo "usage: $0 <LINEAR_TEAM_KEY> [path/to/token-file]" >&2
  echo "       the team key is the prefix on your issue ids, e.g. DEA" >&2
  exit 2
fi

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "error: no node on PATH. launchd does not read your shell profile, so the plist" >&2
  echo "       needs an absolute path and there is nothing to write." >&2
  exit 1
fi

# The token is read at run time from a file the user owns, never from the plist: agent
# plists are mode 644 and an API key written into one is readable by everything.
if [[ ! -r "$TOKEN_FILE" ]]; then
  echo "warning: $TOKEN_FILE is not readable." >&2
  echo "         The job will run and detect divergence, but --file-issue will stop with" >&2
  echo "         an error instead of filing. Create it with:" >&2
  echo "           mkdir -p \"$(dirname "$TOKEN_FILE")\"" >&2
  echo "           printf %s 'lin_api_...' > \"$TOKEN_FILE\" && chmod 600 \"$TOKEN_FILE\"" >&2
fi

mkdir -p "$AGENTS" "$STATE"

sed \
  -e "s|__NODE__|$NODE|g" \
  -e "s|__REPO__|$REPO|g" \
  -e "s|__STATE__|$STATE|g" \
  -e "s|__TEAM__|$TEAM|g" \
  -e "s|__TOKEN_FILE__|$TOKEN_FILE|g" \
  "$REPO/launchd/$LABEL.plist" > "$TARGET"

# bootout first: bootstrap on an already-loaded label fails, and a half-installed agent
# is the failure mode this whole feature exists to make visible.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$TARGET"

echo "installed $TARGET"
echo "  runs Sunday 09:10, logs to $STATE/oracle.{out,err}.log"
echo
echo "It prints nothing when the resolver and \`claude plugin list --json\` still agree."
echo "To tell that apart from a job that never fired, ask:"
echo "  qm oracle --status"
echo
echo "Run it once now to see what it says, without filing anything:"
echo "  npm run qm -- oracle"
