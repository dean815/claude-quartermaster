#!/bin/bash
# project-optimizer — archive preflight.
#
# Inventories every store that holds state for a project and reports anything
# that would be lost by archiving it. Emits a single JSON object.
#
#   archive-preflight.sh <path> [--no-github]
#
# Read-only. Never modifies, moves, or deletes anything.
#
# SECURITY: paths from git and the history store are untrusted input. Treat them
# as data — never interpolate into a command string. See scan-project.sh.

set -uo pipefail

DIR="${PWD}"
SKIP_GITHUB=0
for arg in "$@"; do
  case "$arg" in
    --no-github) SKIP_GITHUB=1 ;;
    -*) ;;
    *) DIR="$arg" ;;
  esac
done

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' | tr -d '\n\r'
}
emit_error() {
  printf '{"error":"%s","path":"%s"}\n' "$(json_escape "$1")" "$(json_escape "$2")"
  exit 0
}

DIR="${DIR%/}"
[ -d "$DIR" ] || emit_error "not a directory" "$DIR"
DIR="$(cd "$DIR" && pwd)"
command -v jq >/dev/null 2>&1 || emit_error "jq is required but not installed" "$DIR"

lines_to_json() { jq -R -s 'split("\n") | map(select(length > 0))'; }

# Bounded execution for network calls; macOS ships no timeout(1).
run_bounded() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@" 2>/dev/null; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@" 2>/dev/null; return $?; fi
  local out rc pid watchdog
  out="$(mktemp)" || return 1
  "$@" >"$out" 2>/dev/null &
  pid=$!
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  watchdog=$!
  wait "$pid" 2>/dev/null; rc=$?
  kill -TERM "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null
  cat "$out"; rm -f "$out"
  return $rc
}

# --- Git: what would be lost -----------------------------------------------
IS_REPO=false; REMOTE=""; UNCOMMITTED=0; UNPUSHED=0; NO_UPSTREAM=false
STASHES=0; UNMERGED=""; WORKTREES_JSON='[]'
GH_OWNER=""; GH_REPO=""

if git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1; then
  IS_REPO=true
  REMOTE="$(git -C "$DIR" remote get-url origin 2>/dev/null || true)"
  UNCOMMITTED="$(git -C "$DIR" status --porcelain 2>/dev/null | grep -c . || true)"
  STASHES="$(git -C "$DIR" stash list 2>/dev/null | grep -c . || true)"

  if git -C "$DIR" rev-parse '@{u}' >/dev/null 2>&1; then
    UNPUSHED="$(git -C "$DIR" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
  else
    NO_UPSTREAM=true
    # Commits unreachable from ANY remote ref. Counting all of HEAD would report
    # the entire history for a detached checkout that is fully pushed.
    UNPUSHED="$(git -C "$DIR" rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)"
  fi

  # Local branches with no upstream, or ahead of it — work that exists only here.
  #
  # Test %(upstream) for existence, NOT %(upstream:track): git leaves the track
  # field empty for a branch that is in sync, so keying on it flags every clean
  # branch as local-only.
  while IFS='|' read -r name upstream track; do
    [ -z "$name" ] && continue
    # A branch whose tip is reachable from ANY remote-tracking ref is safe,
    # whatever its upstream is configured to be — it may be backed up by a
    # different remote than the one it tracks.
    tip="$(git -C "$DIR" rev-parse "$name" 2>/dev/null || true)"
    if [ -n "$tip" ] && [ -n "$(git -C "$DIR" branch -r --contains "$tip" 2>/dev/null)" ]; then
      continue
    fi
    if [ -z "$upstream" ] || printf '%s' "$track" | grep -q 'ahead'; then
      UNMERGED="${UNMERGED}${name}"$'\n'
    fi
  done < <(git -C "$DIR" for-each-ref \
             --format='%(refname:short)|%(upstream)|%(upstream:track)' refs/heads 2>/dev/null)

  # Worktrees hold uncommitted work far more often than the main checkout.
  WT_ROWS=""
  while IFS= read -r wt; do
    [ -z "$wt" ] && continue
    [ "$wt" = "$DIR" ] && continue
    [ -d "$wt" ] || continue
    # grep -c already prints a count and exits 1 when it is zero; adding
    # `|| echo 0` would emit "0\n0" and break the JSON built below.
    wt_dirty="$(git -C "$wt" status --porcelain 2>/dev/null | grep -c . || true)"
    wt_branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    if git -C "$wt" rev-parse '@{u}' >/dev/null 2>&1; then
      wt_ahead="$(git -C "$wt" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
    else
      wt_ahead="$(git -C "$wt" rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)"
    fi
    WT_ROWS="${WT_ROWS}$(jq -nc --arg p "$wt" --arg b "$wt_branch" \
      --argjson d "${wt_dirty:-0}" --argjson a "${wt_ahead:-0}" \
      '{path:$p, branch:$b, uncommitted:$d, unpushed:$a}')"$'\n'
  done < <(git -C "$DIR" worktree list --porcelain 2>/dev/null \
             | awk '/^worktree /{print substr($0,10)}')
  WORKTREES_JSON="$(printf '%s\n' "$WT_ROWS" | jq -s -c '.' 2>/dev/null || echo '[]')"

  if printf '%s' "$REMOTE" | grep -qi 'github\.com'; then
    SLUG="$(printf '%s' "$REMOTE" | sed -E 's#^git@github\.com:##; s#^https?://github\.com/##; s#\.git$##')"
    GH_OWNER="${SLUG%%/*}"; GH_REPO="${SLUG##*/}"
  fi
