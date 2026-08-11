# Claude Quartermaster

CLI that audits which Claude Code extensions (plugins, MCP servers, skills) load in which
projects, and what they cost. `qm audit`, `qm cost`, `qm baseline` / `--drift`, and
`qm serve` for the two-view grid on loopback. Every one of those is read-only.

**`qm set` and `qm undo` are not** (DEA-112). They are the whole of Phase 2 v1: a plugin
toggle written into `<proj>/.claude/settings.local.json`, one file, after a printed diff
and a confirmation. Nothing else here writes any Claude Code config, and v1 never writes
`~/.claude.json`. The grid's add/remove controls stay disabled — wiring them means the
loopback server accepting `POST` for the first time, which is a separate issue.

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

- Writes go to `<proj>/.claude/settings.local.json`. Never write `settings.json` without
  an explicit promote action. **The parenthetical this line used to carry — "gitignored
  in 13/13 of Dean's repos" — was a property of this machine, not of the repos.** Measured
  2026-08-10 over the 17 repositories under `~/claude`: **6** name `settings.local.json`
  in their own `.gitignore`; the other **11** are covered only by
  `~/.config/git/ignore`, which holds `**/.claude/settings.local.json`. On a cloud
  session, in CI, or in anyone else's clone, 11 of 17 would commit the file on the next
  `git add -A`. So `qm set` asks `git check-ignore` and says so when the answer is no —
  a note and not a refusal, because a tracked settings file is a thing someone may want.
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
The discriminator was taken to be the trailing sentence `This field was ignored.`, pinned
as one constant, with the fixture a *recording* rather than a restatement of the rule.
(The constant survives; treating it as *the* discriminator did not — see DEA-151.) **`not-checked` is the common case, not the exception:** `doctor` validates per
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
**One way it already failed was not on that list.** `plural()` inflected the noun and left
the verb fixed, so a file deciding exactly one thing read `so 1 entry in it never apply`
from DEA-148 until c29ef4a — with the 1-entry fixture (`discarded-marketplace-source`)
running green the whole time, because the only assertion that reads that title reads a
*number* out of it: `claimedEntries`'s `/(\d+) (?:entry|entries)/` stops before the verb.
Not DEA-133's miss — the gate ran on the case that could fail and asserted on a projection
of the output the defect was not in, which no amount of fixture coverage repairs. Routed
through `plural()`, and both titles are now asserted **verbatim**, at one and at many: an
expectation rebuilt with `plural()` would agree with whatever it does, which is the
`memorySlug` defect one level removed. Verified by mutation — pinning the verb back reddens
that assertion and no other, and the 6-entry title still passes, so the gate is specific to
the case that shipped wrong rather than to the string having changed.

