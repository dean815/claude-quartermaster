# Claude Quartermaster

Read-only CLI that audits which Claude Code extensions (plugins, MCP servers, skills)
load in which projects, and what they cost. `qm audit`, `qm cost`, `qm baseline` /
`--drift`, and `qm serve` for the two-view grid on loopback. Phase 1b is built; writes
are Phase 2 and are **not**, so nothing here writes to any Claude Code config. The
grid's add/remove controls render disabled for that reason.

## Architecture

Seven config surfaces decide whether an extension is active. They do not share a
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

**A first-party subcommand writes what we promised not to, so disclose it (DEA-140).**
`qm` writes no Claude Code config, but on a machine without `~/.claude.json` the
subcommands it invokes create one: `claude plugin list --json`, `claude plugin details`
and `claude doctor` each do, and the file arrives carrying a `machineID` and a `userID`
the user did not have. `claude --version` leaves a fresh HOME clean, so it is the
subcommand and not the binary. This is the `/doctor` rule above applied to a case it
missed. Resolved by disclosure rather than refusal: not shelling out would remove the
resolver's only oracle for plugin cost and installation health precisely on a fresh
machine, which is where a first-time user runs this. Narrowing the promise to "*we*
don't write it" was rejected — that distinction is not one the user experiences.
So every `claude` spawn goes through one door (`src/disclose.ts`), the file's existence
is recorded at import — before any of them — and the report names the command that
initialised it, as a top-level field beside `unreadable` and `unchecked`. Never as a
finding: it has no severity and is a property of this run, not of the configuration.
The day it fails: it watches one path, so a first-party command that starts
initialising some *other* file goes unreported, and nothing here says what the
subprocess put inside.

**First-party hides duplicate access paths now, and the detector still earns its keep
(DEA-142).** Claude Code v2.1.220's `/mcp` panel matches a claude.ai connector against a
user server *by URL*, hides the loser, and prints `claude mcp remove <server>`. Prefer
first-party where it exists — so the question is whether `duplicateAccessPaths` is
redundant, and it is not. Measured against the same machine: 11 duplicates the panel did
not hide, **6** of them with no user server or connector in them at all (one service
vendored by two plugin bundles, which the panel does not compare) and **8** containing a
plugin-vs-plugin pair. The sharpest is `linear` — 4 namespaces, +1,382 chars, spanning a
connector, a user server *and* two plugins; a connector-vs-user-server URL check catches
one edge of that. The two also read different things: the panel reads configuration, this
reads transcripts, so a connector the panel hid produces **nothing** here — it published
no tool name, so there is no second path to find. That degradation is now a fixture
(`test/fixtures/transcripts/hidden-connector.jsonl`) rather than a happy accident, with
names chosen to collapse so only the hiding keeps the finding away. Where two namespaces
both carry a launch URL the finding says `basis: url` and is exact; otherwise `name`, and
it says the match is inferred. Both are printed, because folding the difference into
`severity` is how a guess starts reading like a measurement. A URL *mismatch* is
asymmetric and never suppresses — `amplitude` and `amplitude-eu` are one service behind
two endpoints — so it annotates and stops. The day it fails: the URL index reads
`~/.claude.json` and project `.mcp.json` and nothing else, so a connector (declared in
claude.ai) and a plugin's own `.mcp.json` (under its install path, unread) are both
absent, and all 11 findings today rest on the name match. `serviceOf` strips
`-trading|-server|-mcp`, which would merge two genuinely different services named apart
only by that suffix; checked across the 145 live namespaces, both collapses it causes are
correct, so no such case exists here yet.

**A recording cannot notice that the thing it recorded changed (DEA-118).** The
differential suite replays a captured `claude plugin list --json` in CI, which catches
our regressions and never theirs — a recording agrees with itself forever. `qm oracle`
re-asks the live binary weekly. Three things fall out of "silent when they agree".
*Silence is not evidence of health*, so every run overwrites
`~/.local/state/claude-quartermaster/oracle-run.json` and `--status` reads it; an
all-clear line or a heartbeat issue was rejected because output nobody needs is output
nobody reads, and the divergence line has to survive being skimmed. *Zero mismatches has
two causes*, so a sweep where projects existed and none answered reports and exits 2
rather than passing — the DEA-127 defect one layer out. And *the dedupe key is the exact
set of diverging pairs*: keying on "diverged at all" files once and then stays silent
through every later, different disagreement, leaving an issue whose table is wrong;
keying on the run dedupes nothing. A different set files a second issue naming the first
as superseded, which can overstate — and an issue that overstates is recoverable where
one that silently understates is the whole failure being prevented. Scheduling is a
launchd plist plus an install script the user runs; `qm` never installs or loads it,
because that is a live-environment write. Filing is reachable only by handing
`runOracleCheck` a filer, constructed in exactly one place behind `--file-issue`, so
there is no flag to forget. The comparison **moved** out of the test rather than being
copied — `comparePairs` and `askableProjects` now have three callers and one body. The
day it fails: this covers one of four reverse-engineered behaviours. `plugin details`
output, the usage counters, and MCP tool-name loading change silently, and every
user-facing string says so because "the oracle agrees" reads as "drift is handled".

