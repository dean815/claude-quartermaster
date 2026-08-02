# Differential fixture

A real workspace's plugin configuration, paired with the answer
`claude plugin list --json` gave for the same projects, anonymised hard enough to
commit. It lets the differential gate — which otherwise only runs on a machine with
the Claude Code CLI and a populated `~/.claude.json` — be replayed in CI.

```
home/                       the fixture HOME; point loadWorkspace at it
  .claude/settings.json     user scope, and also `~`-the-project's project scope
  .claude/settings.local.json
  .claude/skills/skill-NN/  one constructed personal skill, scoped by nothing
  .claude.json              project entries, keyed by anonymised path
  .mcp.json
  proj-NN/…                 captured project directories
  probe-local-*/…           constructed input, observed expectation — see Provenance
  probe-skill-chain/…       constructed input, resolver-checked expectation — ditto
oracle.json                 { <fixture path>: [{ id, enabled }] }
manifest.json               coverage counts; assert against these, not against prose
load.ts                     how to point loadWorkspace at all of the above
```

## Using it

```ts
import { loadFixtureWorkspace, readOracle } from './fixtures/differential/load.ts';
```

Coverage assertions should read `manifest.json` rather than hardcode a constant — the
generator writes it, so a regenerated fixture updates the expectation and a shrinking
one shows up as a diff in a tracked file instead of a number nobody touched.

Two things will bite a consumer that skips `load.ts` and calls
`loadWorkspace({ home })` directly:

- **Recorded paths are synthetic.** The fixture's projects live under
  `/Users/testuser`, which exists nowhere, so every entry resolves as dead and the
  gate compares nothing. `load.ts` passes the `projectPathResolver` that rebases that
  prefix onto `home/`.
- **`ProjectRecord.path` stays the recorded path.** Filter live projects on
  `p.alive`, never on `existsSync(p.path)` — `p.alive` already carries the resolved
  answer, and `existsSync` on `/Users/testuser/proj-01` is always false.

There are no worktree entries to filter: the generator drops them, because the live
gate drops them too.

## Regenerating

```bash
node --experimental-strip-types scripts/make-differential-fixture.ts
```

It reads this machine's config, runs the CLI once per live project, and rewrites
`home/` and `oracle.json`. This file is prose and survives. Do not hand-edit the
generated files — the fixture's value is that it is a capture, and a hand-tuned one
drifts from the machine it claims to describe.

The skills half is written from literals in the generator rather than read off a machine,
so it regenerates byte-identically anywhere, on a machine with no skills at all. That
makes it the one part a reader might be tempted to edit in place; don't. A fixture the
generator would not reproduce is a fixture nobody can regenerate, and the literals are
where the four values and the three-scope chain are chosen.

## Why this one is committed when `local-snapshot/` is not

`local-snapshot/` rewrites `$HOME` to `/Users/testuser` and stops there, which
anonymises *who* you are and not *what* you work on — see `../README.md`. Every
project directory name survives it, and directory names are the disclosure.

Here the names go too. Projects become `proj-NN`, MCP servers become `srv-NN`, both
assigned by sorting the real names first so a regeneration against an unchanged
machine is a no-op diff rather than a reshuffle. Renaming servers through a single
map is what preserves the case where a server is declared in one file and switched on
from another: rename them apart and that case evaporates.

**Plugin ids stay verbatim.** They are what the gate compares, and a
`name@marketplace` id is a public coordinate.

Redaction is allowlist-first, as in `scripts/make-fixtures.ts`: a value is dropped
unless a rule names it, so a key nobody anticipated cannot leak. What that keeps is
`enabledPlugins`, the four MCP list keys, `hasTrustDialogAccepted`, `numStartups`, and
a server's transport `type`. What it drops includes `permissions`, `hooks`,
`statusLine`, `allowedTools`, every server `url`/`command`/`args`/`env`, all
per-project telemetry, and both usage tables. `CLAUDE.md` and `.claude/rules/` are
never copied at all — they are prose, and prose is identifying.

**`skillOverrides` is dropped too, and the skill axis is constructed instead.** A skill
id names what someone works on as surely as a directory does, and `~/.claude/skills/`
holds directories named the same way. So no captured override and no captured skill
directory reaches this tree; the ids here are `skill-NN`, written by the generator, and
they are merged into the settings files *after* redaction rather than passed through it.
Widening the allowlist must never become the way a skill reaches the fixture.

## What it captures

Counts live in `manifest.json`, written by the same run that writes the tree, so they
cannot disagree with it. Restating them here would create a second number to update
and a first one to forget.

`manifest.json` carries `projectEntries`, `oracleProjects`, `pairs`, `plugins`,
`probeProjects`, `skillProbeProjects`, `skillIds`, and `decidedByScope`. **`decidedByScope` counts the scope that *won*
each pair** — `chain.at(-1)` — which is deliberately stricter than "a file at this
scope had an opinion". A pair where project scope is overruled by local is not
protecting project scope from anything, and counting it as though it were is how a
scope ends up with a gate that cannot fail.

## Structural cases it preserves

**`~` is itself a project, and its project-scope settings file *is* the user-scope
file.** Entry `/Users/testuser` in `.claude.json`; both scopes read
`home/.claude/settings.json`. Because the rebasing resolver maps `/Users/testuser` to
the fixture home itself, the two scopes arrive at a byte-identical path string — the
collision is reproduced by construction rather than by a special case. A resolver that
does not deduplicate chain links by resolved path reports all 42 global plugins as
`restated` here.

**Projects carrying both `settings.json` and `settings.local.json`.** `proj-06`,
`proj-44`, `proj-50`, `proj-53`, plus `~` itself. `proj-53` is the interesting one of
the captured set: it holds `enabledPlugins` in its tracked settings and a local
override file alongside.