**When both lists are open, the default is the whole decision (DEA-150, DEA-151).**
DEA-147 said its discriminator could change in a release and take every `field-dropped`
file to `discarded`. What arrived a day later was not a reworded sentence but a **second**
one that had been there all along: `Non-string value in deny array was removed` carries no
note, so a file Claude Code applies classified `discarded`, its links left the chain, and
DEA-148 fired high severity about live config. The prediction named the right failure and
the wrong cause, which is the tell that the *shape* was wrong rather than the string.
Both message families are open sets of first-party prose — measured on 2.1.222, partial
acceptance has **four** members (`This field was ignored.` plus one template over
`deny`/`allow`/`ask`) and refusal has **five**, of which the issue's table listed neither
fully. So enumerating either is a losing game and the only real choice is which way to be
wrong: `costOf` recognises both families and sends anything else to `not-checked`, because
a wrong `discarded` fabricates a high-severity finding about working config while a wrong
`not-checked` loses a detection and leaves the file behaving as it did before any of this
existed. That is DEA-123's `unknown`-over-`restart` rule, which this axis was not
following. `validityOf` is a lattice, not a vote — one confirmed refusal settles the file,
but *every* error must say it survived for it to survive.
**Asking the oracle was the proposed fix and it does not work.** `claude plugin list
--json` reports *resolved* plugin state, so it can only answer "did this file apply" where
removing the file moves some plugin's resolved value: **7 of 38** settings files here, with
22 of the other 31 naming no plugin at all. It answers one bit, the finding still needs the
key from the same prose, and today it would have nothing to run on — all 38 files are
`accepted`. Cheap (~260ms) and blind for four files in five is not a measurement, it is a
coin flip with a spawn attached.
The cost of the chosen direction is paid *visibly*: `not-checked` **carrying schema
errors** is a state nothing else produces, and `unclassifiedSettings` puts it in the run's
output and its JSON, because a failure mode chosen for being quiet is unaccountable unless
someone can see it fire. Underneath all of this, `permissions.deny` was `string[]` by
assertion only — a JSON number reached `isBareDenyRule` and killed `qm audit --full` *and*
`qm effect` with `rule.includes is not a function`, on a file first-party accepts. Narrowed
in `readSettings`, not in the predicate: the reader is where the type stopped being true,
and one narrowing there keeps the predicate the single copy it is supposed to be. Dropped
and never coerced — `String(1)` is a bare deny rule nobody wrote. The day it fails: a new
*refusal* message reads `not-checked` and the original incident recurs silently except for
that one printed line; the recogniser matches templates, so a release that keeps the words
and changes the shape (`Expected object but received number`, no comma) falls out of both
lists at once; and `unknown` has no recording and cannot have one, so its fixture is a
constructed message and is labelled as such.

**The unit is the finding, and the sharp case was not reachable (DEA-149).** A file
Claude Code *keeps* while dropping part of it is live config with a hole in it, which
`discardedSettings` must not report and nothing else did. `droppedSettingsField` does,
and the whole design turns on there being **two** reachable shapes with different cost
units: `hooks: 42` loses the field entire and has no number — the value that failed the
schema *is* what went — while `permissions.deny: [1,2,3,"Bash"]` loses three elements and
keeps `"Bash"` in force. Fold them and only the file is left to count, which prices a
dropped `hooks` at whatever unrelated plugins the file happens to enable: DEA-147's
correction arriving one layer down. So `SettingsError.costs` splits `field` from
`elements` — one class to `validityOf`, two to a report — and the number can only come
from the *file*, because `doctor` prints one entry per array however many elements it
removed and `ruleStrings` is where those elements stop being visible (DEA-150). Hence
`SettingsFile.droppedRuleElements`, keyed by `doctor`'s own dotted path so the join is a
lookup: first-party says an array lost something, the reader says how much.
**The issue's second defect does not exist, and deleting the claim would have been the
wrong repair.** It said `qm effect` wrongly answers `reload` for a deny rule under a
dropped `permissions` key. Measured over thirteen malformed shapes on 2.1.222 and
re-measured on 2.1.224: `permissions` never drops as a *field*. Every malformed shape of
it refuses the file whole, and its one partial acceptance removes non-string elements
whose survivors **are** in force — so `reload` is correct and `effect.ts` narrowing on
`discarded` alone is right. That makes `EFFECT_SETTINGS_KEYS` the deliverable rather than
a narrowing: a tripwire that reddens the day a *whole-field* drop names a key the
classifier reasons about, which is the day the premise becomes true. Deliberately silent
about `elements`, which names `permissions.deny` today and correctly. The same evidence
settles severity: with `hooks` the only reachable whole-field key and nothing
security-relevant droppable at all, the issue's per-key ranking has a set of size one to
rank, so severity is **flat** with the key in the evidence.
**Two first-party messages moved under it, and the safe default absorbed both.** DEA-151
said `unknown` had no recording and could not have one. 2.1.224 supplies two: a malformed
hook *event* prints `This entry was ignored.` (one word off the pinned sentence), and
`extraKnownMarketplaces.<id>.source` — DEA-147's own incident key — stopped voiding the
file entirely. Both read `not-checked`, both are visible through `unclassifiedSettings`,
and neither produced a wrong finding. Neither is taught to the recogniser here: the hook
message drops an *entry of a record*, a third cost unit nothing has measured the
consequences of, and widening the classifier is a decision that wants its own evidence.
(That decision is DEA-152, and it kept the unit and dropped the count.)
**The validity guard was untested until a mutation said so.** Widening the detector from
`validity !== 'field-dropped'` to `validity === 'discarded'` left all 563 tests green,
because the per-error cost guard caught every recorded case on its own. The state that
separates them is a file that is `not-checked` while *carrying* a recognised `field`
error — one message placed, one not — which 2.1.224 emits and which is now recorded as
`mixed-known-and-unknown`. Eight source mutations were run by hand; that is the only one
the suite did not already catch. The day it fails: the detector fires on **0 of 28**
projects here, like DEA-148's before it, so both live only on their recordings; the
count of removed elements is ours where the removal is first-party's, so a release that
changes which elements Claude Code strips desynchronises the two silently; and
`FILE_ENTRIES` in the gate is a hand-copied count that agrees with the fixture JSON only
as long as someone keeps it agreeing.

