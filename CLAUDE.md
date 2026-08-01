# Claude Quartermaster

Local web GUI for auditing and editing which Claude Code extensions (plugins, MCP
servers) are enabled per project, with baseline token cost per extension.

## Architecture

Four config surfaces decide whether an extension is active. They do not share a
mechanism:

| Surface | Location | Controls |
|---|---|---|
| Global plugins | `~/.claude/settings.json` → `enabledPlugins` | on/off everywhere |
| Project plugins | `<proj>/.claude/settings{,.local}.json` → `enabledPlugins` | per-project override |
| MCP servers | `~/.claude.json` → `projects[<abspath>].disabledMcpServers` | flat deny-list; covers claude.ai connectors, `plugin:X:Y`, and user servers |
| Project MCP | `.mcp.json` + `enabled/disabledMcpjsonServers` | project-declared servers |
| Skills | `settings{,.local}.json` → `skillOverrides` | per-skill, 4 states: `on` / `name-only` / `user-invocable-only` / `off` |
| Rules | `.claude/rules/*.md` | `paths:` frontmatter ⇒ loads only on matching files |
| Auto memory | `~/.claude/projects/<proj>/memory/MEMORY.md` | first 200 lines or 25KB load every session |

Plugin precedence: `settings.local.json` > `settings.json` > `~/.claude/settings.json`.
Render this chain, not a flat three-state — a project can hold a value in both its
tracked `settings.json` and its local override.

## Conventions

- Writes go to `<proj>/.claude/settings.local.json` (gitignored in 13/13 of Dean's
  repos). Never write `settings.json` without an explicit promote action.
- Edits stage in memory and apply as one reviewed batch, never on click.
- JSON edits are surgical: change only target keys, never rewrite a file.

## Decisions

**Delegate, don't reimplement — and draw the line at objectivity.** `project-optimizer`
owns onboarding; quartermaster calls its `scripts/scan-project.sh` (JSON out, read-only,
no agent session) for *facts*, and reports only findings that are true by definition:
a tracked credential file, a public repo with no license, a repo with no `.gitignore`.
The Blocking/Gap/Polish ranking is the skill's judgement and is **not** duplicated here —
two copies of a rubric drift the moment either is edited. Judgement is reported as
`needs-session` with the command to run.

**`/doctor` cannot be reached from a CLI.** `claude doctor` the subcommand is
installation-only. `claude -p "/doctor" --max-turns 1` returns nothing because it's
agentic, and granting it enough turns to answer also grants it enough to apply fixes.
An audit tool must not mutate config as a side effect of reporting, so the adapter
never shells out to it.

**Usage counters mean different things.** `skillUsage.usageCount` is a true invocation
count (verified: invoked `gsd-help` once, counter went 1 → 2). `pluginUsage.usageCount`
is dominated by hook firings — 8 of 10 hook-providing plugins are non-zero vs 2 of 32
without, and `warp` reads 9,068 against 97 startups. Only claim "never used" for a
plugin whose `Hooks` count is **0**; an absent Hooks key means "couldn't tell", not zero.

**Report distributions, not point estimates.** Baseline context is not a workspace
property. Across 469 sessions the MCP tool-name block ran 192 → 34,369 chars
(median 1,050). Always carry the sample count.

## Gotchas

- **`~` is registered as a project, and it breaks things in two different layers.**
  Its `.claude/settings.json` *is* the user-scope file, so without deduplicating chain
  links by resolved path every global plugin reads as `restated` (42 false findings).
  And scanning it walks the whole home tree — that made every `--full` run take exactly
  the 60s timeout. Excluded from scanning via `isScannable`.
- **`numStartups` doesn't count `claude -p` sessions**, so anything built on
  `lastUsedNumStartups` undercounts. `lastUsedAt` advances without `usageCount` moving —
  it marks last *seen*, not last used.
- **Don't measure baseline context yourself.** `~/.claude/skills/context-audit` already
  does it and documents four traps that each produce a confident wrong answer.

- Changes take effect on the **next** session; the running one keeps its startup set.
  Editing CLAUDE.md mid-session does **not** apply — it reloads on `/clear`,
  `/compact`, or restart.
- `~/.claude.json` is ~200KB and every live session writes telemetry to it
  (`lastCost`, `lastSessionId`). Check mtime+hash around staging; refuse to apply
  if it moved.
- **Agents** have no per-project toggle. **Skills do** — via `skillOverrides`.
  71 of 87 personal skills are `gsd-*`, managed by GSD's own `gsd-surface`.
- `@path` imports in CLAUDE.md do **not** save context — imported files load at launch.
  Path-scoped `.claude/rules/` is the mechanism that actually defers loading.
- Toggling a plugin is cache-safe unless it provides an MCP server whose tools aren't
  deferred. A bare-tool-name deny rule (`"Bash"`, `"*"`) invalidates the cache;
  scoped rules like `Bash(rm *)` don't.

## Do not

- Never write `~/.claude.json` without the concurrent-write check.
- Never assume an extension type is per-project toggleable; check the table above.
- Never treat a plugin toggle as a security boundary — it controls loading, not
  authority. Use `permissions.deny`, which merges across scopes rather than overriding.