**A key nobody matches is worse than a key nobody reads (DEA-145).** `pluginServerKey`
built `plugin:<marketplace id>:<server>`; Claude Code namespaces by the plugin's
*manifest* name (`<installPath>/.claude-plugin/plugin.json` → `name`). Measured **inside
the `needsAuthMcpServers` arrays Claude Code writes** — not by grepping transcripts, where
this repo's own prose about the bug produces 86 false hits — `plugin:Notion:notion` appears
389 times and `plugin:notion:notion` **0**, against 14,064 `mcp__plugin_Notion_notion__`
tool calls. It hid because 39 of 42 installed manifests equal their id prefix. The cost was
not cosmetic: the grid labelled a row with a string no config file matches, so a Phase 2
write would have emitted it into `disabledMcpServers`, reported success, and left the
server loading — and the deferral join pointed at a namespace no session published, so the
busiest MCP server on the machine classified `unknown`.
**The fallback is a value, not a default.** `readManifestName` returns `null` where nothing
is readable (2 of 42 here), never the id; `McpEntry.keyBasis` carries
`manifest` / `marketplace-id` onto the row, because a row has no inventory left to consult
and both bases produce an identical-looking `plugin:X:Y`. `pluginServerKey`'s third
parameter is required, so no call site can omit it and get the guess silently. The mutation
that matters is invisible to the axis: promoting the fallback to a confirmed name renames
no row, so only the basis field catches it. `joinIsExact` was **not** promoted alongside —
nothing can date a plugin-provided server, so promoting the join swaps one "could not tell"
for another while leaving one guard where there were two; it needs `installedAt` first, and
exactness is now per-entry rather than per-kind. The day it fails: the same defect is live
on the **skill** axis — `shortPluginName` splits the id while transcripts list
`Notion:create-page`.

**A file that parses is not a file that applies, and "invalid" is not one state
(DEA-147).** Claude Code validates a settings file against a schema before merging it,
and the issue's title — one bad key voids the whole file — is true for some keys and
false for others. Measured on 2.1.221 with `claude plugin list --json` as the oracle:
`hooks: 42` fails the schema, `doctor` reports it, and `enabledPlugins` **still
applies**; `extraKnownMarketplaces.<id>.source` as a string and `permissions.deny` as a
string each void the file entire. So `SettingsValidity` has four values —
`accepted` / `field-dropped` / `discarded` / `not-checked` — and **only `discarded`
removes a file's links from the chain.** Reading `field-dropped` as void reports live
overrides as dead, which is DEA-123's cry-wolf failure arriving from the opposite side.
The only observable discriminator is the trailing sentence `This field was ignored.`,
so it is pinned as one constant and the fixture is a *recording*, never a restatement of
the rule. **`not-checked` is the common case, not the exception:** `doctor` validates per
working directory, so checking 28 projects here is 28 spawns and 15.6s, which puts it
behind `--full`; without it every file reads `not-checked` and resolves exactly as
parsing alone always did. `readSettings`'s second parameter is required for the
`pluginServerKey` reason — a default would pick one of the two wrong answers silently.
`qm effect` grows a fourth verdict, `none`, for a deny rule in a discarded file: it is
neither `reload` nor `restart` because the change does not land. The day it fails: three
ways. That sentence is first-party prose and can change in any release, taking every
`field-dropped` file to `discarded` with it. Validity is per *file* while the error names
a *key*, so a `field-dropped` file whose dropped field is `permissions` has deny rules
that are equally not in force and `effect.ts` still says `reload` for them. And whether
`doctor` reports on `~/.claude/settings.json` from a non-home cwd is **unmeasured** —
establishing it means corrupting the live user settings file — so user scope is
`not-checked` unless a run *names* it, which on this machine happens only because `~` is
itself a registered project and that run covers the file as its own project scope.