**Recognising a message spends the evidence that not recognising it was safe (DEA-152).**
2.1.224 says two partial acceptances in words this repo had never seen: `This entry was
ignored.` on `hooks.<Event>` — one word off the sentence DEA-147 pinned — and `Invalid
marketplace entry was ignored:` on `extraKnownMarketplaces.<id>`, which is DEA-147's **own
incident key** behaving in the opposite direction from the release every entry above is
written around. Both read `not-checked` and produced no finding, which is DEA-151 working
rather than failing. Both are now `entry`, a third partial-acceptance unit, and each
produces one medium finding naming the key: measured live on 2.1.224, one scratch project
per message, one finding each.
**The unit was the whole question, and the answer is that it has no number.** `field` has
none *by construction* — `hooks: 42` had no entries to lose — where an entry drop has one
nobody has taken: what a dropped hook event or a dropped marketplace decides is unmeasured,
and this issue declined to measure it. So `dropCost`'s `null`-means-skip became
report-without-a-figure, `Claude Code ignores hooks.PreToolUse in settings.json` is the
finding entire, and the evidence line says the number was **withheld** rather than omitting
it quietly. Any figure available here would have been the file's own entry count, pricing
one dropped hook event at whatever unrelated plugins the file happens to enable — DEA-147's
generalisation arriving a third time, which the issue predicted about itself.
**The oracle is not a weak signal; it is a signal for a different question.** DEA-151
rejected it on coverage — 7 of 38 files — and for this family that framing was too generous.
`claude plugin list --json` answers "did this file apply", and under partial acceptance the
file *always* applies. Measured directly on the marketplace key: two scratch projects
differing only in it, output **byte-identical at 15,463 bytes**, because the plugin resolves
from user scope either way. **Zero** of the four known partial-acceptance messages are
observable through it.
**The price is paid in the fixture set, which is where it is visible.** Teaching the
classifier both messages consumed the only recordings of `unknown`, so the state DEA-151
exists for — `not-checked` *carrying* a recognised error — is back to being constructed, as
it was before 2.1.224 obliged. `mixed-known-and-unknown` keeps its recording and changes
role: it now pins two units side by side. The guard that state was recorded for is still
gated, verified by re-running DEA-149's own mutation: widening `droppedSettingsField` from
`validity !== 'field-dropped'` to `validity === 'discarded'` still reddens, on the
constructed case instead of the recording. The `qm effect` tripwire moved with the unit —
an entry drop takes its key out of force exactly as a whole-field drop does, so
`permissions.deny` reported as an *ignored entry* would put `classify` back to answering
`reload` about rules that are not in force; `elements` stays out, correctly, because its
survivors are.
The day it fails: the marketplace pattern matches its literal noun, one key having been
measured producing it, so a second `Invalid <thing> entry was ignored:` falls to
`not-checked` — narrow, which is the safe direction and still a lost detection. Three
releases in four days moved one of these strings and nothing here changes that arithmetic;
what the entry buys is that the next one costs a detection rather than a fabrication. And
both settings detectors fire on **0 of 30** projects here (42 files, 42 accepted, 0
unclassified under `--full`), so like DEA-148's and DEA-149's before it, this lives entirely
on its recordings.

