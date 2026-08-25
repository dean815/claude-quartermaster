#!/bin/bash
# project-optimizer — SessionStart hook (STRICTLY READ-ONLY).
#
# Fires on every session start. If the current directory has never been
# onboarded, declined, or snoozed, it emits a SessionStart additionalContext
# message asking the assistant to OFFER onboarding — it does not start it.
#
# This script NEVER creates, modifies, or deletes anything. The registry is
# written only by the /project-optimizer:onboard and :skip skills.
#
# Registry: ~/.claude/project-optimizer/registry.json  (keyed by absolute path)

set -uo pipefail

# Kept in sync with registry.sh — see the note there on PROJECT_OPTIMIZER_HOME.
REGISTRY="${PROJECT_OPTIMIZER_HOME:-${HOME}/.claude/project-optimizer}/registry.json"

# --- Resolve the project directory ----------------------------------------
# SessionStart hooks receive JSON on stdin containing "cwd".
STDIN_JSON="$(cat 2>/dev/null || true)"
PROJECT_DIR=""
SOURCE=""
if [ -n "$STDIN_JSON" ] && command -v jq >/dev/null 2>&1; then
  PROJECT_DIR="$(printf '%s' "$STDIN_JSON" | jq -r '.cwd // empty' 2>/dev/null || true)"
  SOURCE="$(printf '%s' "$STDIN_JSON" | jq -r '.source // empty' 2>/dev/null || true)"
fi
[ -z "$PROJECT_DIR" ] && PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

# SessionStart also fires on compaction and /clear. Re-injecting the offer then
# would interrupt work in progress — exactly what this hook promises not to do.
case "$SOURCE" in
  compact|clear) exit 0 ;;
esac

PROJECT_DIR="${PROJECT_DIR%/}"
[ -z "$PROJECT_DIR" ] && exit 0
[ -d "$PROJECT_DIR" ] || exit 0

# Canonicalize exactly as registry.sh does, so the key this hook looks up is
# always the key the skills write. Without this, a symlinked path (macOS /tmp
# vs /private/tmp) records under one key and is looked up under another, and
# the offer returns forever in a directory that was already onboarded.
PROJECT_DIR="$(cd "$PROJECT_DIR" 2>/dev/null && pwd)" || exit 0
[ -z "$PROJECT_DIR" ] && exit 0

# --- Ignore only genuine noise --------------------------------------------
# Deliberately narrow: the preference is to fire too often rather than too
# little. The offer is a single line and always asks before doing anything.
case "$PROJECT_DIR" in
  "$HOME"|"/"|"") exit 0 ;;
  "$HOME/.claude"|"$HOME/.claude/"*) exit 0 ;;
  "$HOME/Downloads"|"$HOME/Downloads/"*) exit 0 ;;
  "$HOME/Desktop"|"$HOME/.Trash"|"$HOME/.Trash/"*) exit 0 ;;
  /tmp|/private/tmp|/tmp/*|/private/tmp/*|/private/var/folders/*|/var/folders/*) exit 0 ;;
  *"/.claude-worktrees/"*|*"-worktrees-"*|*"/worktrees/"*) exit 0 ;;
  *"/node_modules/"*|*"/.git/"*|*"/vendor/"*|*"/.venv/"*|*"/site-packages/"*) exit 0 ;;
esac

# --- Already known? Stay silent -------------------------------------------
NOW_EPOCH="$(date +%s 2>/dev/null || echo 0)"
if [ -f "$REGISTRY" ] && command -v jq >/dev/null 2>&1; then
  STATUS="$(jq -r --arg p "$PROJECT_DIR" \
    '.projects[$p].status // empty' "$REGISTRY" 2>/dev/null || true)"
  case "$STATUS" in
    optimized|declined) exit 0 ;;
    snoozed)
      UNTIL="$(jq -r --arg p "$PROJECT_DIR" \
        '.projects[$p].snoozeUntil // 0' "$REGISTRY" 2>/dev/null || echo 0)"
      # Still snoozed -> silent. Expired -> fall through and offer again.
      [ "$UNTIL" -gt "$NOW_EPOCH" ] 2>/dev/null && exit 0
      ;;
  esac
elif [ -f "$REGISTRY" ]; then
  # jq unavailable: best-effort substring match so we fail quiet, not noisy.
  grep -q "\"${PROJECT_DIR}\"" "$REGISTRY" 2>/dev/null && exit 0
fi

# --- Cheap peek so the offer is informative (a handful of stat calls) ------
NAME="$(basename "$PROJECT_DIR")"
FACTS=""

if [ -d "$PROJECT_DIR/.git" ] || git -C "$PROJECT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  REMOTE="$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || true)"
  if [ -n "$REMOTE" ]; then
    FACTS="git repo with remote"
  else
    FACTS="git repo, no remote"
  fi
else
  FACTS="not a git repo"
fi

[ -f "$PROJECT_DIR/CLAUDE.md" ] && FACTS="$FACTS; has CLAUDE.md" || FACTS="$FACTS; no CLAUDE.md"
[ -f "$PROJECT_DIR/.claude/settings.json" ] \
  && FACTS="$FACTS; has project settings" \
  || FACTS="$FACTS; no project-scoped settings"
[ -f "$PROJECT_DIR/README.md" ] || FACTS="$FACTS; no README"

MSG="Project optimizer: this is the first Claude Code session in \"${NAME}\" (${PROJECT_DIR}). Quick scan: ${FACTS}. ASK the user — in one short question, do not start yet — whether they want to run project onboarding now. Onboarding tunes which plugins and MCP servers load for this project, writes or improves CLAUDE.md, checks directory organization, and verifies GitHub configuration; it always presents a plan before changing anything. If yes, invoke the Skill tool with skill 'project-optimizer:onboard' and pass this exact path: ${PROJECT_DIR}. If they decline OR defer it in any way — 'no', 'never', 'not now', 'later', 'remind me next week' — you must invoke the Skill tool with 'project-optimizer:skip' and that same path. Saying you have snoozed or declined it without invoking that skill records nothing, and the offer returns on the very next session while the user believes it will not. If their first message is a greeting, or carries no task, ask then — that is the moment this is least disruptive. If they are already mid-task, stay silent and get on with their actual request; never block or delay their work for this. Skipping records nothing, so the offer returns next session."

# --- Emit SessionStart additionalContext ----------------------------------
if command -v jq >/dev/null 2>&1; then
  jq -n --arg ctx "$MSG" \
    '{hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:$ctx}}'
else
  ESCAPED="$(printf '%s' "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$ESCAPED"
fi

exit 0
