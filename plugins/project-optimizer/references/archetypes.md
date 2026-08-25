# Project Archetypes

Reusable profiles that collapse most of the onboarding interview into a single
confirmation. Match the scan output against the signals below, state the inferred
archetype, and let the user correct it.

Archetypes are a starting point, not a straitjacket. When a project sits between
two, say so and take the stricter GitHub posture of the pair.

## Classify in this order

Check the first two before attempting any code archetype. Matching a directory
with no code against a code profile produces a confident, useless plan.

1. **`empty`** — `layout.contentFiles == 0`. Nothing to onboard.
2. **`context-workspace`** — `layout.sourceFiles == 0`. No code, whatever else is
   present. With `docFiles > 0` it is a notes directory; with `docFiles == 0` it
   holds only stray config or data and is closer to empty.
3. Everything else — match the signal table below.

`layout.contentFiles` excludes dependency trees, build output, and tooling state
belonging to Claude rather than the project (`.remember/`, `.claude/`). A
directory holding one `settings.local.json` counts as empty, which is what it is.

**Absence of git is not a signal here** — plenty of real projects are never
initialized. Use `sourceFiles`, which counts code, config-as-code
(`Dockerfile`, `*.yml`, `*.toml`), markup, and notebooks.

## Signal table

| Archetype | Primary signals from scan |
|---|---|
| `empty` | `contentFiles == 0` |
| `context-workspace` | `sourceFiles == 0` |
| `claude-plugin` | `.claude-plugin/plugin.json`, `skills/`, `agents/`, `hooks/hooks.json` |
| `mcp-server` | `mcp-sdk` in frameworks, `@modelcontextprotocol` dep, `fastmcp`, server entrypoint |
| `web-app` | `next`, `react`, `vue`, `svelte`, `astro`, `remix`, `nuxt`, `vite` in frameworks |
| `cli-tool` | `bin` field in package.json, `[project.scripts]` in pyproject, single entrypoint |
| `library` | Package manifest with no `bin`, published name, `exports`/`__init__.py` |
| `data-analysis` | `notebooks` in stack, `pandas`/`polars`/`jupyter`, `data/` directory |
| `automation` | Loose scripts, no manifest or minimal one, cron/n8n/webhook references |
| `experiment` | Few commits, no README, no remote, scratch-shaped names |

## Profiles

### empty

No content at all — often a directory created for a Claude conversation that
never produced files.

**Do not onboard.** There is nothing to configure, and creating a CLAUDE.md,
README, or git repo for an empty directory manufactures work rather than
resolving any. Say the directory is empty and offer `project-optimizer:skip`.

### context-workspace

Notes, research, specs, and conversation artifacts. No source code. Common when a
directory exists to give Claude a place to think about a system whose code lives
elsewhere — or is not code at all.

- **Plugins**: leave global defaults. There is no build, test, or language here,
  so language and domain scoping have nothing to act on
- **MCP**: leave alone
- **CLAUDE.md**: the *only* thing worth proposing, and only when the directory has
  real accumulated content. Two or three sentences: what this workspace is for,
  where the actual system lives if it lives elsewhere, and what not to look for
  here. Nothing more
- **Layout**: no expectations. Notes directories are organized by their author's
  memory, and imposing `src/`-style structure on them is actively unhelpful
- **GitHub rigor**: none. Do not propose `git init`, and do not propose a remote

The correct outcome is usually **`skip`**, or at most a short CLAUDE.md. Say so
directly rather than assembling a plan that mostly reads "not applicable".

Two cautions specific to this archetype:

- A workspace can accumulate credential files (`.env`, `*-secrets.env`) without
  git ever noticing, because `riskyTracked` only inspects **tracked** files. If
  such a file is present and the directory is not a repo, mention it — not as a
  leak, but as a reason not to run `git init` here casually.
- Do not confuse this with a real project that simply lacks git. A directory with
  a `docker-compose.yml` and three shell scripts is infrastructure, not notes:
  `sourceFiles > 0` means classify it normally.

### claude-plugin

Building Claude Code plugins, skills, agents, or marketplaces.

- **Plugins**: `plugin-dev`, `skill-creator`, `hookify`, `commit-commands`
- **MCP**: none needed; plugin development is filesystem work
- **CLAUDE.md emphasis**: component inventory, the testing loop
  (`claude --plugin-dir .`), and the reload-requires-restart constraint that
  otherwise wastes debugging time
