# Constructing a CLAUDE.md

## The governing principle

CLAUDE.md is loaded into context on **every** session in the project. It is a
standing tax on the context budget, so every line must earn its place by saving
more than it costs.

The test for any line: **would Claude get this wrong or waste turns discovering it
otherwise?** If the answer is no, cut it.

This makes most CLAUDE.md files too long rather than too short. A precise 40-line
file beats a comprehensive 300-line one, because the 300-line version dilutes the
handful of facts that actually change behavior.

## What earns a place

**Commands that cannot be guessed.** Not `npm test` — that is inferable from
`package.json`. Yes to `npm run test:integration -- --runInBand` when the obvious
invocation hangs.

**Conventions that differ from the default.** The framework's normal layout is
already known. Write down where this project deviates from it.

**Constraints with consequences.** "Migrations run automatically on boot in dev —
do not run them manually or the schema drifts." Things that cause real damage when
violated.

**Gotchas that cost time.** The test suite needing a running Redis. The build
failing silently without an env var. The plugin reload requiring a full restart.
These are the highest-value lines in any CLAUDE.md.

**Boundaries.** What not to touch: generated files, vendored code, that one module
being deliberately left alone during a migration.

## What does not earn a place

**What the code does.** It is readable. A prose summary goes stale and competes
with the source for authority.

**Full API documentation.** Belongs in `docs/` or docstrings, loaded on demand.

**Project history or changelog.** Belongs in git and `CHANGELOG.md`.

**Generic engineering advice.** "Write tests, use clear names, handle errors" —
this is already known and dilutes what is specific.

**Aspirational rules nobody follows.** If the codebase does not obey it, writing
it down creates a contradiction between the file and the code, and the code wins.

**Anything derivable from a manifest.** Dependencies, scripts, the language.

**Secrets, tokens, or credentials.** Ever. Name the variable, never the value.

## Structure

Order sections by how often they change behavior. Keep headings short — they are
scanned, not read.

```markdown
# <Project Name>

<One or two sentences: what this is and who it is for.>

## Commands

| Task | Command |
|---|---|
| Dev server | `...` |
| Test | `...` |
| Build | `...` |
| Lint | `...` |

## Architecture

<Only the non-obvious shape: how the main pieces relate, where the boundaries
are, what depends on what. Two to five sentences, not a diagram of every file.>

## Conventions

- <A rule this project follows that a competent engineer would not assume.>
- <Where new code of a given kind belongs.>

## Gotchas

- <Something that fails confusingly, and what to do about it.>

## Do not

- <Files or areas to leave alone, and why.>
```

Omit any section with nothing real to put in it. An empty "Conventions" heading is
worse than no heading — it implies the project has none.

## Per-archetype emphasis

| Archetype | The section that matters most |
|---|---|
| `claude-plugin` | Gotchas — the restart-to-reload constraint wastes hours otherwise |
| `mcp-server` | Commands and env var names — how to run it against a real client |
| `web-app` | Conventions — where components go and how styling is organized |
| `library` | Do not — the public API contract and what must stay stable |
| `data-analysis` | Do not — which data must never be committed |
| `automation` | Architecture — what triggers it and what breaks when it stops |
| `experiment` | One paragraph. Nothing else |

## Improving an existing CLAUDE.md

When the project already has one, **do not rewrite it from scratch.** The existing
file encodes decisions whose reasons are not visible in the text.

Prefer delegation: when the `claude-md-management` plugin is installed, invoke its
`claude-md-improver` skill, which is purpose-built for auditing and improving an
existing file.

Improving directly, work additively:

1. Read it fully
2. Verify each claim against the codebase — stale instructions are worse than
   missing ones, because they are followed confidently
3. Flag contradictions with observed reality and propose corrections
4. Add only what is missing and passes the earns-its-place test
5. Propose cuts for anything derivable, generic, or stale — but as a proposal,
   never a silent deletion

Report a large existing file (over ~200 lines) as a finding worth addressing, and
show which specific sections could be cut and why. Do not simply truncate it.

## Nested CLAUDE.md files

In a monorepo, a `CLAUDE.md` in a subdirectory loads when work happens there.
Prefer a lean root file plus focused per-package files over one large root file
that covers every package — the per-package facts then cost nothing when working
elsewhere in the repo.