fi

# --- Is the remote-tracking ref actually trustworthy? -----------------------
# `@{u}..HEAD` counts against the LOCAL cache of the remote, which can be
# arbitrarily stale. If another clone force-pushed over these commits, the count
# still reads 0 while the remote no longer has them. Verify against the live
# remote before believing "everything is pushed" — this is the check that stands
# between an archive and silently deleting the only copy of a history.
EVER_FETCHED=false; REMOTE_CHECKED=false; HEAD_ON_REMOTE=false; REMOTES_WITH_HEAD=""
if [ "$IS_REPO" = true ]; then
  { [ -f "$DIR/.git/FETCH_HEAD" ] || [ -f "$(git -C "$DIR" rev-parse --git-common-dir 2>/dev/null)/FETCH_HEAD" ]; } \
    && EVER_FETCHED=true
  if [ "$SKIP_GITHUB" -eq 0 ]; then
    HEAD_SHA="$(git -C "$DIR" rev-parse HEAD 2>/dev/null || true)"
    # Check EVERY configured remote, not just origin. A backup or -dev remote
    # holding the history counts, and treating origin as the only one that
    # matters reports a fully-backed-up repo as unbacked.
    while IFS= read -r rname; do
      [ -z "$rname" ] && continue
      LS="$(run_bounded 20 git -C "$DIR" ls-remote --heads --tags "$rname" || true)"
      [ -z "$LS" ] && continue
      REMOTE_CHECKED=true
      if [ -n "$HEAD_SHA" ] && printf '%s' "$LS" | grep -q "$HEAD_SHA"; then
        HEAD_ON_REMOTE=true
        REMOTES_WITH_HEAD="${REMOTES_WITH_HEAD}${rname}"$'\n'
      fi
    done < <(git -C "$DIR" remote 2>/dev/null)
  fi
fi

# --- Untracked files that would simply vanish ------------------------------
# Credentials and config often live untracked. Git will not preserve them, and
# nothing else will either — this is the quietest way to lose something.
UNTRACKED_SENSITIVE="$(find "$DIR" -maxdepth 2 \
  \( -name .git -o -name node_modules -o -name .venv -o -name vendor \) -prune -o \
  -type f \( -name '.env' -o -name '.env.*' -o -name '*secrets*' -o -name '*.pem' \
             -o -name '*.key' -o -name 'credentials.json' \) -print 2>/dev/null \
  | grep -ivE '\.(example|sample|template|dist|tpl)$' \
  | while IFS= read -r f; do
      rel="${f#"$DIR"/}"
      if [ "$IS_REPO" = true ]; then
        git -C "$DIR" ls-files --error-unmatch "$rel" >/dev/null 2>&1 || printf '%s\n' "$rel"
      else
        printf '%s\n' "$rel"
      fi
    done | head -20)"

