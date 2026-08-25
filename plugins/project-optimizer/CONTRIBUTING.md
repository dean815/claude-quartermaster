# Contributing

Thanks for looking at this. The plugin decides what to change in people's
projects, so the bar for "how do we know this is right" is higher than the code
size suggests.

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Running it locally

```bash
claude --plugin-dir /path/to/claude-project-optimizer
```

The scripts also run standalone, which is usually the faster loop:

```bash
bash scripts/scan-project.sh ~/some/project --no-github
bash scripts/archive-preflight.sh ~/some/project
bash scripts/registry.sh list
```

**Hook and plugin changes need a full Claude Code restart.** Editing
`hooks/hooks.json` or `scripts/session-start.sh` has no effect on a running
session — exit and relaunch before concluding a change didn't work.

## Tests

```bash
bash tests/run.sh
```

Every test guards a bug that shipped or nearly shipped. **Changes under
`scripts/` need a test.** Not as ceremony — the specific bugs this suite exists
to catch were all "the tool confidently reported the wrong thing," which is the
failure mode that costs a user real data.

Set `PROJECT_OPTIMIZER_HOME` if you run scripts by hand and don't want to touch
your real registry; the suite does this automatically.

## Architecture

Three layers, and the split is load-bearing:

- **`scripts/`** — deterministic facts, emitted as JSON. No judgment. If a skill
  needs to know something, the script should report it rather than the skill
  inferring it.
- **`skills/*/SKILL.md`** — judgment. Reasons over the JSON, proposes, applies.
- **`references/`** — domain knowledge the skills load on demand. Shared by
  `onboard`, `audit`, and `archive`.

So: **new detection goes in a script; new judgment goes in a skill or a
reference.** A skill that shells out to derive a fact the scan should have
emitted is a bug — it makes the skill's conclusions unreproducible from scan
output. That has happened twice here.

## Hard rules

These are non-negotiable, and each exists because it was violated once:

- **Never interpolate a filename into a command string.** Filenames from
  `git ls-files` are untrusted — a repository can contain
  `a"; rm -rf ~; echo ".txt`. Read them as data (`while IFS= read -r -d ''`) and
  quote every use. This was a real arbitrary-code-execution vulnerability in
  `scan-project.sh`; `tests/run.sh` guards it.
- **The SessionStart hook never writes.** Its read-only contract is what makes
  firing in every directory acceptable. Only the skills write.
- **Never `die`/`exit` inside a function called from a command substitution.** It
  kills only the subshell, and the caller continues with an empty value.
- **Don't claim more than you checked.** A blocker saying "these commits exist
  nowhere else" after querying one remote is wrong, and it led to a wrong
  real-world conclusion. Report what was verified.
- **Nothing destructive without verification first.** Copy, verify, then remove.
  Never `rm -rf` a git worktree; use `git worktree remove`.

## Portability

- Use `${CLAUDE_PLUGIN_ROOT}` for every intra-plugin path. Never hardcode.
- macOS ships neither `timeout` nor `gtimeout` — use `run_bounded`.
- BSD `xargs -I` truncates its constructed argument at 255 bytes and fails
  silently on long paths. Prefer a `while read` loop.
- `grep -c` prints a count *and* exits 1 when that count is zero. `|| echo 0`
  appends a second line and produces invalid JSON; use `|| true`.

## Pull requests

Fill in the template — the verification section is the part that matters. State
what you actually ran and paste the output.

CI runs JSON validation, `bash -n`, `shellcheck -S warning`, and the test suite.
The codebase is clean at that level — keep it that way rather than adding
`# shellcheck disable` comments. `-S info` and `-S style` surface a handful more
stylistic findings if you want to go further.

Install shellcheck locally to check before pushing:

```bash
brew install shellcheck
shellcheck -S warning scripts/*.sh tests/*.sh
```

## Reporting bugs

Use the issue template. The single most useful thing you can include is the scan
output for the affected project, with private paths redacted:

```bash
bash scripts/scan-project.sh <path> --no-github
```

Reports of the form "it offered onboarding when it shouldn't have" or "it said a
project was safe to archive when it wasn't" are the highest-value bugs here.
