#!/bin/bash
# project-optimizer — registry read/write helper.
#
# The registry records which directories have been onboarded, declined, or
# snoozed, so the SessionStart hook knows when to stay quiet.
#
# Usage:
#   registry.sh get <path>
#   registry.sh set <path> <optimized|declined|snoozed> [archetype] [snooze-days]
#   registry.sh list
#   registry.sh remove <path>
#
# Registry: ~/.claude/project-optimizer/registry.json

set -uo pipefail

# PROJECT_OPTIMIZER_HOME redirects all state. Tests set it to a temp directory —
# without it the suite writes fixture entries into the user's real registry.
REGISTRY_DIR="${PROJECT_OPTIMIZER_HOME:-${HOME}/.claude/project-optimizer}"
REGISTRY="${REGISTRY_DIR}/registry.json"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || die "jq is required but not installed"

ensure_registry() {
  mkdir -p "$REGISTRY_DIR" || die "cannot create $REGISTRY_DIR"
  if [ ! -f "$REGISTRY" ]; then
    printf '{"version":1,"projects":{}}\n' > "$REGISTRY"
  fi
  # Repair an unreadable registry rather than failing every future run.
  if ! jq empty "$REGISTRY" >/dev/null 2>&1; then
    cp "$REGISTRY" "${REGISTRY}.corrupt.$(date +%s)" 2>/dev/null || true
    printf '{"version":1,"projects":{}}\n' > "$REGISTRY"
  fi
}

# Atomic write: build into a temp file, then move into place.
write_registry() {
  local content="$1"
  local tmp
  tmp="$(mktemp "${REGISTRY}.XXXXXX")" || die "cannot create temp file"
  printf '%s\n' "$content" > "$tmp" || die "cannot write temp file"
  jq empty "$tmp" >/dev/null 2>&1 || { rm -f "$tmp"; die "refusing to write invalid JSON"; }
  mv "$tmp" "$REGISTRY" || die "cannot move temp file into place"
}

# Resolve to an absolute path. The SessionStart hook always looks up an absolute
# cwd, so a relative key would create an entry that silently never matches — the
# user says "never ask again here", gets a success message, and is asked again.
#
# This must only transform, never exit: it is called inside a command
# substitution, where `die` would kill the subshell and let the caller continue
# with an empty value.
normalize_path() {
  local p="${1%/}"
  [ -z "$p" ] && return 1
  if [ -d "$p" ]; then
    (cd "$p" 2>/dev/null && pwd)
  else
    # Directory may be gone (e.g. `remove` after deletion) — resolve textually.
    case "$p" in
      /*) printf '%s' "$p" ;;
      *)  printf '%s' "$(pwd)/${p#./}" ;;
    esac
  fi
}

# Callers validate with the two-step pattern below, in the parent shell:
#
#   [ -n "${2:-}" ] || die "path required"     # parent — exit actually works
#   P="$(normalize_path "$2")"
#   [ -n "$P" ] || die "could not resolve path: $2"
#
# Wrapping validation in a helper would reintroduce the bug, since the helper
# would itself run inside a command substitution.

CMD="${1:-}"
[ -z "$CMD" ] && die "usage: registry.sh get|set|list|remove [...]"

case "$CMD" in
  get)
    ensure_registry
    [ -n "${2:-}" ] || die "path required"
    P="$(normalize_path "$2")"
    [ -n "$P" ] || die "could not resolve path: $2"
    jq --arg p "$P" '.projects[$p] // {}' "$REGISTRY"
    ;;

  set)
    ensure_registry
    [ -n "${2:-}" ] || die "path required"
    P="$(normalize_path "$2")"
    [ -n "$P" ] || die "could not resolve path: $2"
    [ -n "${3:-}" ] || die "status required"
    STATUS="$3"
    ARCHETYPE="${4:-}"
    SNOOZE_DAYS="${5:-7}"

    case "$STATUS" in
      optimized|declined|snoozed) ;;
      *) die "status must be one of: optimized, declined, snoozed" ;;
    esac

    NOW_EPOCH="$(date +%s)"
    NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    SNOOZE_UNTIL=0
    if [ "$STATUS" = "snoozed" ]; then
      SNOOZE_UNTIL=$(( NOW_EPOCH + (SNOOZE_DAYS * 86400) ))
    fi

    UPDATED="$(jq \
      --arg p "$P" \
      --arg s "$STATUS" \
      --arg a "$ARCHETYPE" \
      --arg iso "$NOW_ISO" \
      --argjson until "$SNOOZE_UNTIL" \
      '.projects[$p] = ((.projects[$p] // {}) + {
         status: $s,
         updated: $iso,
         snoozeUntil: $until
       } + (if $a == "" then {} else {archetype: $a} end))' \
      "$REGISTRY")" || die "failed to update registry"

    write_registry "$UPDATED"
    printf 'recorded: %s -> %s\n' "$P" "$STATUS"
    ;;

  list)
    ensure_registry
    jq -r '.projects | to_entries[]
           | "\(.value.status // "?")\t\(.value.archetype // "-")\t\(.key)"' \
      "$REGISTRY" | sort
    ;;

  remove)
    ensure_registry
    [ -n "${2:-}" ] || die "path required"
    P="$(normalize_path "$2")"
    [ -n "$P" ] || die "could not resolve path: $2"
    UPDATED="$(jq --arg p "$P" 'del(.projects[$p])' "$REGISTRY")" \
      || die "failed to update registry"
    write_registry "$UPDATED"
    printf 'removed: %s\n' "$P"
    ;;

  *)
    die "unknown command: $CMD (expected get|set|list|remove)"
    ;;
esac
