# project-optimizer

[![CI](https://github.com/dean815/claude-project-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/dean815/claude-project-optimizer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Brings new project directories to a well-configured baseline. The first time
Claude Code runs in a directory, the plugin offers to onboard it — tuning which
plugins and MCP servers load, writing or improving `CLAUDE.md`, checking directory
organization, and verifying GitHub configuration.

It always proposes a plan first and changes nothing without approval.

## How it works

```
SessionStart hook  ──▶  registry lookup  ──▶  unknown directory?
   (read-only)              (~/.claude/)              │
                                                      ▼
                                          one-line offer, injected as context
                                                      │
                             ┌────────────────────────┼──────────────────┐
                             ▼                        ▼                  ▼
                        /onboard                  /skip              ignored
                             │                (declined/snoozed)   (nothing happens)
                             ▼
                   scan ─▶ classify ─▶ interview gaps ─▶ plan ─▶ approve ─▶ apply
```

The hook is strictly read-only: it never creates, modifies, or deletes anything.
Only the skills write, and only after approval.

## Components

| Component | Purpose |
|---|---|
| `hooks/hooks.json` | Registers the SessionStart hook |
| `scripts/session-start.sh` | Read-only offer. Silent for known or noise directories |
| `scripts/scan-project.sh` | Deterministic project scan, emits JSON |
| `scripts/archive-preflight.sh` | Inventories every store holding project state; reports what archiving would destroy |
| `scripts/registry.sh` | Reads and writes onboarding state |
| `skills/onboard/` | Scan, interview, plan, apply |
| `skills/audit/` | Read-only gap report; batch mode ranks many projects |
| `skills/archive/` | Retire a project without orphaning its state |
| `skills/skip/` | Records a directory as declined or snoozed |
| `references/` | Archetypes, plugin matrix, CLAUDE.md template, GitHub checklist, layout checks — shared by `onboard` and `audit` |

## Usage

```bash
/project-optimizer:onboard                    # onboard the current directory
/project-optimizer:onboard --area github      # only the GitHub checks
/project-optimizer:audit                      # read-only gap report
/project-optimizer:audit --batch ~/claude     # rank every project under a root
/project-optimizer:archive                    # inventory, plan, then ask
/project-optimizer:archive --plan-only        # plan and stop, no prompt
/project-optimizer:skip                       # snooze the offer here (7 days)
/project-optimizer:skip never                 # never offer here again
```

The scripts run standalone too:

```bash
bash scripts/scan-project.sh ~/some/project           # full scan, includes GitHub
bash scripts/scan-project.sh ~/some/project --no-github
bash scripts/registry.sh list                          # every recorded project
bash scripts/registry.sh remove ~/some/project         # make the offer return
```

## What it covers

**Plugins and MCP servers** — writes a project-scoped `.claude/settings.json`
enabling what the project needs and disabling what it does not. Your global setup
is never modified. MCP scoping matters more than plugin scoping: an MCP server
contributes full tool schemas to context, a plugin contributes a short description.

**CLAUDE.md** — creates one where missing, using a template built around a single
test: would Claude get this wrong otherwise? Where a `CLAUDE.md` already exists, it
delegates to the `claude-md-management` plugin's `claude-md-improver` rather than
rewriting.

**Directory organization** — checks root clutter, scratch files, missing standard
directories, oversized tracked files, and `.gitignore` adequacy. Proposes moves;
never deletes.

**GitHub** — four categories: repo basics (description, topics, license, README),
hygiene files (`.gitignore`, no tracked secrets), collaboration config (branch
protection, PR and issue templates, CODEOWNERS), and automation (CI, Dependabot,
secret scanning).

**Archiving always plans first.** A dry run is the default posture, not a flag:
every invocation inventories, plans, and presents before asking what to do. Dry
runs against real projects caught four cases where a project was about to be
called safe on evidence that did not support it — stale remote-tracking refs
trusted, in-sync branches flagged as local-only, a blocker asserting uniqueness
it had not verified, and only `origin` being checked when a backup remote held
the history.

**Archiving** — the reverse direction. A project holds state in six places:
working directory, conversation history (`~/.claude/projects/`, which nothing
else copies), git worktrees, the GitHub repo, Linear, and this plugin's registry.
Deleting the directory orphans the other five. `archive` inventories all of them,
reports what would be lost — unpushed commits, stashes, local-only branches,
worktrees with unsaved work, untracked credential files — and works in an order
where nothing is removed before its content is confirmed safe elsewhere.

Conversation history is located by the `cwd` recorded inside each transcript. The
encoded directory name cannot be reversed: hyphens in a project name are
indistinguishable from path separators.

## Trigger behavior

The hook fires broadly by design — better to offer once too often than to miss a
new project. It stays silent only for:

- The home directory itself, `~/Downloads`, `~/Desktop`, `~/.Trash`, `~/.claude`
- `/tmp`, `/private/tmp`, and system temp paths
- Git worktrees, `node_modules`, `vendor`, `.venv`
- Any directory already recorded as `optimized`, `declined`, or actively `snoozed`

The offer is one line and always asks before doing anything. Ignoring it costs
nothing — the session continues normally.

## State

`~/.claude/project-optimizer/registry.json`, keyed by absolute path:

```json
{
  "version": 1,
  "projects": {
    "/Users/you/code/thing": {
      "status": "optimized",
      "archetype": "mcp-server",
      "updated": "2026-07-28T16:25:54Z",
      "snoozeUntil": 0
    }
  }
}
```

Statuses: `optimized` (done), `declined` (never ask again), `snoozed` (ask again
after `snoozeUntil`). Writes are atomic, and an unparseable registry is backed up
and rebuilt rather than causing failures.

Set `PROJECT_OPTIMIZER_HOME` to relocate all state. The test suite uses this to
sandbox itself; without it, tests write fixtures into the real registry.

## Safety guarantees

- The SessionStart hook never writes anything
- No file is created or modified before an explicit approval
- Nothing is ever deleted — removal is always proposed, never performed
- No `git commit`, `push`, or history rewrite unless directly asked
- Repository visibility is never changed as a routine step
- Tracked secrets are reported, never auto-remediated: they need rotation first,
  and removing them from history is the user's decision
- Credentials are never written into any file, including `.mcp.json` and examples
- Archiving never deletes a GitHub repo (`gh repo archive` only), never deletes a
  Linear project, never `rm -rf`s a worktree, and never removes an original
  before verifying the copy

## Requirements

- `jq` — required by all three scripts
- `git` — for repository detection
- `gh`, authenticated — optional; GitHub checks are reported as skipped without it

## Installation

Local testing:

```bash
claude --plugin-dir /path/to/claude-project-optimizer
```

Plugin changes, including hooks, load at session start. Restart Claude Code after
editing hook configuration.

## Notes

Project-scoped `enabledPlugins` takes effect on the **next** session, not the
current one. Verify the intended set is active after restarting.
