# `claude doctor` settings-validity recording

Read by `test/validity.test.ts` and `test/discarded-settings.test.ts`, through
`load.ts`. Both halves of every comparison in those gates are first-party output,
recorded against **Claude Code native 2.1.221** (commit `6efaf12e8b43`, darwin-arm64) on
2026-08-05, two cases against **2.1.222** (commit `fbf49312c284`) on 2026-08-06, and two
against **2.1.224** on 2026-08-09 -- `manifest.json` → `cases[].claudeVersion` names each
exception. The originals were *not* re-captured to tidy that up: a recording is dated by
construction, and re-recording them would throw away the only evidence anyone has that
the block's shape survived a release. It did not survive intact, which is the point --
see *What moved between releases* below.

| | |
|---|---|
| `<case>/doctor.txt` | `claude doctor`, **verbatim**, run in a scratch directory holding exactly `<case>/.claude/` |
| `<case>/.claude/settings*.json` | the files that were in place for that run |
| `manifest.json` → `cases[].enabled` | `claude plugin list --json`, run in the same directory immediately after |

Nothing here restates Claude Code's settings schema. A fixture asserted against our own
copy of the rules proves only that the copy agrees with itself, and the copy starts
drifting on the next release.

## Why `enabled` is the expectation

Every case sets `enabledPlugins["context7@claude-plugins-official"]`, and the capturing
machine's `~/.claude/settings.json` sets that plugin to **`false`** (recorded in
`manifest.json` → `userScope`). So the first-party `enabled` is not decoration: it is
Claude Code saying which of the case's files it honoured. A file whose `enabledPlugins`
survives gives `true`; a file it discarded leaves the answer at the user scope's `false`.

## The cases

| case | extra key | `doctor` | `enabled` | what it shows |
|---|---|---|---|---|
| `accepted` | *(none)* | silent | `true` | a valid file prints no block at all |
| `field-dropped-hooks` | `hooks: 42` | error + `This field was ignored.` | `true` | **fails the schema and still applies** |
| `discarded-marketplace-source` | `extraKnownMarketplaces.<id>.source` as a string | error | `false` | the incident's own key; whole file voided |
| `discarded-permissions-deny` | `permissions.deny` as a string | error + `Suggested fix:` | `false` | whole file voided, and the continuation line |
| `dropped-over-discarded` | both, in two files | two errors, one run | `true` | field-dropped `settings.json` survives a discarded `settings.local.json` above it |
| `discarded-many-entries` | `extraKnownMarketplaces.<id>.source` as a string | error | `false` | six entries over four keys, so a cost figure can be wrong in more than one way |
| `deny-nonstring-elements` | `permissions.deny: [1, 2, "Bash"]` | error, **no note** | `true` | the second partial-acceptance message, in different words |
| `allow-nonstring-elements` | `permissions.allow: [1, "Read(~/.zshrc)"]` | error, **no note** | `true` | the same template on a second key |
| `dropped-field-and-elements` | `hooks: 42` **and** `permissions.deny: [1, 2, 3, "Bash"]` | two errors | `true` | both partial-acceptance shapes at once, and they cost different units |
| `hook-entry-ignored` | `hooks: { PreToolUse: 42 }` | error, `This entry was ignored.` | `true` | a partial acceptance **no pattern here recognises**, so `not-checked` |
| `valid-local-over-discarded` | discarded `settings.json`, valid local | error | `true` | a discarded file whose removal changes nothing — the control |

`discarded-many-entries` is the only case whose reason for existing is a *number*.
Every other file decides exactly one thing, so a detector counting only `enabledPlugins`
would price all of them correctly; this one spends 2 plugin entries, 1 `skillOverrides`
entry and 3 `.mcp.json` server entries, and the count is asserted as a literal. Its other
three keys were also checked against the oracle with the bad key removed — both plugins
resolve `true` — so the discard is the marketplace key's doing and not theirs.

`field-dropped-hooks` is why the model has four states and not three. The issue this
fixture belongs to (DEA-147) was titled *one bad key voids the whole file*, and that is
false for `hooks`.

