# Claude Quartermaster

*Maintains the inventory. Issues the kit. Knows what's missing.*

[![CI](https://github.com/dean815/claude-quartermaster/actions/workflows/ci.yml/badge.svg)](https://github.com/dean815/claude-quartermaster/actions/workflows/ci.yml)

A tool for making **deliberate, defensible decisions** about how your Claude Code
workspace is configured — which plugins, MCP servers, and skills load in which
projects, and why.

Not a token-diet tool. The point is that every entry in your configuration has a
reason you'd stand behind, and that drift, redundancy, and anti-patterns get caught
before they calcify.

```bash
qm audit          # ranked findings across every project
qm cost           # what your baseline context actually costs
qm effect         # what toggling each extension needs: a reload, or a restart
qm baseline       # record today's findings
qm audit --drift  # what changed since
qm oracle         # re-ask the live binary whether the resolver is still right

qm set --project . pdf-viewer@dean815=off   # the one command that writes
qm undo                                     # put the last apply back
```

---

## Install

### As a Claude Code plugin

```
/plugin marketplace add dean815/claude-quartermaster
/plugin install quartermaster@claude-quartermaster
```

Adds two skills: **audit-workspace** (read-only) and **tune-workspace** (the write
path). Both shell out to the CLI in this repo, so there is no build step and no
`npm install` — quartermaster has zero runtime dependencies and runs from source
via `node --experimental-strip-types`.

Deliberately **not** an MCP server. An MCP server publishes its tool names into
every session's context, which is the cost this tool exists to measure.

### As a CLI

From a clone, with no install:

```bash
npm run qm -- audit
```

Or put `qm` on your PATH:

```bash
npm run build && npm link
qm audit
```

Requires Node 22.6+ for `--experimental-strip-types` (on by default from Node 23).

---

## The problem

A mature Claude Code setup accumulates configuration faster than it accumulates
reasons. A snapshot of one real workspace:

| | count |
|---|---|
| Plugins installed | 42 |
| Project entries in `~/.claude.json` | 137 |
| …that still exist on disk | 22 |
| …that are gone but still carry a deny-list | **35** |
| Skills in the listing, at its peak | 173 |
| Config surfaces that decide what loads | **8** |

### Baseline context is a distribution, not a number

Everything above is injected before you type a word. Measured across **469 sessions**
in this workspace, in characters:

| Block | median | p95 | max |
|---|---:|---:|---:|
| MCP tool names (deferred) | 1,050 | 30,860 | 34,369 |
| MCP instruction blocks | 13,265 | — | 87,836 |
| Skill listing | 10,319 | — | 39,987 |
| Agent listing | 17,492 | — | 46,128 |
| Hook output | 4,582 | — | 53,958 |

> **⚙︎ Correction —** An earlier draft of this README quoted a flat "~39,000 tokens
> per session," with the MCP block at ~17,700. That was one sample near the top of a
> **180× spread**. Servers connect asynchronously and entrypoints differ: 17% of
> sessions accumulated tools across more than one delta. A point estimate here is a
> reading, not a property of the workspace, so every figure the tool reports carries
> its sample count.

Characters, not tokens, because the conversion is content-dependent — connector tool
names are mostly UUID and tokenize near 2 chars/token, while prose descriptions run
closer to 3.7. A single ratio would be wrong in both directions.

On a large plan the dollar cost is irrelevant. **The cost that doesn't go away is
attention**: hundreds of skill descriptions competing for selection, and the same
service reachable through four different tool namespaces. The failure mode isn't a
bill — it's the wrong tool getting picked, or the right one getting missed.

That framing is Anthropic's, not ours:

> "Most best practices are based on one constraint: Claude's context window fills up
> fast, and **performance degrades as it fills**. […] Claude may start 'forgetting'
> earlier instructions or making more mistakes. **The context window is the most
> important resource to manage.**"

### A concrete example

Linear, in this workspace, is reachable **four ways at once** — verified live in the
same session, 12 times:

```
claude_ai_Linear              52 tools   1,975 chars
linear-server                 35 tools   1,192 chars
plugin_productivity_linear     2 tools     101 chars   (unauthenticated stub)
plugin_linear_linear           2 tools      89 chars   (unauthenticated stub)
```

Same-session is the whole point. Across sessions, a connector removed in March and a
plugin added in June look identical to two live duplicates — which is exactly how an
earlier pass of this research concluded Robinhood was duplicated when it never was.

Airtable and Notion show the subtler version: a claude.ai connector **plus** a plugin.
That pairing is *correct* — the connector serves claude.ai chat, which can't load
Claude Code plugins, and the plugin serves Claude Code. But Claude Code loads both, so
the fix isn't "delete one," it's "disable one **in Claude Code** while keeping the
connector for chat." Getting that distinction wrong costs you access in a surface you
weren't thinking about.

Neither case is visible from any single UI. The claude.ai connector list doesn't show
Claude Code's servers; the plugin manager doesn't show connectors.

### 47% of the largest tool-name block is UUID

claude.ai connectors namespace every tool with a 36-character UUID:
`mcp__6f1f8065-e9be-4252-b99d-84ff19549f0d__list_issues`. Across 31 connectors
publishing 447 tools, that's **16,092 characters of pure identifier** — 47% of the
largest tool-name block observed, conveying nothing to the model.

---

## What it does

### Shipped — `qm audit`, read-only

Twelve detectors over a resolved model of every extension × every project:

| Detector | What it catches |
|---|---|
| **discarded-settings** | a settings file Claude Code refuses whole, and the count of entries in it that consequently never apply — needs `--full`, which asks `claude doctor` per project |
| **duplicate-access-paths** | one service live through several namespaces at once, ranked by the *redundant* chars |
| **never-observed-server** | a configured, enabled MCP server absent from every session that could have loaded it — and a count of the ones where absence proves nothing |
| **cost-without-use** | enabled, hookless, never-invoked plugins, ranked by what disabling saves |
| **unscoped-skills** | a large skill listing with no `skillOverrides` anywhere |
| **orphaned-project-config** | deny-lists for directories that no longer exist |
| **inverted-defaults** | a global default most configured projects override |
| **restated-entries** | a project repeating the value it would inherit anyway |
| **no-path-scoped-rules** | long CLAUDE.md files with no `.claude/rules/` to defer them |
| **bare-deny-rules** | `"Bash"` invalidates the prompt cache; `Bash(rm *)` doesn't |
| **oversized-memory** | `MEMORY.md` past the 200-line / 25KB load limit |
| **imports-do-not-defer** | `@path` imports load at launch and save nothing |

…plus two expectations from the standard, which is what a project is supposed to have
decided rather than what's wrong with it:

| Expectation | Unmet when |
|---|---|
| **no-decisions-recorded** | a project inherits everything and has decided nothing — the brand-new-project case, reported with what it inherits and what that costs |
| **local-settings-not-ignored** | `settings.local.json` is tracked, so scoping edits would become commits |

Plus `qm cost` for the measured baseline distribution, and `qm baseline` /
`qm audit --drift` to turn re-onboarding into a diff.

### `qm effect` — reload or restart, and mostly reload

Toggling a skill, command, agent, hook, LSP, monitor or theme never invalidates the
prompt cache; those need `/reload-plugins` and nothing more. Two things genuinely cost
a restart: a bare-tool-name deny rule (`"Bash"`, `"*"`), and a plugin providing an MCP
server whose tools are not deferred.

Only the first is observable. Session transcripts record what was *deferred*; a tool
that loaded eagerly lands in the system prompt, which this tool does not read. Across
2,071 transcripts the one candidate signal — a server publishing MCP instructions and no
deferred tools — never held for any server in more than 31% of its sessions, and held
for none in all of them. It measures connection timing, not deferral. So the answer for
an unmeasured server is **`unknown`**, carrying the sample count, and never the scarier
guess: a tool that cries "restart" at a skill toggle is one the user learns to ignore.

### The state model: two axes, not six letters

An earlier draft used an A–F enum. It worked only while every value was binary, and
`skillOverrides` is four-valued (`on` / `name-only` / `user-invocable-only` / `off`).
The fix was to unflatten it:

```ts
type Cell<V> = {
  value:  V                                        // binary for plugins, 4-valued for skills
  origin: 'inherited' | 'overridden' | 'restated'  // where the decision came from
  chain:  Array<{ scope: Scope; value: V }>        // full precedence chain
}
```

- `inherited` — nothing set at project level → *italic*
- `overridden` — set at project, differs from what it would inherit
- `restated` — set at project to the value it would have inherited anyway → ⚠ does
  nothing today, and silently stops tracking the global default

Two values × three origins reproduces A–F exactly, so nothing was lost. Four skill
values × three origins needs no new labels.

> **⚙︎ Note —** This was flagged as blocking before the resolver was written, and
> resolving it first was the right call — it's a two-line change at design time and a
> rewrite afterwards.

### Correctness gate

The resolver is checked against an external oracle rather than hand-written
expectations: `claude plugin list --json` reports `enabled` already resolved for its
working directory. **924 (plugin, project) pairs across 22 projects, zero mismatches.**

> **⚙︎ Note —** And then a negative control, which mattered more. Deliberately broken
> resolvers were fed to the same oracle: one that ignores project settings was caught
> (12 mismatches), one that ignores `settings.local.json` was **not** — 0 of 924 —
> because no project here sets `enabledPlugins` there. "100% agreement" covered two of
> three scopes. Synthetic fixtures close the gap, and mutation testing confirms it:
> removing local-scope handling now fails 6 tests.

That gate runs two ways — live where the CLI exists, and against a recorded fixture
everywhere. Both catch **our** regressions. Neither can catch **theirs**: a recording
agrees with itself forever, so a green replay only proves the resolver still matches the
release the fixture was captured from.

`qm oracle` is the other half. It re-asks the live binary on a weekly schedule
(`scripts/install-oracle-schedule.sh` installs a launchd agent; `qm` never installs,
loads, or writes one — that would be a live-environment write). It **prints nothing when
the answers still match**, and files a single Linear issue when they don't, deduplicated
on exactly which pairs disagree. Because silence is the healthy signal, a silent job and
a dead one look identical — so every run leaves a timestamp behind and `qm oracle
--status` is how you ask which one you have.

> **⚙︎ Note —** It checks **one** of four reverse-engineered behaviours: the
> per-directory `enabled` resolution. `claude plugin details` output, the usage-counter
> semantics, and MCP tool-name loading can all change without this noticing. "The oracle
> agrees" is not "drift is handled," and every place this reports says so.

### `qm set` — the one command that writes

Everything above is read-only. `qm set` is not, and it is deliberately narrow: **plugin
toggles, one project, one file** — `<project>/.claude/settings.local.json`. It never
writes `~/.claude.json`, and it writes a tracked `settings.json` only under `--promote`
(QM-55), which is how an onboarding decision reaches the repo rather than one machine.
Both are named in the last guard before any byte lands, so breaking either promise fails
loudly rather than silently.

```
qm set --project <path> <plugin-id>=on|off [...] [--yes]
qm undo
```

One invocation, several targets, one diff, one confirmation, one write. There is no
stage-to-disk / apply-later mode — that is a state machine with its own staleness and
abandonment problems, and nothing here needs one.

It **refuses** rather than write when:

| | why |
|---|---|
| Claude Code discards the target file | the write parses, reports success and changes nothing |
| `claude doctor` reported on it in words this release cannot place | it *might* be discarded, and a write that might not land is worse than no write |
| a schema error names `enabledPlugins` | the key would be ignored even though the rest of the file applies |
| the plugin already resolves to the value you asked for | the entry would do nothing, and `restated-entries` would then report it |
| the project *is* `~` | the home directory's project-scope local file **is** the user-scope one |

It **warns and proceeds** when `git check-ignore` says the target is not ignored. Measured
across the 17 repositories under `~/claude`: 6 name `settings.local.json` in their own
`.gitignore`, and 11 rely on `~/.config/git/ignore` — a rule that exists on one machine.
In a cloud session or a fresh clone, those 11 would commit local configuration on the next
`git add -A`.

After applying, it prints `qm effect`'s verdict for the change — `reload`, `restart`,
`unknown` or `none` — and not a blanket "takes effect next session", which is false for a
toggle `/reload-plugins` picks up.

Backups are timestamped pre-images in `${XDG_STATE_HOME:-~/.local/state}/claude-quartermaster/backups/`,
beside `baseline.json` and `oracle-run.json`. `qm undo` restores the last one, once, and
refuses if the file has changed since — restoring over someone else's edit would be this
tool silently reverting a change it did not make. Nothing is ever deleted: a target `qm set`
created is undone back to the empty settings file it was created as.

### Not yet

Skills (`skillOverrides`) and MCP servers (`disabledMcpServers`) are separate issues, and
so is the grid's add/remove — wiring those controls means the loopback server accepting
`POST` for the first time, which brings CSRF, origin checks and the fact that any local
process can reach it. That is a real security surface for a tool whose identity is
read-only, and it is orthogonal to the write logic. The grid's controls stay disabled.

The two-view grid UI is Phase 1b — presentation over a model that had to be correct
first.

---

## What it delegates, and why

Quartermaster owns extensions, cost, and cross-project resolution. It does not own
CLAUDE.md quality, git hygiene, or project layout — `/doctor` and `project-optimizer`
already do those, and a second opinion drifts from the first the moment either is
edited.

| Domain | Owner | How |
|---|---|---|
| Extensions, cost, cross-project resolution | **qm** | native |
| Unused extensions, memory bloat, slow hooks, permissions, CLAUDE.md trims | `/doctor` | in-session only |
| Git hygiene, GitHub setup, layout facts | `project-optimizer` | its `scan-project.sh`, JSON out, no agent session |
| Onboarding judgement (blocking / gap / polish), archetypes | `project-optimizer:audit` | in-session only |
| Dead project entries | qm detects, `claude project purge` fixes | first-party |

**The line is drawn at objectivity.** Quartermaster states findings that are true by
definition — a tracked credential file, a public repo with no license, a repo with no
`.gitignore`. Anything needing taste stays with the skill that owns it.

**Unexamined is never reported as clean.** Every domain nothing checked is named in
the output, with the command that would check it.

> **⚙︎ Note —** `/doctor` can't be reached from a CLI, which the plan originally
> assumed it could. `claude doctor` is installation-only; `claude -p "/doctor"` returns
> nothing at one turn because it's agentic, and granting enough turns to answer also
> grants enough to apply fixes. An audit tool must not mutate config as a side effect
> of reporting.

---

## Non-goals

- **Minimizing tokens.** Cost is an input to a decision, not the objective. A widely-useful plugin whose always-on cost is a rounding error should stay on everywhere.
- **Per-project *agent* scoping.** Claude Code has no such mechanism for agents. Skills *are* scopable, via `skillOverrides`.
- **Measuring baseline context.** The `context-audit` skill already does this well, and documents four traps that each produce a confident wrong answer. Quartermaster consumes that method rather than reinventing it; what it adds is per-server attribution and cross-project aggregation.
- **Pricing plugin components.** `claude plugin details` already does it locally, including for third-party plugins absent from the catalog.
- **Replacing built-ins.** What this adds is **cross-project** views, **cost as a first-class dimension**, and the **MCP surface nothing else prices**.

---

## Key findings

Each of these changed a decision.

**First-party prices everything except the biggest thing — and says so.**
`claude plugin details github` prints `MCP servers (1) github (tool schemas resolved
at runtime; not counted)` and `Always-on: ~0 tok`. That's correct about *schemas*,
which resolve lazily. But tool **names** load at startup, and they were 34,369 chars
in one measured session. That gap is the whole project.

**The two usage counters do not mean the same thing.** A controlled test settled
`skillUsage`: read `gsd-help` at 1, invoke it once, read again — 2. It counts
invocations. `pluginUsage` does not: 8 of the 10 plugins that ship hooks have a
non-zero count, against 2 of the 32 that don't, and `warp` reads **9,068 against 97
recorded startups**. That's hook firings. So "never used" is only claimed for plugins
whose hook count is exactly 0.

> **⚙︎ Note —** Two traps found alongside it. `lastUsedAt` advances without
> `usageCount` moving, so it marks last *seen*, not last used. And `numStartups`
> doesn't count `claude -p` sessions, so anything built on `lastUsedNumStartups`
> undercounts.

**Unauthenticated servers cost almost nothing.** The intuition — widely repeated, and
present in one of my own reference notes from a different machine — is that you pay
listing cost for capability you can't invoke. Here it's **3 sessions out of 469**.
An unauthenticated server mostly publishes no tool names at all.

**Plugins, MCP servers, and skills can all be scoped per project.** Agents are the
only type with no per-project mechanism.

**`settings.local.json` is gitignored automatically**, in 13 of 13 repos checked —
Claude Code adds it to the *global* git excludes file. This is why batch edits across
every project produce zero git churn.

**Settings merge per-key across five scopes** — Managed > CLI args > Local > Project >
User. A plugin can be enabled at project level with no global entry at all.

**Plugin toggles are not a security boundary.** They control *loading*, not
*authority*. The correct lever is `permissions.deny`, which **merges across scopes
rather than overriding**, so it can't be silently undone by a lower-precedence file.

**`~` is registered as a project, and it breaks two different layers.** Its
`.claude/settings.json` *is* the user-scope file, so without deduplicating chain links
by resolved path, all 42 global plugins read as `restated` — 42 fabricated findings.
And scanning it walks the entire home tree, which made every full run take exactly the
60-second timeout.

---

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| **0** | Research, config-surface mapping, repo setup | ✅ done |
| **1** | Resolver, cost engine, detectors, `qm audit` | ✅ done |
| **1b** | The two-view grid UI over the same model | next |
| **2** | Staged writes, diff review, backups, undo | ✅ v1: plugins, CLI |
| **3** | Mechanism decision framework — plugin vs bare MCP vs CLI vs SDK | researched |
| **4** | Product database — capability gaps from services you already use | deferred |

Onboarding is deliberately absent from this list. It isn't a phase — **a project is
onboarded when its audit is clean, and drift is findings coming back.** The four
moments (new project, existing repo, re-onboarding, deciding what a project warrants)
are one code path against a standard; only the starting state differs.

### Anti-pattern prevention

One narrowly-scoped hook, in Phase 2: a **`PostToolUse` matcher on `Write|Edit`
against `**/.claude/settings*.json`** that flags redundant entries as they're written.

> **⚙︎ Note —** Deliberately *not* a `SessionStart` hook. Those fire every session and
> cost baseline tokens forever, to report a condition that changes rarely — your
> existing hooks already emit a 4,582-char median. A tool that exists to make
> configuration deliberate shouldn't quietly add to the load.

---

## Success criteria

1. **You can open any project and articulate why each extension is on or off — and the tool agrees.**
2. Zero *redundant* access paths — every service resolves one way per surface, and where a service legitimately needs both a connector and a plugin, that's a recorded decision rather than an accident.
3. Zero redundant entries; global defaults point the right direction.
4. A new project reaches a defensible baseline in one pass, without the manual sequence.
5. You can answer "plugin, MCP, CLI, or SDK?" from a written rule rather than a guess.

> **⚙︎ Note —** Criterion 1 is the real one. The others are how you get there. None of
> them mention tokens, which is the point of the reframe.

---

## Architecture

```
surfaces/  →  resolve  →  detect  →  delegate  →  cli
(8 readers)   (value ×    (10 pure   (/doctor,    (audit, cost,
              origin)     functions)  proj-opt)    baseline, drift)
                   ↑            ↑
                   |       cost/ (transcript measurement, plugin details, aggregation)
              oracle (the live-vs-resolver comparison, shared by the differential
                      suite and the weekly scheduled check)
```

TypeScript + Node, ESM, zero runtime dependencies. Tests run on `node:test` against a
redacted snapshot of a real workspace, because the shapes that break a resolver are
the awkward ones and they're hard to imagine before meeting them.

`qm audit` runs in ~1.2s warm; `--full` in ~4.8s across 22 projects.

---

## Why "Quartermaster"

The role maps to every phase. A quartermaster maintains the inventory, issues
equipment according to the mission rather than by default, knows what's in stock and
what's missing, and is accountable for the whole kit. That is the extension grid,
per-project scoping, capability-gap discovery, and defensibility — in one word.

CLI binary: `qm`.

## License

MIT
