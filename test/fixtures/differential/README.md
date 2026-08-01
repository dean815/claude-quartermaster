# Differential fixture

A real workspace's plugin configuration, paired with the answer
`claude plugin list --json` gave for the same projects, anonymised hard enough to
commit. It lets the differential gate — which otherwise only runs on a machine with
the Claude Code CLI and a populated `~/.claude.json` — be replayed in CI.

```
home/                       the fixture HOME; point loadWorkspace at it
  .claude/settings.json     user scope, and also `~`-the-project's project scope
  .claude/settings.local.json
  .claude.json              project entries, keyed by anonymised path
  .mcp.json
  proj-NN/…                 captured project directories
  probe-local-*/…           constructed input, observed expectation — see Provenance
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

## What it captures

Counts live in `manifest.json`, written by the same run that writes the tree, so they
cannot disagree with it. Restating them here would create a second number to update
and a first one to forget.

`manifest.json` carries `projectEntries`, `oracleProjects`, `pairs`, `plugins`,
`probeProjects`, and `decidedByScope`. **`decidedByScope` counts the scope that *won*
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

## Provenance

Everything here is one of two kinds, and the difference is worth being precise about.

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

The probe runs are side-effect free, and the generator checks rather than assumes it:
it compares the set of project keys in `~/.claude.json` before and after, and refuses
to write a fixture if probing registered a new entry. It compares the key set rather
than hashing the file because every live session writes telemetry into it continuously
— `pluginUsage` moves within seconds of doing nothing, so a byte comparison would cry
wolf on every run.

### Not represented

Nothing else is knowingly absent. The three-link chain where user, project *and* local
all set the same plugin is still covered only by the synthetic workspaces in
`resolve.test.ts`, which is the right place for it: those assert against the model's
own algebra, not against the CLI.
