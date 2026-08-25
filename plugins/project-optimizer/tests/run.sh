#!/bin/bash
# project-optimizer — regression tests.
#
# Each test guards a bug that actually shipped or nearly shipped. Run before
# committing changes to anything in scripts/.
#
#   bash tests/run.sh

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"

# mktemp returns /var/folders/… on macOS, which session-start.sh correctly
# suppresses as noise. Hook tests therefore need a fixture somewhere the hook
# would genuinely fire, or they pass for the wrong reason.
HOOK_TMP="$ROOT/.test-tmp"
rm -rf "$HOOK_TMP"
trap 'rm -rf "$TMP" "$HOOK_TMP"' EXIT

# Redirect all plugin state into the sandbox. Without this the suite writes
# fixture entries into the user's real ~/.claude/project-optimizer/registry.json,
# which it did until this was added.
export PROJECT_OPTIMIZER_HOME="$TMP/state"
mkdir -p "$PROJECT_OPTIMIZER_HOME"

PASS=0; FAIL=0
ok()  { printf '  ok    %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }
assert() { if [ "$1" = "true" ]; then ok "$2"; else bad "$2"; fi; }

command -v jq >/dev/null 2>&1 || { echo "jq is required to run these tests"; exit 1; }

# A repo whose tracked filename is crafted to break out of a shell string,
# plus a file large enough for the oversized-file probe to find.
make_fixture() {
  local d="$1"
  mkdir -p "$d"
  (
    cd "$d" || exit 1
    git init -q .
    git config user.email test@example.com
    git config user.name test
    evil='a"; touch PWNED; echo ".txt'
    printf 'x' > "$evil"
    dd if=/dev/zero of=big.bin bs=1024 count=1200 2>/dev/null
    git add -A >/dev/null 2>&1
    git commit -qm fixture >/dev/null 2>&1
  )
}

echo "project-optimizer regression tests"
echo

# --------------------------------------------------------------------------
echo "[security]"
REPO="$TMP/evil"
make_fixture "$REPO"
rm -f "$TMP/PWNED" "$REPO/PWNED"
( cd "$TMP" && bash "$ROOT/scripts/scan-project.sh" "$REPO" --no-github >/dev/null 2>&1 )
if [ -f "$TMP/PWNED" ] || [ -f "$REPO/PWNED" ]; then
  bad "tracked filename cannot inject shell code"
else
  ok "tracked filename cannot inject shell code"
fi

# The injected fragment used to surface as a bogus extra array entry.
ENTRIES="$(bash "$ROOT/scripts/scan-project.sh" "$REPO" --no-github 2>/dev/null \
  | jq -r '.layout.largeTracked | length')"
assert "$([ "${ENTRIES:-0}" -eq 1 ] && echo true || echo false)" \
  "largeTracked reports exactly the one oversized file (got ${ENTRIES:-0})"

# --------------------------------------------------------------------------
echo
echo "[probes]"
# BSD xargs -I truncated at 255 bytes, silently emptying this probe on long paths.
DEEP="$TMP/a/very/deeply/nested/path/that/exceeds/the/bsd/xargs/limit/for/sure/ok"
mkdir -p "$DEEP" && cp -R "$REPO/." "$DEEP/" 2>/dev/null
FOUND="$(bash "$ROOT/scripts/scan-project.sh" "$DEEP" --no-github 2>/dev/null \
  | jq -r '.layout.largeTracked | length')"
assert "$([ "${FOUND:-0}" -ge 1 ] && echo true || echo false)" \
  "largeTracked still works from a long path"

# .env.example is good practice and must not be flagged as a leaked secret.
SAFE="$TMP/safe"
mkdir -p "$SAFE"
( cd "$SAFE" && git init -q . && git config user.email t@e.com && git config user.name t \
  && printf 'API_KEY=\n' > .env.example && git add -A >/dev/null 2>&1 \
  && git commit -qm x >/dev/null 2>&1 )
RISKY="$(bash "$ROOT/scripts/scan-project.sh" "$SAFE" --no-github 2>/dev/null \
  | jq -r '.layout.riskyTracked | length')"
assert "$([ "${RISKY:-1}" -eq 0 ] && echo true || echo false)" \
  ".env.example is not flagged as risky"

# Error paths must still emit parseable JSON — skills are told to read it.
bash "$ROOT/scripts/scan-project.sh" '/nonexistent/pa"th' --no-github 2>/dev/null \
  | jq empty >/dev/null 2>&1 \
  && ok "invalid path still emits valid JSON" \
  || bad "invalid path still emits valid JSON"

# --------------------------------------------------------------------------
echo
echo "[composition]"
# The audit skill ranks on recency, so it must come from the scan.
LCE="$(bash "$ROOT/scripts/scan-project.sh" "$REPO" --no-github 2>/dev/null \
  | jq -r '.git.lastCommitEpoch')"
assert "$([ "${LCE:-0}" -gt 0 ] && echo true || echo false)" \
  "lastCommitEpoch is populated for a repo"

NOREPO="$TMP/plain"; mkdir -p "$NOREPO"; printf 'hi\n' > "$NOREPO/notes.md"
NR="$(bash "$ROOT/scripts/scan-project.sh" "$NOREPO" --no-github 2>/dev/null)"
assert "$([ "$(printf '%s' "$NR" | jq -r '.git.lastCommit')" = "null" ] && echo true || echo false)" \
  "lastCommit is null outside a repo"

# A directory holding only conversation history is empty, not substantial:
# .remember/ must be pruned or every workspace looks like a real project.
WS="$TMP/workspace"; mkdir -p "$WS/.remember"
for i in 1 2 3 4 5; do printf 'log\n' > "$WS/.remember/day-$i.md"; done
printf '# notes\n' > "$WS/plan.md"
WSJ="$(bash "$ROOT/scripts/scan-project.sh" "$WS" --no-github 2>/dev/null)"
CF="$(printf '%s' "$WSJ" | jq -r '.layout.contentFiles')"
SF="$(printf '%s' "$WSJ" | jq -r '.layout.sourceFiles')"
DF="$(printf '%s' "$WSJ" | jq -r '.layout.docFiles')"
assert "$([ "${CF:-0}" -eq 1 ] && echo true || echo false)" \
  ".remember/ is excluded from contentFiles (got ${CF:-?}, want 1)"
assert "$([ "${SF:-1}" -eq 0 ] && [ "${DF:-0}" -eq 1 ] && echo true || echo false)" \
  "docs-only directory reads as context-workspace (source=${SF:-?}, docs=${DF:-?})"

# A real project that merely lacks git must NOT read as a workspace.
INFRA="$TMP/infra"; mkdir -p "$INFRA"
printf 'services:\n' > "$INFRA/docker-compose.yml"
printf '#!/bin/bash\n' > "$INFRA/deploy.sh"
printf '# readme\n' > "$INFRA/README.md"
ISF="$(bash "$ROOT/scripts/scan-project.sh" "$INFRA" --no-github 2>/dev/null \
  | jq -r '.layout.sourceFiles')"
assert "$([ "${ISF:-0}" -ge 2 ] && echo true || echo false)" \
  "un-gitted infra project is not mistaken for notes (source=${ISF:-?})"

# Claude's own config is tooling state, not project content. A directory holding
# only settings.local.json is empty for every purpose this scan serves.
CFGONLY="$TMP/cfgonly"; mkdir -p "$CFGONLY/.claude"
printf '{}\n' > "$CFGONLY/.claude/settings.local.json"
CC="$(bash "$ROOT/scripts/scan-project.sh" "$CFGONLY" --no-github 2>/dev/null \
  | jq -r '.layout.contentFiles')"
assert "$([ "${CC:-1}" -eq 0 ] && echo true || echo false)" \
  ".claude/ is excluded from contentFiles (got ${CC:-?}, want 0)"

# Empty directory.
mkdir -p "$TMP/void"
VCF="$(bash "$ROOT/scripts/scan-project.sh" "$TMP/void" --no-github 2>/dev/null \
  | jq -r '.layout.contentFiles')"
assert "$([ "${VCF:-1}" -eq 0 ] && echo true || echo false)" \
  "empty directory reports contentFiles 0"

# --------------------------------------------------------------------------
echo
echo "[hook]"
# Fixture in a location the hook treats as a real project, not a noise dir.
HOOK_REPO="$HOOK_TMP/proj"
make_fixture "$HOOK_REPO"
bash "$ROOT/scripts/registry.sh" remove "$HOOK_REPO" >/dev/null 2>&1

# SessionStart fires on compaction and /clear too; re-offering then interrupts work.
for src in startup resume; do
  OUT="$(echo "{\"cwd\":\"$HOOK_REPO\",\"source\":\"$src\"}" | bash "$ROOT/scripts/session-start.sh")"
  assert "$([ -n "$OUT" ] && echo true || echo false)" "hook fires on '$src'"
done
for src in compact clear; do
  OUT="$(echo "{\"cwd\":\"$HOOK_REPO\",\"source\":\"$src\"}" | bash "$ROOT/scripts/session-start.sh")"
  assert "$([ -z "$OUT" ] && echo true || echo false)" "hook is silent on '$src'"
done

# Noise directories must never be offered.
for d in "$HOME" "$HOME/Downloads" /tmp /private/tmp "$HOME/.claude"; do
  OUT="$(echo "{\"cwd\":\"$d\",\"source\":\"startup\"}" | bash "$ROOT/scripts/session-start.sh")"
  assert "$([ -z "$OUT" ] && echo true || echo false)" "hook is silent in $d"
done

# The offer must not hardcode a personal name or gendered pronouns.
grep -qE '\bDean\b|\bhe\b|\bhis\b' "$ROOT/scripts/session-start.sh" \
  && bad "hook text is audience-neutral" \
  || ok "hook text is audience-neutral"

# --------------------------------------------------------------------------
echo
echo "[registry]"
# die inside a command substitution killed only the subshell; callers saw success.
bash "$ROOT/scripts/registry.sh" get >/dev/null 2>&1
assert "$([ $? -ne 0 ] && echo true || echo false)" "get without a path exits non-zero"
bash "$ROOT/scripts/registry.sh" remove >/dev/null 2>&1
assert "$([ $? -ne 0 ] && echo true || echo false)" "remove without a path exits non-zero"

# A relative key never matched the hook's absolute cwd, so skips silently failed.
( cd "$TMP" && bash "$ROOT/scripts/registry.sh" set "./evil" declined >/dev/null 2>&1 )
STORED="$(bash "$ROOT/scripts/registry.sh" list 2>/dev/null | grep -c "$TMP" || true)"
assert "$([ "${STORED:-0}" -ge 1 ] && echo true || echo false)" \
  "relative paths are stored as absolute"

# Recorded directories must actually silence the hook. Uses the non-noise
# fixture so a pass means the registry worked, not that the path was ignored.
bash "$ROOT/scripts/registry.sh" set "$HOOK_REPO" optimized claude-plugin >/dev/null 2>&1
OUT="$(echo "{\"cwd\":\"$HOOK_REPO\",\"source\":\"startup\"}" | bash "$ROOT/scripts/session-start.sh")"
assert "$([ -z "$OUT" ] && echo true || echo false)" \
  "a recorded directory silences the hook"
bash "$ROOT/scripts/registry.sh" remove "$HOOK_REPO" >/dev/null 2>&1

# Regression: this suite once wrote its fixtures into the user's real registry.
assert "$([ -f "$PROJECT_OPTIMIZER_HOME/registry.json" ] && echo true || echo false)" \
  "PROJECT_OPTIMIZER_HOME redirects registry writes"
REAL_REG="$HOME/.claude/project-optimizer/registry.json"
if [ -f "$REAL_REG" ] && grep -q "$TMP" "$REAL_REG" 2>/dev/null; then
  bad "tests do not touch the real registry"
else
  ok "tests do not touch the real registry"
fi

# --------------------------------------------------------------------------
echo
echo "[archive-preflight]"
AR="$TMP/arch"; make_fixture "$AR"
PF() { bash "$ROOT/scripts/archive-preflight.sh" "$AR" --no-github 2>/dev/null; }

# No remote at all: every commit exists only here.
UP="$(PF | jq -r '.git.unpushed')"
NU="$(PF | jq -r '.git.noUpstream')"
assert "$([ "${UP:-0}" -gt 0 ] && [ "$NU" = "true" ] && echo true || echo false)" \
  "no-remote repo reports its commits as unpushed"

# Untracked credentials vanish with the directory — git preserves nothing.
printf 'SECRET=1\n' > "$AR/.env"
printf 'SECRET=\n' > "$AR/.env.example"
UTS="$(PF | jq -r '.untrackedSensitive | join(",")')"
assert "$(printf '%s' "$UTS" | grep -q '^\.env$' && echo true || echo false)" \
  "untracked .env is flagged (got: ${UTS:-none})"
assert "$(printf '%s' "$UTS" | grep -q 'example' && echo false || echo true)" \
  ".env.example is not flagged as sensitive"

# Stashes are invisible once a directory moves.
( cd "$AR" && printf 'change\n' >> big.bin && git stash -q 2>/dev/null ) || true
assert "$([ "$(PF | jq -r '.git.stashes')" -gt 0 ] && echo true || echo false)" \
  "stashes are detected"

# Pushing to a real (local, bare) remote must clear the unpushed count.
BARE="$TMP/bare.git"; git init -q --bare "$BARE" 2>/dev/null
( cd "$AR" && git remote add origin "$BARE" >/dev/null 2>&1 \
  && git push -q -u origin HEAD >/dev/null 2>&1 ) || true
assert "$([ "$(PF | jq -r '.git.unpushed')" -eq 0 ] && echo true || echo false)" \
  "unpushed drops to zero after pushing"

# Regression: counting all of HEAD reported the entire history for a detached
# checkout that was in fact fully pushed.
( cd "$AR" && git checkout -q --detach HEAD >/dev/null 2>&1 ) || true
assert "$([ "$(PF | jq -r '.git.unpushed')" -eq 0 ] && echo true || echo false)" \
  "detached HEAD already on the remote is not counted as unpushed"

# Blockers must surface for a project with real problems.
assert "$([ "$(bash "$ROOT/scripts/archive-preflight.sh" "$REPO" --no-github 2>/dev/null \
  | jq -r '.blockers | length')" -gt 0 ] && echo true || echo false)" \
  "blockers are reported for an unpushed repo"

bash "$ROOT/scripts/archive-preflight.sh" '/nonexistent/pa"th' --no-github 2>/dev/null \
  | jq empty >/dev/null 2>&1 \
  && ok "preflight emits valid JSON for a bad path" \
  || bad "preflight emits valid JSON for a bad path"

# A remote-tracking ref is a local cache and can be arbitrarily stale. When
# another clone force-pushes over these commits, @{u}..HEAD still reports 0
# while the remote no longer has them — reporting that as "safe to archive"
# would delete the only copy. Reproduced here entirely locally.
SR="$TMP/stale"; make_fixture "$SR"
BARE2="$TMP/bare2.git"; git init -q --bare "$BARE2" 2>/dev/null
BR="$(git -C "$SR" rev-parse --abbrev-ref HEAD 2>/dev/null)"
( cd "$SR" && git remote add origin "$BARE2" >/dev/null 2>&1 \
  && git push -q -u origin HEAD >/dev/null 2>&1 ) || true
OTHER="$TMP/other"; mkdir -p "$OTHER"
( cd "$OTHER" && git init -q . && git config user.email t@example.com \
  && git config user.name test && printf 'unrelated\n' > f.txt \
  && git add -A >/dev/null 2>&1 && git commit -qm unrelated >/dev/null 2>&1 \
  && git remote add origin "$BARE2" >/dev/null 2>&1 \
  && git push -qf origin "HEAD:refs/heads/$BR" >/dev/null 2>&1 ) || true

SP_JSON="$(bash "$ROOT/scripts/archive-preflight.sh" "$SR" 2>/dev/null)"
S_UNPUSHED="$(printf '%s' "$SP_JSON" | jq -r '.git.unpushed')"
S_ONREMOTE="$(printf '%s' "$SP_JSON" | jq -r '.git.headOnRemote')"
assert "$([ "${S_UNPUSHED:-1}" -eq 0 ] && echo true || echo false)" \
  "stale tracking ref still reports 0 unpushed (the trap)"
assert "$([ "$S_ONREMOTE" = "false" ] && echo true || echo false)" \
  "force-pushed-over HEAD is detected as absent from the remote"
assert "$(printf '%s' "$SP_JSON" | jq -e '.blockers | map(select(test("ON NO CONFIGURED REMOTE"))) | length > 0' >/dev/null 2>&1 && echo true || echo false)" \
  "stale remote raises a blocker despite unpushed == 0"

# The blocker must not overclaim: it only checked remotes, so it cannot assert the
# commits exist nowhere else. A second copy in a non-remote (often private) repo
# is common, and asserting uniqueness led to a wrong conclusion in real use.
assert "$(printf '%s' "$SP_JSON" | jq -e '.blockers | map(select(test("exist only in this clone"))) | length == 0' >/dev/null 2>&1 && echo true || echo false)" \
  "blocker does not claim uniqueness it did not verify"

# A second remote holding the history counts. Checking only `origin` reported a
# fully-backed-up repo as unbacked.
BACKUP="$TMP/backup.git"; git init -q --bare "$BACKUP" 2>/dev/null
( cd "$SR" && git remote add backup "$BACKUP" >/dev/null 2>&1 \
  && git push -q backup HEAD:refs/heads/main >/dev/null 2>&1 ) || true
MR_JSON="$(bash "$ROOT/scripts/archive-preflight.sh" "$SR" 2>/dev/null)"
assert "$([ "$(printf '%s' "$MR_JSON" | jq -r '.git.headOnRemote')" = "true" ] && echo true || echo false)" \
  "HEAD on a non-origin remote counts as backed up"
assert "$(printf '%s' "$MR_JSON" | jq -e '.git.remotesWithHead | index("backup") != null' >/dev/null 2>&1 && echo true || echo false)" \
  "the remote holding HEAD is named in remotesWithHead"
assert "$(printf '%s' "$MR_JSON" | jq -e '.blockers | map(select(test("ON NO CONFIGURED REMOTE"))) | length == 0' >/dev/null 2>&1 && echo true || echo false)" \
  "no unbacked blocker once another remote has the history"

# --------------------------------------------------------------------------
echo
echo "[manifest]"
for f in .claude-plugin/plugin.json hooks/hooks.json; do
  jq empty "$ROOT/$f" >/dev/null 2>&1 && ok "$f is valid JSON" || bad "$f is valid JSON"
done
jq -e '.hooks.SessionStart' "$ROOT/hooks/hooks.json" >/dev/null 2>&1 \
  && ok "hooks.json uses the wrapped plugin format" \
  || bad "hooks.json uses the wrapped plugin format"
for f in "$ROOT"/scripts/*.sh "$ROOT"/tests/*.sh; do
  bash -n "$f" 2>/dev/null && ok "$(basename "$f") parses" || bad "$(basename "$f") parses"
done

# --------------------------------------------------------------------------
echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