**Only `discarded` is a finding, and the boundary is the point (DEA-148).** `qm audit`
now names each settings file Claude Code refuses and counts what dies with it. The
incident behind DEA-147 was 14 files and 108 `enabledPlugins` entries; the differential
gate caught **21** of the 108, because the other 87 happened to match user scope and a
value comparison cannot see a dead entry that agrees. A `field-dropped` file is **not**
reported: it is live config with one key missing, so reporting it would call working
overrides void *and* charge the whole file's entries to one dropped key — the cost unit
differs by state, and folding them together restates the false generalisation DEA-147
had to correct. Its sharp case is filed separately, the one the DEA-147 entry names: a
dropped `permissions` block whose deny rules are equally not in force while `effect.ts`
still says `reload`. So an ignored `permissions` block with no finding here is a scope
boundary and not a miss, and `test/discarded-settings.test.ts` goes red the day this
detector reports one. **The channel had to widen before any of it could be said.**
`settingsFromDoctor` returned a verdict per path and dropped `SettingsError` entirely, so
the finding could name a file and not the key — sending the reader back to run the command
whose output was already in the argument. It now returns `SettingsCheck`
(`validity` + `schemaErrors`) from the same single spawn, and `SettingsFile.schemaErrors`
is required for `readSettings`'s reason: a discarded file must not be able to arrive
without the key that discarded it. Evidence is verbatim on both halves, including
`doctor`'s own `Suggested fix:` continuation, and the fix points back at `claude doctor`
the way `orphanedProjectConfig` points at `claude project purge` — repair advice for a
schema this repo does not own is a second opinion waiting to drift. **`not-checked` is
reported, not hidden:** validity is behind `--full`, so a default run leaves all 38 files
here unchecked and this detector silent, and the per-state tally is a top-level
`settingsValidity` field beside `unreadable` and `unchecked` — never a finding, because it
has no severity and describes the run (DEA-140's call). Measured under `--full` on this
machine: **38 files, 38 accepted, 0 discarded** — the incident was repaired, so today the
only live evidence is the recording, and a fixture case had to be *added* (six entries
over four keys) before a counter reading one key could fail. The day it fails: the tally
counts files and not entries, so one voided file holding 90 and one holding 1 read alike
in the summary line; and the cost counts four keys, so a discarded file carrying only
`permissions` and `hooks` reports that it is discarded with no number at all.

**Usage counters mean different things.** `skillUsage.usageCount` is a true invocation
count (verified: invoked `gsd-help` once, counter went 1 → 2). `pluginUsage.usageCount`
is dominated by hook firings — 8 of 10 hook-providing plugins are non-zero vs 2 of 32
without, and `warp` reads 9,068 against 97 startups. Only claim "never used" for a
plugin whose `Hooks` count is **0**; an absent Hooks key means "couldn't tell", not zero.

**Report distributions, not point estimates.** Baseline context is not a workspace
property. Across 469 sessions the MCP tool-name block ran 192 → 34,369 chars
(median 1,050). Always carry the sample count.

**Non-deferral is unobservable, so `restart` has one route, not two (DEA-123).** The
docs name two cache-invalidating changes: a bare-tool-name deny rule, and a plugin
providing an MCP server whose tools aren't deferred. Transcripts record only what *was*
deferred — an eagerly-loaded tool lands in the system prompt, which we don't read — so
the second is not measurable here. Checked before designing around it: across 2,071
transcripts the one candidate signal (a server publishing `mcp_instructions` and no
`deferred_tools`) covers 14 servers over 25 session-occurrences, and **every one of the
14 also appears deferred elsewhere** — 30.8% of sessions at worst
(`plugin_airtable_airtable`, 12 of 39), 0.6% at best, none at 100%. It measures
connection timing. So `src/effect.ts` classifies `reload` / `unknown`, `restart` comes
from the deny-rule half alone, and `DeferralEvidence` has two values with the missing
third named in place. `unknown` is an answer, not a polite `restart`: defaulting to the
scarier verdict when unmeasured is the cry-wolf behaviour the classifier exists to
prevent, and it would satisfy the issue's letter while doing so. The predicate is
shared with `bareDenyRules`, not copied.

Two joins are load-bearing and both were quietly broken. `normalizeServerName` mapped
`:` and ` ` but not `.`, so `claude.ai Airtable` never matched `claude_ai_Airtable` —
36 of 60 MCP rows read `unknown` that are in fact observed. Hyphens are *not* mapped
(`plugin_pdf-viewer_pdf` keeps its), so the rule is those three characters and no more.
And any per-settings-file walk needs the `~`-dedup: `~/.claude/settings.json` arrives
twice, which double-counted its deny rules.

**A gate that cannot fail is not a gate.** Before trusting a green check, break the code
underneath it and confirm the suite goes red. Ship the mutation as a test, asserting both
*that* it fails and that the message names the right divergence — a gate failing for
another reason is not the gate working. Three caught so far, none visible by reading the
test:

- The differential suite skipped as a whole unit for weeks while CI stayed green (DEA-127).
- A guard derived from its own assertion — `skip = sessions.length === 0` against
  `assert(sessions.length > 0)` — runs only where it must pass and skips wherever it could
  fail (DEA-133). `measureProject` swallows read errors, so the regression it was there to
  catch turned the suite green.
- Reading a value back through the function that wrote it is that same defect one level
  removed. Laying a fixture down at `memorySlug(p)` and reading it via `measureProject`,
  which calls `memorySlug` itself, agrees with itself whatever the function does —
  measured: swapping the separator left it green. Pin the other half as a **literal**, and
  prefer a literal that is someone else's fact (Claude Code's on-disk layout) over one
  restating our own implementation.

Corollary for briefs: judge the stated acceptance criterion separately from the work, and
ask whether an implementation could satisfy it exactly and leave the problem in place.
DEA-128 passed its own gate — "add the sha to the cache key" — while the sha resolved for
only 18 of 42 plugins (DEA-131).

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

@.claude/dean-guidelines.md
