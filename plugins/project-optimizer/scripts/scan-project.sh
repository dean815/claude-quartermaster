#!/bin/bash
# project-optimizer — deterministic project scan.
#
# Emits a single JSON object describing everything about a project that can be
# established without asking. The onboard/audit skills reason over this output
# so the interview only covers what a script genuinely cannot know.
#
# Usage:
#   scan-project.sh [path] [--no-github]
#
# Always exits 0 and always emits valid JSON. Individual probes that fail are
# reported as null/false rather than aborting the scan.
#
# SECURITY: filenames from `git ls-files` are untrusted input — a repository can
# contain a file named to inject shell code. Every filename here is handled as
# data (read into a variable, quoted) and never interpolated into a command
# string. Do not reintroduce `xargs -I{}` with `sh -c`.

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

# Escape a string for embedding in JSON without requiring jq — the error paths
# below must work even when jq is the thing that is missing.
json_escape() {
  printf '%s' "$1" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' \
    | tr -d '\n\r'
}
emit_error() {
  printf '{"error":"%s","path":"%s"}\n' "$(json_escape "$1")" "$(json_escape "$2")"
  exit 0
}

DIR="${DIR%/}"
[ -d "$DIR" ] || emit_error "not a directory" "$DIR"
DIR="$(cd "$DIR" && pwd)"

command -v jq >/dev/null 2>&1 || emit_error "jq is required but not installed" "$DIR"

# Bounded execution for network calls. macOS ships neither `timeout` nor
# `gtimeout` by default, so the fallback is a real watchdog, not a bare run.
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
  kill -TERM "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  cat "$out"; rm -f "$out"
  return $rc
}

has() { [ -e "$DIR/$1" ] && echo true || echo false; }
lines_to_json() { jq -R -s 'split("\n") | map(select(length > 0))'; }
# Several probes can flag the same language (e.g. pyproject.toml and
# requirements.txt both mean "python"), so collapse duplicates.
lines_to_json_unique() { jq -R -s 'split("\n") | map(select(length > 0)) | unique'; }

# --- Git ------------------------------------------------------------------
IS_REPO=false
REMOTE=""; GH_OWNER=""; GH_REPO=""; CUR_BRANCH=""; DIRTY=false; COMMITS=0
LAST_COMMIT_EPOCH=0; LAST_COMMIT_ISO=""
if git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1; then
  IS_REPO=true
  REMOTE="$(git -C "$DIR" remote get-url origin 2>/dev/null || true)"
  CUR_BRANCH="$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  COMMITS="$(git -C "$DIR" rev-list --count HEAD 2>/dev/null || echo 0)"
  [ -n "$(git -C "$DIR" status --porcelain 2>/dev/null)" ] && DIRTY=true
  # Recency — the audit skill ranks on this, so it must come from the scan
  # rather than an out-of-band git call the report cannot reproduce.
  LAST_COMMIT_EPOCH="$(git -C "$DIR" log -1 --format=%ct 2>/dev/null || echo 0)"
  if [ "${LAST_COMMIT_EPOCH:-0}" -gt 0 ] 2>/dev/null; then
    LAST_COMMIT_ISO="$(git -C "$DIR" log -1 --format=%cI 2>/dev/null || true)"
  else
    LAST_COMMIT_EPOCH=0
  fi
  if printf '%s' "$REMOTE" | grep -qi 'github\.com'; then
    SLUG="$(printf '%s' "$REMOTE" \
      | sed -E 's#^git@github\.com:##; s#^https?://github\.com/##; s#\.git$##')"
    GH_OWNER="${SLUG%%/*}"
    GH_REPO="${SLUG##*/}"
  fi
fi

