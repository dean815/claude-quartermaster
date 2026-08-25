---
name: onboard
description: This skill should be used when the user asks to "onboard this project", "onboard this repo", "optimize this project", "set up this project for Claude", "run project onboarding", "get this repo properly configured", or accepts the first-session onboarding offer emitted by the project-optimizer SessionStart hook. Scans the project, interviews only about what cannot be detected, then proposes a plan covering plugin/MCP scoping, CLAUDE.md, directory organization, and GitHub configuration. Use the audit skill instead when the user only wants a report and no changes.
argument-hint: "[path] [--area plugins|claude-md|layout|github] [--plan-only]"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Skill
---

# Project Onboarding

Bring a project directory to a well-configured baseline across five areas: which
plugins and MCP servers load, CLAUDE.md quality, directory organization, GitHub
configuration, and the project's session-naming short code.

**The governing rule: propose a complete plan, change nothing until the user
approves it.** No file is written, no `gh` mutation is issued, and no registry
entry is recorded before explicit confirmation.

## Invocation

Default the project path to the current working directory when no path argument
is given, and use an **absolute** path everywhere. The registry is keyed by
absolute path and the SessionStart hook looks up an absolute `cwd`; a relative
key creates an entry that never matches, leaving the offer live in a directory
that was fully onboarded. When the offer came from the hook, reuse the exact path
the hook printed rather than re-deriving it.

Planning first is the default and is not optional — the governing rule above is
the whole posture, and there is no flag that skips to acting.

- `--area <name>` — run only that area's checks, skipping the rest of the
  interview and the archetype-confirmation question
- `--plan-only` — present the plan and stop without asking. For comparing
  several projects before deciding

Approval here is deliberately plain text rather than `AskUserQuestion`, unlike
the `archive` skill: an onboarding plan is a list of many small independent
items, and compressing it into four options discards the per-item detail the
user needs. Archive's choices are coarse dispositions, so structured options fit
there and not here.

## Workflow

### 1. Scan before asking

