#!/usr/bin/env bash
# Install Session Fleet as a macOS login agent (menu bar icon + dashboard server).
#
#   ./install-agent.sh            install and start
#   ./install-agent.sh uninstall  stop and remove
#
# launchd runs it inside your GUI session, which is what a menu bar app needs —
# a plain `nohup ... &` from a terminal gets reaped and the icon disappears.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.deanhicks.sessionfleet"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PY="$HERE/.venv/bin/python"

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  pkill -f "[m]enubar\.py" 2>/dev/null || true
  pkill -f "[s]erve\.py --port" 2>/dev/null || true
  lsof -ti tcp:8787 2>/dev/null | xargs -r kill 2>/dev/null || true
  echo "Session Fleet agent removed."
  exit 0
fi

[ -x "$PY" ] || { echo "Missing venv. Run: python3 -m venv $HERE/.venv && $HERE/.venv/bin/pip install rumps"; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$HERE/menubar.py</string>
  </array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>RunAtLoad</key><true/>
  <!-- Unconditional restart. SuccessfulExit=false looks tidier but leaves the
       agent dead after any clean exit, with no crash log to explain it. An
       always-on menu bar item should come back; deliberate quit goes through
       launchctl bootout in the Quit menu item, which outranks KeepAlive.
       No backticks in here: this heredoc is unquoted so \$HERE expands, which
       means a backtick would run as a command substitution. -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$HERE/.agent.log</string>
  <key>StandardErrorPath</key><string>$HERE/.agent.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict>
</plist>
PLISTEOF

# Clear anything left from a manual run. Match the script name, not an absolute
# path: `python menubar.py` from inside this directory has no path in argv.
pkill -f "[m]enubar\.py" 2>/dev/null || true
pkill -f "[s]erve\.py --port" 2>/dev/null || true
lsof -ti tcp:8787 2>/dev/null | xargs -r kill 2>/dev/null || true

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

sleep 3
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "Session Fleet agent installed and running."
  echo "  Menu bar:  look for the three-bar mark near the clock"
  echo "  Dashboard: http://localhost:8787"
  echo "  Log:       $HERE/.agent.log"
else
  echo "Agent failed to start. Check $HERE/.agent.log"
  exit 1
fi