# --- Stack detection ------------------------------------------------------
STACK=""
add_stack() { STACK="${STACK}$1"$'\n'; }
[ -f "$DIR/package.json" ]      && add_stack "node"
[ -f "$DIR/tsconfig.json" ]     && add_stack "typescript"
[ -f "$DIR/pyproject.toml" ]    && add_stack "python"
[ -f "$DIR/requirements.txt" ]  && add_stack "python"
[ -f "$DIR/setup.py" ]          && add_stack "python"
[ -f "$DIR/Cargo.toml" ]        && add_stack "rust"
[ -f "$DIR/go.mod" ]            && add_stack "go"
[ -f "$DIR/Gemfile" ]           && add_stack "ruby"
[ -f "$DIR/pom.xml" ]           && add_stack "java"
[ -f "$DIR/build.gradle" ]      && add_stack "java"
[ -f "$DIR/composer.json" ]     && add_stack "php"
[ -f "$DIR/Package.swift" ]     && add_stack "swift"
ls "$DIR"/*.xcodeproj >/dev/null 2>&1 && add_stack "xcode"
[ -f "$DIR/Dockerfile" ]        && add_stack "docker"
[ -f "$DIR/.claude-plugin/plugin.json" ] && add_stack "claude-plugin"
[ -f "$DIR/.claude-plugin/marketplace.json" ] && add_stack "claude-marketplace"
ls "$DIR"/*.ipynb >/dev/null 2>&1 && add_stack "notebooks"
[ -d "$DIR/notebooks" ] && add_stack "notebooks"

PKG_MANAGER="none"
[ -f "$DIR/package-lock.json" ] && PKG_MANAGER="npm"
[ -f "$DIR/yarn.lock" ]         && PKG_MANAGER="yarn"
[ -f "$DIR/pnpm-lock.yaml" ]    && PKG_MANAGER="pnpm"
[ -f "$DIR/bun.lockb" ]         && PKG_MANAGER="bun"
[ -f "$DIR/poetry.lock" ]       && PKG_MANAGER="poetry"
[ -f "$DIR/uv.lock" ]           && PKG_MANAGER="uv"

# Archetype discriminators the profiles depend on. `hasBin` separates cli-tool
# from library; `hasDataDir` is a data-analysis signal.
HAS_BIN=false
if [ -f "$DIR/package.json" ]; then
  jq -e 'has("bin")' "$DIR/package.json" >/dev/null 2>&1 && HAS_BIN=true
fi
if [ -f "$DIR/pyproject.toml" ]; then
  grep -qE '^\[project\.scripts\]|^\[tool\.poetry\.scripts\]' \
    "$DIR/pyproject.toml" 2>/dev/null && HAS_BIN=true
fi
HAS_DATA_DIR=false
[ -d "$DIR/data" ] && HAS_DATA_DIR=true

# Framework and MCP hints straight from package.json dependencies.
FRAMEWORKS=""
if [ -f "$DIR/package.json" ]; then
  DEPS="$(jq -r '((.dependencies // {}) + (.devDependencies // {})) | keys[]' \
    "$DIR/package.json" 2>/dev/null || true)"
  for f in next react vue svelte express fastify vite astro remix nuxt electron; do
    printf '%s\n' "$DEPS" | grep -qx "$f" && FRAMEWORKS="${FRAMEWORKS}${f}"$'\n'
  done
  printf '%s\n' "$DEPS" | grep -q '@modelcontextprotocol' \
    && FRAMEWORKS="${FRAMEWORKS}mcp-sdk"$'\n'
  for t in jest vitest mocha playwright @playwright/test cypress; do
    printf '%s\n' "$DEPS" | grep -qx "$t" && FRAMEWORKS="${FRAMEWORKS}test:${t}"$'\n'
  done
fi
# Word-boundary match so "mcp" inside an unrelated package name does not count.
for pyfile in "$DIR/pyproject.toml" "$DIR/requirements.txt"; do
  [ -f "$pyfile" ] || continue
  grep -qiE '(^|[^a-z0-9_.-])(fast)?mcp([^a-z0-9_.-]|$)' "$pyfile" 2>/dev/null \
    && FRAMEWORKS="${FRAMEWORKS}mcp-sdk"$'\n'
done

# --- Claude configuration -------------------------------------------------
CLAUDE_MD_BYTES=0
if [ -f "$DIR/CLAUDE.md" ]; then
  CLAUDE_MD_BYTES="$(wc -c < "$DIR/CLAUDE.md" 2>/dev/null | tr -d ' ' || echo 0)"
fi

# --- Layout ---------------------------------------------------------------
# Listed from inside $DIR so the prefix strip is a fixed "./" rather than a
# sed expression containing the (arbitrary) project path.
ROOT_FILES="$(cd "$DIR" && find . -maxdepth 1 -type f -not -name '.DS_Store' 2>/dev/null \
  | sed 's|^\./||' | sort)"
ROOT_FILE_COUNT="$(printf '%s\n' "$ROOT_FILES" | grep -c . || true)"

STRAY="$(printf '%s\n' "$ROOT_FILES" \
  | grep -iE '^(test|tmp|temp|scratch|untitled|foo|bar|copy|new|draft|notes?)[-_ .]|\.(bak|old|orig|tmp|swp|log)$|[ ]|^Untitled' \
  || true)"

# Content composition. Distinguishes a real project that simply lacks git from a
# directory that only ever held conversation context.
#
# Pruned: dependency and build trees, plus tooling state that belongs to Claude
# rather than to the project (.remember, .claude). Counting those makes an empty
# directory look substantial — a folder holding one settings.local.json is empty
# for every purpose this scan serves.
count_files() {
  find "$DIR" \
    \( -name .git -o -name node_modules -o -name .venv -o -name venv \
       -o -name vendor -o -name dist -o -name build -o -name target \
       -o -name .remember -o -name .claude -o -name site-packages \
       -o -name __pycache__ -o -name .next -o -name .cache \) -prune -o \
    -type f "$@" -print 2>/dev/null | wc -l | tr -d ' '
}
CONTENT_FILES="$(count_files ! -name .DS_Store)"
DOC_FILES="$(count_files -name '*.md')"
SOURCE_FILES="$(count_files \( \
  -name '*.py' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \
  -o -name '*.ts' -o -name '*.tsx' -o -name '*.jsx' -o -name '*.go' \
  -o -name '*.rs' -o -name '*.rb' -o -name '*.java' -o -name '*.swift' \
  -o -name '*.sh' -o -name '*.c' -o -name '*.cpp' -o -name '*.h' \
  -o -name '*.yml' -o -name '*.yaml' -o -name '*.toml' -o -name 'Dockerfile' \
  -o -name '*.sql' -o -name '*.ipynb' -o -name '*.html' -o -name '*.css' \
  -o -name '*.scss' -o -name '*.vue' -o -name '*.svelte' \))"

# Tracked files that probably should not be in version control.
# Template env files (.env.example and friends) are good practice, not a risk.
RISKY=""
if [ "$IS_REPO" = true ]; then
  RISKY="$(git -C "$DIR" ls-files 2>/dev/null \
    | grep -iE '(^|/)\.env($|\.)|\.(pem|key|p12|pfx|keystore|jks)$|(^|/)id_(rsa|ed25519)$|credentials\.json$|secrets?\.(json|ya?ml)$' \
    | grep -ivE '\.(example|sample|template|dist|tpl)$' \
    | head -25 || true)"
fi

# Tracked files over ~1MB. Filenames are read as data — never interpolated into
# a command string (see the SECURITY note in the header).
LARGE=""
if [ "$IS_REPO" = true ]; then
  LARGE="$(git -C "$DIR" ls-files -z 2>/dev/null \
    | while IFS= read -r -d '' f; do
        p="$DIR/$f"
        [ -f "$p" ] || continue
        s="$(wc -c < "$p" 2>/dev/null | tr -d ' ')"
        [ "${s:-0}" -gt 1048576 ] 2>/dev/null \
          && printf '%s (%sKB)\n' "$f" "$(( s / 1024 ))"
      done | head -15 || true)"
fi

# --- GitHub ---------------------------------------------------------------
GH_JSON='{"checked":false,"reason":"skipped"}'
if [ "$SKIP_GITHUB" -eq 0 ] && [ -n "$GH_OWNER" ] && command -v gh >/dev/null 2>&1; then
  REPO_VIEW="$(run_bounded 15 gh repo view "${GH_OWNER}/${GH_REPO}" \
    --json name,visibility,description,repositoryTopics,licenseInfo,defaultBranchRef,hasIssuesEnabled,isArchived \
    || true)"
  if [ -n "$REPO_VIEW" ] && printf '%s' "$REPO_VIEW" | jq empty >/dev/null 2>&1; then
    DEF_BRANCH="$(printf '%s' "$REPO_VIEW" | jq -r '.defaultBranchRef.name // "main"')"
    PROTECTED=false
    run_bounded 12 gh api \
      "repos/${GH_OWNER}/${GH_REPO}/branches/${DEF_BRANCH}/protection" \
      >/dev/null 2>&1 && PROTECTED=true

    # Listed with find + basename rather than `ls | grep`: filenames are
    # untrusted, and ls output is not safely parseable (SC2010).
    WORKFLOWS=""
    if [ -d "$DIR/.github/workflows" ]; then
      while IFS= read -r wf; do
        [ -n "$wf" ] && WORKFLOWS="${WORKFLOWS}${wf##*/}"$'\n'
      done < <(find "$DIR/.github/workflows" -maxdepth 1 -type f \
                 \( -name '*.yml' -o -name '*.yaml' \) 2>/dev/null | sort)
    fi
    ISSUE_TPLS=""
    if [ -d "$DIR/.github/ISSUE_TEMPLATE" ]; then
      while IFS= read -r it; do
        [ -n "$it" ] && ISSUE_TPLS="${ISSUE_TPLS}${it##*/}"$'\n'
      done < <(find "$DIR/.github/ISSUE_TEMPLATE" -maxdepth 1 -type f 2>/dev/null | sort)
    fi

    PR_TPL=false
    for p in .github/pull_request_template.md .github/PULL_REQUEST_TEMPLATE.md \
             docs/pull_request_template.md pull_request_template.md; do
      [ -f "$DIR/$p" ] && PR_TPL=true && break
    done
    CODEOWNERS=false
    for p in .github/CODEOWNERS CODEOWNERS docs/CODEOWNERS; do
      [ -f "$DIR/$p" ] && CODEOWNERS=true && break
    done
    DEPENDABOT=false
    { [ -f "$DIR/.github/dependabot.yml" ] || [ -f "$DIR/.github/dependabot.yaml" ]; } \
      && DEPENDABOT=true

    GH_JSON="$(jq -n \
      --argjson repo "$REPO_VIEW" \
      --argjson protected "$PROTECTED" \
      --argjson prTemplate "$PR_TPL" \
      --argjson codeowners "$CODEOWNERS" \
      --argjson dependabot "$DEPENDABOT" \
      --argjson workflows "$(printf '%s\n' "$WORKFLOWS" | lines_to_json)" \
      --argjson issueTemplates "$(printf '%s\n' "$ISSUE_TPLS" | lines_to_json)" \
      '{checked:true, exists:true, reachable:true,
        name:$repo.name, visibility:$repo.visibility,
        description:($repo.description // ""),
        archived:$repo.isArchived,
        topics:[($repo.repositoryTopics // [])[] | .name // .topic.name // empty],
        license:($repo.licenseInfo.key // null),
        defaultBranch:($repo.defaultBranchRef.name // null),
        issuesEnabled:$repo.hasIssuesEnabled,
        branchProtected:$protected,
        prTemplate:$prTemplate, codeowners:$codeowners,
        dependabot:$dependabot,
        workflows:$workflows, issueTemplates:$issueTemplates}')"
  else
    # The call failed. This is UNKNOWN, not "the repo does not exist" — a
    # timeout, a permissions error, and a deleted repo are indistinguishable here.
    GH_JSON='{"checked":true,"reachable":false,"reason":"gh call failed or timed out — repo state unknown"}'
  fi
elif [ "$SKIP_GITHUB" -eq 0 ] && [ -n "$GH_OWNER" ]; then
  GH_JSON='{"checked":false,"reason":"gh not installed"}'
elif [ "$SKIP_GITHUB" -eq 0 ] && [ "$IS_REPO" = true ] && [ -z "$REMOTE" ]; then
  GH_JSON='{"checked":true,"reachable":true,"exists":false,"reason":"git repo has no remote"}'
elif [ "$SKIP_GITHUB" -eq 0 ] && [ "$IS_REPO" = false ]; then
  GH_JSON='{"checked":true,"reachable":true,"exists":false,"reason":"not a git repo"}'
fi

# --- Emit -----------------------------------------------------------------
jq -n \
  --arg path "$DIR" \
  --arg name "$(basename "$DIR")" \
  --argjson isRepo "$IS_REPO" \
  --arg remote "$REMOTE" \
  --arg ghOwner "$GH_OWNER" \
  --arg ghRepo "$GH_REPO" \
  --arg branch "$CUR_BRANCH" \
  --argjson dirty "$DIRTY" \
  --argjson commits "${COMMITS:-0}" \
  --argjson lastCommitEpoch "${LAST_COMMIT_EPOCH:-0}" \
  --arg lastCommitIso "$LAST_COMMIT_ISO" \
  --argjson contentFiles "${CONTENT_FILES:-0}" \
  --argjson docFiles "${DOC_FILES:-0}" \
  --argjson sourceFiles "${SOURCE_FILES:-0}" \
  --argjson stack "$(printf '%s\n' "$STACK" | lines_to_json_unique)" \
  --arg pkgManager "$PKG_MANAGER" \
  --argjson frameworks "$(printf '%s\n' "$FRAMEWORKS" | lines_to_json_unique)" \
  --argjson hasBin "$HAS_BIN" \
  --argjson hasDataDir "$HAS_DATA_DIR" \
  --argjson hasClaudeMd "$(has CLAUDE.md)" \
  --argjson claudeMdBytes "${CLAUDE_MD_BYTES:-0}" \
  --argjson hasClaudeDir "$(has .claude)" \
  --argjson hasProjectSettings "$(has .claude/settings.json)" \
  --argjson hasMcpJson "$(has .mcp.json)" \
  --argjson hasGitignore "$(has .gitignore)" \
  --argjson hasReadme "$(has README.md)" \
  --argjson hasLicense "$(has LICENSE)" \
  --argjson hasSrc "$(has src)" \
  --argjson hasTests "$([ -d "$DIR/tests" ] || [ -d "$DIR/test" ] || [ -d "$DIR/__tests__" ] && echo true || echo false)" \
  --argjson hasDocs "$(has docs)" \
  --argjson rootFileCount "${ROOT_FILE_COUNT:-0}" \
  --argjson rootFiles "$(printf '%s\n' "$ROOT_FILES" | lines_to_json)" \
  --argjson strayFiles "$(printf '%s\n' "$STRAY" | lines_to_json)" \
  --argjson riskyTracked "$(printf '%s\n' "$RISKY" | lines_to_json)" \
  --argjson largeTracked "$(printf '%s\n' "$LARGE" | lines_to_json)" \
  --argjson github "$GH_JSON" \
  '{
    project: {path:$path, name:$name},
    git: {isRepo:$isRepo, remote:$remote, owner:$ghOwner, repo:$ghRepo,
          branch:$branch, dirty:$dirty, commits:$commits, hasGitignore:$hasGitignore,
          lastCommitEpoch:$lastCommitEpoch,
          lastCommit:(if $lastCommitIso == "" then null else $lastCommitIso end)},
    stack: {detected:$stack, packageManager:$pkgManager, frameworks:$frameworks,
            hasBin:$hasBin, hasDataDir:$hasDataDir},
    claude: {hasClaudeMd:$hasClaudeMd, claudeMdBytes:$claudeMdBytes,
             hasClaudeDir:$hasClaudeDir, hasProjectSettings:$hasProjectSettings,
             hasMcpJson:$hasMcpJson},
    layout: {hasReadme:$hasReadme, hasLicense:$hasLicense, hasSrc:$hasSrc,
             hasTests:$hasTests, hasDocs:$hasDocs,
             rootFileCount:$rootFileCount, rootFiles:$rootFiles,
             strayFiles:$strayFiles, riskyTracked:$riskyTracked,
             largeTracked:$largeTracked,
             contentFiles:$contentFiles, docFiles:$docFiles,
             sourceFiles:$sourceFiles},
    github: $github
  }'

exit 0