Run the deterministic scan first. It establishes most facts without spending a
question:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/scan-project.sh" "<project-path>"
```

Pass `--no-github` to skip network calls when GitHub is out of scope or `gh` is
unavailable. Read the resulting JSON in full before proceeding.

Interpret the GitHub block carefully — three states, not two:

- `checked: false` — the probe did not run. **Unknown.**
- `reachable: false` — `gh` ran but the call failed or timed out. **Unknown**,
  not "no repo". Do not propose `gh repo create` against a repo that may exist.
- `exists: false` with reason `not a git repo` or `git repo has no remote` — the
  repo genuinely does not exist.

If the output has a top-level `error` key, stop and report it. Both scripts
require `jq`; proceeding without it produces guesses rather than facts.

### 2. Classify the archetype

Match the scan against the profiles in
`${CLAUDE_PLUGIN_ROOT}/references/archetypes.md`, following its stated
classification order. Each archetype carries a recommended plugin set, MCP
posture, CLAUDE.md skeleton, expected layout, and GitHub rigor level. The scan
emits `stack.hasBin` (separates `cli-tool` from `library`), `stack.hasDataDir`,
and `layout.sourceFiles` / `docFiles` / `contentFiles` specifically to
discriminate between them.

State the inferred archetype and let the user correct it, rather than asking them
to pick from a blank list. When signals are genuinely ambiguous, offer the two
best candidates.

**Three archetypes end the workflow early.** Recognizing them is the single
highest-value step here, because the hook fires in every unregistered directory
and many of those are not projects at all:

| Classification | Signal | Response |
|---|---|---|
| `empty` | `contentFiles == 0` | Nothing to onboard. Say so, offer `skip`. Stop. |
| `context-workspace` | `sourceFiles == 0` | Notes, not code. Offer `skip`, or at most a two-sentence CLAUDE.md. Stop. |
| `experiment` | Few commits, no README, no remote, scratch-shaped name | Smallest useful change set, or `skip` with a snooze. |

In each case say plainly why the full workflow does not apply. Do not assemble a
four-area plan whose items are mostly "not applicable" — that wastes the user's
review attention and makes the tool feel indiscriminate.

Note that **absence of git is not itself a signal** of any of these. A directory
with `docker-compose.yml` and a few shell scripts is infrastructure that simply
was never initialized; classify it normally and propose `git init`.

### 3. Interview only the gaps

Ask **only what the scan cannot determine**. Use `AskUserQuestion`, and keep it to
one round of at most four questions.

Questions worth asking (select only those still open):

- **Audience and lifespan** — throwaway experiment, personal tool, or something
  others will use? This drives GitHub rigor and CLAUDE.md depth more than any
  other answer.
- **Visibility** — will this become a public repo? Determines whether license,
  topics, README quality, and secret scanning matter.
- **Archetype confirmation** — only when signals conflict.

Questions never worth asking: the language, package manager, test runner, whether
a CLAUDE.md exists, or whether there is a git remote. The scan knows all of these.

### 4. Build the plan

Compose proposed changes across the five areas. Consult the references rather than
improvising:

| Area | Reference (under `${CLAUDE_PLUGIN_ROOT}/references/`) | Produces |
|---|---|---|
| Plugins and MCP | `plugin-matrix.md` | `.claude/settings.json`, `.mcp.json` |
| CLAUDE.md | `claude-md-template.md` | `CLAUDE.md` |
| Layout | `layout-checks.md` | Moves, additions, `.gitignore` edits |
| GitHub | `github-checklist.md` | `gh` commands, `.github/` files |
| Session naming | `session-naming.md` | `.claude/settings.json` (`env`), `~/.claude/session-name-shortnames.json` |

Session naming is the only area that writes outside the project — it registers the
project's short code in a user-level map. Skip the area entirely when
`~/.claude/session-name-shortnames.json` does not exist; that means the naming system
is not installed on this machine, and inventing the file would strand a code nothing
reads.

**Delegate rather than duplicate.** When the project already has a CLAUDE.md and
the `claude-md-management` plugin is installed, invoke the Skill tool with
`claude-md-management:claude-md-improver` instead of rewriting the file here; the
template is for projects that have none. When `claude-code-setup` is installed,
`claude-code-setup:claude-automation-recommender` is the better source for hook
and agent suggestions. When neither is installed, work from the references and do
not mention the delegation.

### 5. Present the plan

Show every proposed change grouped by area, each with a one-line rationale. For
file changes, show the actual content or a diff — never a summary like "improve
CLAUDE.md". For `gh` mutations, show the exact command.

Mark each item as one of:

- **Add** — creating something absent
- **Edit** — modifying existing content (show before and after)
- **Move** — relocating a file (state source and destination)
- **Remote** — a GitHub API change (state that it affects the live repo)

Flag anything irreversible or outward-facing separately: changing repository
visibility, enabling branch protection, deleting files, rewriting git history.
Never propose history rewriting as part of routine onboarding.

Then ask for approval in plain text, not `AskUserQuestion` — a plan of eight items
does not fit four options, and forcing it there discards the per-item detail the
user needs in order to decide. Accept partial approval and apply exactly what was
approved.

### 6. Apply

Work through approved items in this order, so a failure partway through leaves the
project in a coherent state:

1. Additive local files (`CLAUDE.md`, `README.md`, `.gitignore`, `.github/` templates)
2. Claude configuration (`.claude/settings.json`, `.mcp.json`)
3. Layout moves
4. GitHub remote changes
5. User-level registration (`~/.claude/session-name-shortnames.json`)

Register the short code last, after the project's own `.claude/settings.json` carries
the matching `env` prefix. That ordering means a failure never leaves a code claimed in
the user-level map for a project that was not configured to use it.

Report each result as it happens. When a step fails, say so plainly, stop that
area, and continue with the others rather than aborting everything.

**Plugin and skill entries go through `qm set --promote`, not through an edit here**
(QM-55). `settings.json` is the tracked file, so an onboarding decision belongs in it —
that is what `--promote` is for, and it is the only path in this suite allowed to write
that file:

```bash
qm set --project <abs-path> --promote --axis plugin <id>=on|off [...]
qm set --project <abs-path> --promote --axis skill  <id>=on|name-only|user-invocable-only|off
```

One invocation per axis, each printing the whole file's diff and asking before it writes.
Pass `--yes` only where the user has already approved that exact change in step 5.

Why not edit the file directly: `qm` resolves the entry against all eight config surfaces
first, so it refuses a write that would land in a settings file Claude Code discards, one
whose `enabledPlugins` key is being ignored, or one that changes no resolved value — three
ways an edit made here would report success and do nothing. It also leaves a backup and an
undo record, which a hand-edit does not. `qm undo` reverses the last one.

`.mcp.json` is still this skill's own to write; `qm` has no axis for declaring a server,
only for enabling and disabling one.

After writing `.claude/settings.json` or `.mcp.json`, state that the change takes
effect on the **next** session — this one keeps the plugin set it started with.

**Never** commit or push as part of onboarding unless the user explicitly asks.
Leave changes in the working tree for review.

### 7. Record

Record the outcome after applying at least one change, **or when the scan found
nothing worth changing**:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/registry.sh" set "<absolute-path>" optimized "<archetype>"
```

Record nothing only when the user reviewed a real plan and declined all of it —
that deliberately leaves the offer live. A project already in good shape is
recorded as `optimized`; otherwise the hook re-offers it every session forever.

Close with a short summary of what changed, what was skipped and why, and any
follow-up worth doing later.

## Safety constraints

- Never write a secret, token, or credential into any file, including examples
- Never `git commit`, `git push`, or `git rebase` unless explicitly asked
- Never delete a file; propose a move to a `scratch/` directory instead, or list
  the file for the user to remove
- Never change repository visibility without an explicit, separate confirmation
- Treat the scan's `riskyTracked` list as a finding to report, never as something
  to auto-remediate — removing a tracked secret requires history rewriting, which
  is the user's decision alone
- When the scan reports `dirty: true`, mention the uncommitted work before
  proposing layout moves

## Additional Resources

### Reference Files

- **`${CLAUDE_PLUGIN_ROOT}/references/archetypes.md`** — Project profiles with
  per-archetype plugin sets, layout expectations, and GitHub rigor levels
- **`${CLAUDE_PLUGIN_ROOT}/references/plugin-matrix.md`** — Which plugins and MCP
  servers matter for which project types, and how to write project-scoped settings
- **`${CLAUDE_PLUGIN_ROOT}/references/claude-md-template.md`** — CLAUDE.md
  structure, what belongs in it, and what to leave out
- **`${CLAUDE_PLUGIN_ROOT}/references/github-checklist.md`** — The four GitHub
  categories with exact `gh` commands
- **`${CLAUDE_PLUGIN_ROOT}/references/layout-checks.md`** — Concrete directory
  organization checks and what to propose for each finding

These references are shared with the `audit` skill.

### Scripts

- **`${CLAUDE_PLUGIN_ROOT}/scripts/scan-project.sh`** — Deterministic scan, emits JSON
- **`${CLAUDE_PLUGIN_ROOT}/scripts/registry.sh`** — Reads and writes onboarding state