- **Layout**: `.claude-plugin/plugin.json`, `skills/<name>/SKILL.md`, `agents/`,
  `hooks/`, `scripts/`, `README.md`
- **GitHub rigor**: medium. Public if shared — then license and topics matter for
  marketplace discovery

### mcp-server

Model Context Protocol servers exposing tools to Claude and other clients.

- **Plugins**: `mcp-server-dev`, language LSP, `commit-commands`, `code-review`
- **MCP**: the server under development, pointed at the local build
- **CLAUDE.md emphasis**: tool inventory with signatures, transport (stdio vs SSE),
  required env vars **named but never valued**, and the local run command
- **Layout**: `src/`, `tests/`, `.env.example` (committed), `README.md` with client
  configuration examples
- **GitHub rigor**: high when public. Secret scanning matters more here than
  almost anywhere — MCP servers accumulate API credentials

### web-app

Front-end or full-stack web applications.

- **Plugins**: `frontend-design`, `playwright`, language LSP; `figma` only when
  designs actually live in Figma; `chrome-devtools-mcp` for debugging sessions
- **MCP**: `supabase` / `vercel` only when the project actually uses them
- **CLAUDE.md emphasis**: dev server command, routing convention, component
  location, styling system, and where **not** to put new components
- **Layout**: `src/` or `app/`, `public/`, `components/`, `tests/` or `e2e/`
- **GitHub rigor**: high when deployed. CI and branch protection earn their keep
  once a broken main means a broken site

### cli-tool

Command-line tools, personal or published.

- **Plugins**: language LSP, `commit-commands`, `code-review`
- **MCP**: none typically
- **CLAUDE.md emphasis**: the command surface, argument conventions, and how to
  run the tool locally without installing it
- **Layout**: `src/` or `bin/`, `tests/`, `README.md` with usage examples
- **GitHub rigor**: medium; high once published to a package registry

### library

Reusable packages intended for other code to import.

- **Plugins**: language LSP, `code-review`, `commit-commands`
- **MCP**: none
- **CLAUDE.md emphasis**: the public API surface and what is deliberately private,
  backward-compatibility expectations, and the release process
- **Layout**: `src/`, `tests/`, `docs/`, `CHANGELOG.md`
- **GitHub rigor**: highest. Consumers depend on the repo's contract — license,
  semver discipline, CI on every PR, and branch protection all matter

### data-analysis

Notebooks, pipelines, and exploratory analysis.

- **Plugins**: `pyright-lsp`, `data` plugins where connected
- **MCP**: warehouse or database connectors the project genuinely queries
- **CLAUDE.md emphasis**: data sources and their location, which notebooks are
  canonical versus exploratory, and any rule against committing data
- **Layout**: `notebooks/`, `data/` (usually gitignored), `src/`, `outputs/`
- **GitHub rigor**: low to medium, but `.gitignore` discipline is critical —
  datasets and credentials leak from this archetype more than any other

### automation

Personal glue: scripts, scheduled jobs, webhook handlers, home automation.

- **Plugins**: minimal. Language LSP and `commit-commands`
- **MCP**: whichever service the automation targets
- **CLAUDE.md emphasis**: what triggers it, what breaks if it stops, and where
  credentials live — usually the single most valuable thing to write down, because
  this archetype is the one most often revisited after months away
- **Layout**: flat is fine; a `scripts/` directory once past a handful of files
- **GitHub rigor**: low, but private-by-default unless deliberately public

### experiment

Throwaway or exploratory work.

- **Plugins**: leave global defaults; not worth scoping
- **MCP**: leave alone
- **CLAUDE.md emphasis**: one paragraph on what is being tried and why. Nothing more
- **Layout**: no expectations
- **GitHub rigor**: none. Do not propose creating a remote

For this archetype, propose the smallest possible change set — often just a short
CLAUDE.md — and consider suggesting `skip` with a snooze instead. Onboarding a
scratch directory is overhead that produces nothing.

## Choosing GitHub rigor

Rigor follows audience, not archetype alone. Confirm with the user rather than
assuming from file layout:

| Audience | Rigor | Means |
|---|---|---|
| Just the user, private | Low | `.gitignore`, README, no committed secrets |
| Shared with a few people | Medium | Above, plus license, description, CI |
| Public or depended upon | High | Above, plus branch protection, PR template, CODEOWNERS, Dependabot, secret scanning |