**The safe direction is a property of the consumer, not of the classifier (DEA-112).**
The first phase that writes. `qm set <plugin>=on|off --project <p>` plans a toggle into
`<p>/.claude/settings.local.json`, prints the whole file's diff and `classify`'s verdict,
asks, and applies through DEA-139's `stageEdits`/`applyStage` — which nothing in `src/`
had consumed. Three refusals stop a write that would *look* like it worked, and the third
is the one nobody asked for. DEA-151 sends a `doctor` message it cannot place to
`not-checked`, because for a **reporting** tool a wrong `discarded` fabricates a
high-severity finding about live config while a wrong `not-checked` only loses a
detection. Invert the consumer and the asymmetry inverts with it: a file that *might* be
discarded is a write that might not land, silently, and the user has no way to notice. So
`targetValidity` refuses on `discarded` **and** on `not-checked` carrying schema errors.
That is not a hypothetical hedge. Measured on 2.1.224, `enabledPlugins.<id>: 42` makes
`doctor` print the bare `Invalid input` — a fifth message family, in neither recognised
list — and `claude plugin list --json` in the same directory reports the file's *other*
entries as **not applied**: two scratch projects differing only in the malformed sibling,
`context7@claude-plugins-official` resolving `true` without it and `false` with it. A
refusal keyed on `discarded` alone would have written into it. `costOf` is **not** taught
the message, deliberately — `Invalid input` is a schema validator's generic fallback and
one key is not evidence about a family (DEA-152's own standard) — so `unknown` has a live
recording again (`test/fixtures/doctor/unplaced-plugin-entry/`) and the *reporting* gap it
represents is filed rather than guessed at.
**The brief's restate rule was wrong, and refusing on it would refuse the write people
want.** "An entry setting a value it would have inherited does nothing" holds only while
nothing at project scope overrides. `resolveCell` computes `restated` against the chain
with **both** project-scope links removed, so a local entry that overrides the repo's own
tracked `settings.json` back to the user-scope value reads `restated` while doing the
work — without it the plugin resolves the other way. So the refusal is *the resolved value
does not move*, and `restated` is a **note**: it names the finding the entry will produce
and says why the entry is load-bearing anyway. `restated-entries` has the corresponding
false positive today; that is reported, not fixed here.
**Nothing is deleted, and the seed carries a layout.** A target that does not exist is
created exclusively (`wx`) as `{\n  "enabledPlugins": {}\n}\n` and then edited through the
same staging path, so undo restores *that* rather than removing a file. The three lines
are load-bearing: `write.ts` copies a document's own indent, colon spacing and line ending
rather than choosing them, so a seed of `{}` is a document with no layout to copy and the
first entry splices in compact — fixing that shape for every later edit. Backups are
timestamped pre-images beside `baseline.json` and `oracle-run.json`; `undo` is one step,
guarded twice — the target must still hash to what this tool left there (an `applyStage`
check cannot see a deliberate edit made minutes ago and perfectly quiescent), and the
restore itself goes through `stageEdits`/`applyStage` like any other write.
The day it fails: the write path fires on nothing in this repo's fixtures the way DEA-148's
and DEA-152's detectors do — it is exercised end to end only against scratch projects, so
the CLI wiring has no gate that a wrong `--project` would redden. The `Invalid input`
refusal is keyed on a *state* rather than a message, which is why it survives the next
release, but the reporting side still classifies such a file `not-checked` and
`discarded-settings` stays silent about a file that really is dead. And the pre-image
guard in `planToggles` — `sha256(original) !== stage.hash` — is **ungated**: deleting it
leaves all 605 tests green, because the window it covers is between two `readFileSync`
calls inside one function and nothing outside can open it.

**Evidence about a key is not evidence about a message (DEA-153).** DEA-112 met a fifth
`doctor` message — the bare `Invalid input`, zod's generic fallback with no noun in it —
and left it unplaced, so the file read `not-checked`, `discardedSettings` said nothing,
and `qm audit --full` reported dead `enabledPlugins` entries as live. That is DEA-147's
own incident arriving through the door DEA-151 opened on purpose. **The fix was two words
away and taking it would have been wrong**: these same words already sit on the *partial
acceptance* side of this classifier, inside 2.1.224's `Invalid marketplace entry was
ignored: source: Invalid input: expected object, received string`, on a file that applies.
Only `^…$` anchoring keeps them apart, and anchoring is a property of our pattern rather
than of first-party prose. So the message was measured before it was placed: **27 malformed
shapes on 2.1.224, one scratch project each, `claude plugin list --json` as the oracle.**
The whole message is exactly `Invalid input` under `enabledPlugins.<id>` and **no other
key** — across four malformations of the value (`42`, `"true"`, `{}`, `null`) — and every
one refuses the file whole. Nothing produced it on a file that survived. That is evidence
about one key, so `REFUSES_UNDER_KEY` is scoped to one key; a keyless pattern would place
it under keys nobody has probed, and a wrong `file` fabricates a high-severity finding
about working config. The prefix is `enabledPlugins.` and not an equality, because the
printed key carries a plugin id holding its own `@` and `.`.
**The scope is invisible to every recording, and that was measured too.** Dropping
`key.startsWith(r.keyPrefix)` left all 605 tests green — every recording of the message is
under the one key, so a keyless match agrees with all of them. The case that separates them
is *constructed* and says so, for the reason the invented-message test does: it asserts
which way the classifier errs on a key it has no evidence about, and a recording can only
stand for a key first-party has already spoken about. The day it fails: `Invalid input`
under a **second** refusing key reads `not-checked` until someone probes it — narrow, the
safe direction, still a lost detection. And this spent the last recording of both `unknown`
and `not-checked`-carrying-errors: all 13 fixtures now classify into a known family, so
DEA-149's validity guard is gated only by constructed cases — re-verified, it still reddens.

**Two entries can be jointly redundant while neither is redundant alone (QM-43).**
`resolveCell` decided `origin` by removing **all** project-scope links at once, so a cell
whose project files *disagree* and land back on the inherited value read `restated` — and
`restated-entries` reported it under *"These change nothing"*, advising a delete that flips
the plugin. `origin` was right as a cell property and wrong as a price for an *entry*:
removing both project links really does inherit that value, but removing the winner alone
moves it to what the loser says. DEA-149's unit confusion, arriving on the resolver axis.
So `Origin` gains a fourth value, `round-trip`, discriminated on the chain rather than the
value: **every project-scope link carrying the winner means inert; links that disagree mean
the winner is working.** Asked of the links, never by re-resolving a shortened chain, which
would agree with whatever the classifier does.
**It is a fourth `Origin` and not a second opinion inside the detector that noticed**,
because `resolveMcpServer` pushes two links at `project` scope *by construction* —
`.mcp.json` declaring, the per-project deny-list refusing — so the shape is reachable with
no settings file involved, `restated-entries` is plugins-only, and `qm serve` renders MCP
cells through this same field. A detector-only repair cannot reach that cell and leaves two
definitions of the word in the tree.
**The corpus already had one, which is how much this was not hypothetical.** `skill-04` in
the differential fixture's `probe-skill-chain` is `project = off`, `local = on`, no user
link: captured to probe exactly this chain and mislabelled `restated` ever since. It is the
only cell in 2,565 that moves. On the live machine **nothing** moves — 14 findings over 87
entries before and after — which is the check that the discriminator did not overreach.
The day it fails: `PROJECT_SCOPES` has two members, so "the links disagree" is today "the
two files disagree", and any future surface pushing two links at one scope inherits the new
value without anyone deciding it should. Widening `restated-entries` back to include
`round-trip` left all 606 tests green until a **plugin-axis** case existed — the fixture
carried the shape only on the skill axis, and that detector never looks there.

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