**Local scope deciding a pair, in both directions.** `probe-local-disable` turns off a
plugin the user scope turns on. `probe-local-enable` turns on a plugin its own
`settings.json` turns off — the only project here setting `enabledPlugins` in both
files. Without these, local scope decided nothing: demoting `local` below `user` in
`precedenceOf` produced zero mismatches, so the highest-precedence file surface — the
one Phase 2 writes to — had a gate that could not fail. With them that mutation
produces two mismatches, one per direction. See Provenance below for what they are.

**Dead entries that still hold a deny-list.** Ten of the 43 dead entries carry a
non-empty `disabledMcpServers` — `proj-08`, `proj-09`, `proj-10`, `proj-46` among
them. They have no directory in `home/`, which is what makes them dead; nothing marks
them.

**A project-declared server switched on from a different file.** `home/.mcp.json`
declares `srv-24`; `home/.claude/settings.local.json` enables it through
`enabledMcpjsonServers`. Neither file alone answers the question. `proj-56` is the
negative case: it declares `srv-26` and nothing turns it on.

**Project-scope plugin overrides.** `proj-48`, `proj-49` and `proj-53` set
`enabledPlugins` themselves. Without them the gate would only ever exercise the user
scope, and would pass against a resolver that ignored project settings entirely.

**A four-valued setting, at every value and every origin.** `probe-skill-chain` and the
user-scope `skillOverrides` block put all four of `on`, `name-only`,
`user-invocable-only` and `off` on the wire, and all three of `inherited`, `overridden`
and `restated`. `skill-03` is set at user, project *and* local scope — the three-link
chain the plugin axis still lacks — and `skill-04` is turned off at project scope and
restated back to the default at local, so local scope decides pairs here in both
directions, as `probe-local-*` makes it do for plugins. Plugins and MCP servers are
two-valued, so before this the axis `Cell<V>` was designed for was the one axis nothing
end-to-end touched: an A–F enum can express those two and cannot express this one.

**A skill nobody scoped.** `home/.claude/skills/skill-06/` is on disk and named by no
settings file. It is a row anyway, which is the property DEA-134 added: deriving the
axis from `skillOverrides` made the grid circular, since a skill appeared only once
someone had scoped it and scoping is what the grid is for. Every other skill here is a
row because a settings file names it, so without this one the fixture would only ever
exercise the circular source.

## Provenance

Everything here is one of three kinds, and the differences are worth being precise
about.

**Captured** — `proj-NN` and `~`. Both the configuration and the expectation were found
on a real machine.

**Constructed input, observed expectation** — `probe-local-*`, listed in
`manifest.json` as `probeProjects`. The *configuration* was written by the generator,
because no project on the captured machine sets `enabledPlugins` in a
`settings.local.json`. The *expectation* was not written by anyone: the generator
materialises that configuration in a scratch directory, runs the real
`claude plugin list --json` in it, and records whatever comes back.

The two kinds differ in where the input came from. They do not differ in how the
expectation was obtained — in both cases the oracle is the sole source of truth, and
no human has written an expected value anywhere in this file. That is the property the
gate rests on: hand-written expectations only prove the resolver agrees with whoever
wrote them, and hand-deriving what we *believe* the resolver should say for a
constructed case would forfeit exactly that. Constructing an input the machine happened
not to contain does not.

So the rule is not "never synthesise" — it is **never author an expectation**. A case
the machine lacks is a hole in the gate; the honest fix is to build the input and let
the oracle answer for it.

Which leaves the surface where there is no oracle to let answer.

**Constructed input, resolver-checked expectation** — `probe-skill-chain`, the
`skillOverrides` blocks, and `home/.claude/skills/skill-06/`, listed in `manifest.json`
as `skillProbeProjects` and `skillIds`. The configuration was written by the generator,
as above and for a stronger reason: the allowlist drops every captured `skillOverrides`,
so a captured one could not reach this tree even where one exists.

The expectation is what differs, and it differs because no oracle exists to ask.
`claude plugin list --json` answers about plugins; nothing first-party reports a resolved
`skillOverrides` at all. So this project is never asked, holds no `oracle.json` entry,
and is the one live project the plugin oracle does not cover — `manifest.json` names it
separately for exactly that reason. Its cells are compared against `resolveSkill`,
`resolvePlugin` and `resolveMcpServer`, and against nothing else.

Be exact about what that is worth. It checks that the payload a browser is handed *is*
the model — a transposition, a dropped link, a mangled `source`, a lossy round-trip, a
misaligned index all fail, now on a payload carrying four values rather than two. It does
**not** check that `resolveSkill`'s precedence is right: the same function is on both
sides of that comparison, so it agrees with itself whatever it does. Nothing here can
check it, and writing down what the four scopes *ought* to resolve to would be authoring
an expectation — the one thing the rule above forbids, and worth less than admitting the
gap. `resolve.test.ts` owns that claim, against the model's own algebra.

The plugin probe runs — the skill probe has none — are side-effect free, and the
generator checks rather than assumes it: it compares the set of project keys in
`~/.claude.json` before and after, and refuses to write a fixture if probing registered a
new entry. It compares the key set rather than hashing the file because every live
session writes telemetry into it continuously — `pluginUsage` moves within seconds of
doing nothing, so a byte comparison would cry wolf on every run.

### Not represented

Nothing else is knowingly absent. The three-link chain where user, project *and* local
all set the same *plugin* is still covered only by the synthetic workspaces in
`resolve.test.ts`, which is the right place for it: those assert against the model's
own algebra, not against the CLI. `skill-03` puts that shape in the fixture on the skill
axis, but only where the oracle cannot see it — a chain the CLI could have answered for
is worth more than one it cannot, so this does not retire the plugin case.