# --- Conversation history ---------------------------------------------------
# Matched by the cwd recorded inside each transcript. The encoded directory name
# cannot be reversed reliably: hyphens in a project name are indistinguishable
# from path separators.
HIST_DIR="${HOME}/.claude/projects"
HIST_ROWS=""; HIST_TOTAL_KB=0
if [ -d "$HIST_DIR" ]; then
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    f="$(find "$d" -maxdepth 1 -name '*.jsonl' 2>/dev/null | head -1)"
    [ -z "$f" ] && continue
    cwd="$(head -60 "$f" 2>/dev/null | jq -r 'select(.cwd != null) | .cwd' 2>/dev/null | head -1)"
    [ -z "$cwd" ] && continue
    case "$cwd" in
      "$DIR"|"$DIR"/*) ;;
      *) continue ;;
    esac
    kb="$(du -sk "$d" 2>/dev/null | cut -f1)"
    sessions="$(find "$d" -maxdepth 1 -name '*.jsonl' 2>/dev/null | grep -c . || true)"
    HIST_TOTAL_KB=$(( HIST_TOTAL_KB + ${kb:-0} ))
    HIST_ROWS="${HIST_ROWS}$(jq -nc --arg p "$d" --arg c "$cwd" \
      --argjson kb "${kb:-0}" --argjson s "${sessions:-0}" \
      '{path:$p, cwd:$c, sizeKB:$kb, sessions:$s}')"$'\n'
  done < <(find "$HIST_DIR" -maxdepth 1 -mindepth 1 -type d 2>/dev/null)
fi
HISTORY_JSON="$(printf '%s\n' "$HIST_ROWS" | jq -s -c '.' 2>/dev/null || echo '[]')"

# --- Registries -------------------------------------------------------------
PO_REG="${PROJECT_OPTIMIZER_HOME:-${HOME}/.claude/project-optimizer}/registry.json"
PO_STATUS="none"
[ -f "$PO_REG" ] && PO_STATUS="$(jq -r --arg p "$DIR" '.projects[$p].status // "none"' "$PO_REG" 2>/dev/null || echo none)"

LINEAR_REG="${HOME}/.claude/linear-sync/registry.json"
LINEAR_JSON='{"status":"none"}'
if [ -f "$LINEAR_REG" ]; then
  LINEAR_JSON="$(jq -c --arg p "$DIR" \
    '(.projects[$p] // {status:"none"}) | {status:(.status // "none"), name, linearProjectUrl}' \
    "$LINEAR_REG" 2>/dev/null || echo '{"status":"none"}')"
fi

# --- GitHub -----------------------------------------------------------------
GH_JSON='{"checked":false,"reason":"skipped"}'
if [ "$SKIP_GITHUB" -eq 0 ] && [ -n "$GH_OWNER" ] && command -v gh >/dev/null 2>&1; then
  V="$(gh repo view "${GH_OWNER}/${GH_REPO}" \
        --json name,visibility,isArchived,stargazerCount,forkCount,issues,pullRequests,owner 2>/dev/null || true)"
  if [ -n "$V" ] && printf '%s' "$V" | jq empty >/dev/null 2>&1; then
    GH_JSON="$(printf '%s' "$V" | jq -c '{checked:true, reachable:true, exists:true,
      name:.name, visibility:.visibility, archived:.isArchived,
      stars:.stargazerCount, forks:.forkCount,
      openIssues:(.issues.totalCount // 0), openPRs:(.pullRequests.totalCount // 0),
      owner:(.owner.login // null), viewerIsOwner:null}')"
  else
    GH_JSON='{"checked":true,"reachable":false,"reason":"gh call failed — repo state unknown"}'
  fi
fi

# --- Emit -------------------------------------------------------------------
jq -n \
  --arg path "$DIR" --arg name "$(basename "$DIR")" \
  --argjson isRepo "$IS_REPO" --arg remote "$REMOTE" \
  --argjson uncommitted "${UNCOMMITTED:-0}" \
  --argjson unpushed "${UNPUSHED:-0}" \
  --argjson noUpstream "$NO_UPSTREAM" \
  --argjson stashes "${STASHES:-0}" \
  --argjson everFetched "$EVER_FETCHED" \
  --argjson remoteChecked "$REMOTE_CHECKED" \
  --argjson headOnRemote "$HEAD_ON_REMOTE" \
  --argjson remotesWithHead "$(printf '%s\n' "$REMOTES_WITH_HEAD" | lines_to_json)" \
  --argjson unmergedBranches "$(printf '%s\n' "$UNMERGED" | lines_to_json)" \
  --argjson worktrees "$WORKTREES_JSON" \
  --argjson untrackedSensitive "$(printf '%s\n' "$UNTRACKED_SENSITIVE" | lines_to_json)" \
  --argjson history "$HISTORY_JSON" \
  --argjson historyTotalKB "${HIST_TOTAL_KB:-0}" \
  --arg poStatus "$PO_STATUS" \
  --argjson linear "$LINEAR_JSON" \
  --argjson github "$GH_JSON" \
  '{
    project: {path:$path, name:$name},
    git: {isRepo:$isRepo, remote:$remote, uncommitted:$uncommitted,
          unpushed:$unpushed, noUpstream:$noUpstream, stashes:$stashes,
          everFetched:$everFetched, remoteChecked:$remoteChecked,
          headOnRemote:$headOnRemote, remotesWithHead:$remotesWithHead,
          unmergedBranches:$unmergedBranches, worktrees:$worktrees},
    untrackedSensitive: $untrackedSensitive,
    history: {dirs:$history, totalKB:$historyTotalKB, count:($history|length)},
    registries: {projectOptimizer:$poStatus, linear:$linear},
    github: $github,
    blockers: [
      (if $isRepo and $uncommitted > 0 then "uncommitted changes (\($uncommitted) files)" else empty end),
      (if $isRepo and $noUpstream and $unpushed > 0 and ($headOnRemote|not)
         then "no remote — \($unpushed) commits exist only here" else empty end),
      (if $isRepo and ($noUpstream|not) and $unpushed > 0 and ($headOnRemote|not)
         then "\($unpushed) commits ahead of the tracked branch and not on any configured remote" else empty end),
      (if $stashes > 0 then "\($stashes) stash(es)" else empty end),
      (if $remoteChecked and ($headOnRemote|not)
         then "LOCAL HEAD IS ON NO CONFIGURED REMOTE — every remote was queried live just now, not inferred from cached tracking refs. This still says nothing about repositories that are not configured as remotes: a copy may exist in one, including a PRIVATE repo that does not appear in public listings. Search (`gh repo list <owner> --limit 200` covers private repos) and prove any candidate by SHA before concluding these commits are unique. Remove nothing until a copy is confirmed."
         else empty end),
      (if $isRepo and $remote != "" and ($remoteChecked|not)
         then "could not reach the remote — the unpushed count compares against a cached tracking ref that another clone may have force-pushed past, so it cannot be trusted. Run `git fetch` and re-run before removing anything."
         else empty end),
      (if $isRepo and $remote != "" and ($everFetched|not)
         then "this clone has never fetched — its remote-tracking data may be stale"
         else empty end),
      (if ($unmergedBranches|length) > 0 then "\($unmergedBranches|length) branch(es) not on the remote" else empty end),
      (if ([$worktrees[] | select(.uncommitted > 0 or .unpushed > 0)] | length) > 0
         then "\([$worktrees[] | select(.uncommitted > 0 or .unpushed > 0)] | length) worktree(s) with unsaved work" else empty end),
      (if ($untrackedSensitive|length) > 0 then "\($untrackedSensitive|length) untracked credential/config file(s) that git will not preserve" else empty end)
    ]
  }'

exit 0