`deny-nonstring-elements` and `allow-nonstring-elements` are why the discriminator is not
one sentence (DEA-151). Both print an error with **no** trailing note and both files
still apply, so the rule "a message without `This field was ignored.` voids the file"
called live config dead. The `allow` case exists so that the recogniser has to read the
message *template* — one sentence, the array's key name varying — rather than the literal
string that the `deny` case happens to produce; `permissions.ask` was measured producing
the third instance and is not recorded, because a third copy of one template buys nothing
the second does not already buy.

`deny-nonstring-elements` is also the seam with DEA-150. The same array holds `"Bash"`,
so this one recording carries both halves of that fix: first-party says the file applies,
and `test/permission-rules.test.ts` says the reader keeps `Bash` and drops `1` and `2`.

`dropped-over-discarded` is the sharpest single case: two files, two validities, one
`doctor` run, and `true` is reachable only by honouring the first and dropping the
second. Voiding `settings.json` gives `false`; honouring the local file gives `false`.

`dropped-field-and-elements` is DEA-149's cost unit, twice over. `hooks` leaves whole and
`permissions.deny` loses three of its four elements while `"Bash"` stays, and **one**
`doctor` entry covers all three removals — first-party never prints the number, so a
count of what was removed can only come from the file. The file decides two entries
elsewhere (one plugin, one skill), so 2 is a number a whole-file counter would print and
neither correct answer is 2.

`hook-entry-ignored` is the state that could not be recorded until it could. DEA-151
argued `unknown` is the safe default for a message from neither family and noted it had no
first-party instance, so its fixture had to be constructed. 2.1.224 supplies one: a
malformed hook *event* prints `This entry was ignored.` — one word off the sentence
`FIELD_IGNORED_NOTE` pins — and `enabled: true` says Claude Code applied the file anyway.
Nothing here matches it, so it lands in `not-checked` **carrying schema errors**, which is
the visible half of that trade. Teaching the classifier this message is a decision with its
own cost unit (an entry of a record, which is neither of the two DEA-149 models), so it is
deliberately not taken here; the recording is what makes it arguable from evidence.

## What moved between releases

Two of these recordings are now historical rather than current, and both were found by
re-running the probe on 2.1.224 rather than by anything going red:

- `extraKnownMarketplaces.<id>.source` as a string — the DEA-147 **incident key** — voided
  the whole file on 2.1.221/2.1.222 (`Expected object, but received string`, `enabled:
  false`). On 2.1.224 it prints `Invalid marketplace entry was ignored: source: Invalid
  input: expected object, received string` and `enabled` is **`true`**: partial acceptance,
  in a third phrasing, which nothing here recognises either. `discarded-marketplace-source`
  and `discarded-many-entries` remain honest recordings of the release named on them.
- `hooks.PreToolUse` gained the `This entry was ignored.` phrasing, recorded above.

Both changes land in `not-checked`, which is the direction DEA-151 chose and the reason
neither one produced a wrong finding. Both are also why the gates run against recordings
rather than against the live binary.

## What the parser depends on

- The block opens with a line reading exactly `Invalid settings`.
- Entries are `- <abs path> › <key>: <message>`, where `›` is **U+203A**, not `>`.
- Some entries carry an indented continuation (`Suggested fix: …`). Not one line per error.
- The failure classes are told apart by matching the message line against **two** lists of
  first-party phrasings — `KEEPS_THE_FILE` and `REFUSES_THE_FILE` in
  `src/delegate/doctor.ts`. Both are open sets of Claude Code's own prose with no version
  guarantee behind them, so a message matching neither is `not-checked` and never
  `discarded`; which way that errs, and why it errs that way, is argued at `costOf`.
- `No installation issues found.` prints **anyway**, so `parseInstallationIssues` returns
  `[]` for every case here. That is asserted, because it is why the block went unread.

## Paths

`doctor.txt` carries the absolute path of the scratch directory it was captured in,
recorded in `manifest.json` → `recordedProjectDir`. The test rebases that one string onto
the case's own directory and touches nothing else, so the messages stay byte-verbatim.

## Regenerating

Not scripted in-repo, and deliberately so: it needs a directory with *invalid* settings,
and the only safe place for one is a scratch directory outside every real project.
Never point `claude` at a synthetic `HOME` on macOS, and never corrupt
`~/.claude/settings.json` to test the user scope — whether `doctor` reports on it from a
non-home working directory is **not measured**, and stays that way.
