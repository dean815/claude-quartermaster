---
name: skip
description: This skill should be used when the user declines or defers the project-optimizer onboarding offer — answering the first-session question with "no thanks", "nah", "not now", "skip it", "never for this project", "don't ask again here", "stop asking", or "remind me later" — or asks to stop the project-optimizer SessionStart hook from prompting in a directory. Records the directory as declined (permanent) or snoozed (temporary). Not for skipping a step, file, or test during ordinary work.
argument-hint: "[never|snooze] [days] [path]"
allowed-tools: Bash
---

# Skip Onboarding

Record a directory so the project-optimizer SessionStart hook stops offering
onboarding there.

## Arguments

Arguments are optional and free-form. Map them before anything else:

- `never`, `no`, `decline` → `declined`
- `snooze`, `later`, or no keyword at all → `snoozed`
- A bare number, or a number following `snooze` → the window in days (default 7)
- Anything path-shaped → the target directory

Invoked bare, with no offer on screen to interpret, snooze the current directory
for 7 days.

## Choosing the status

Two outcomes, and the difference matters:

- **`declined`** — permanent. The hook never offers here again. Use for
  directories that are not projects, throwaway scratch space, or projects
  deliberately left unconfigured.
- **`snoozed`** — temporary, defaults to 7 days. The offer returns after the
  window. Use when the user is mid-task and does not want to deal with it now.

Interpret intent rather than demanding a keyword. "Never", "don't ask again", and
"this isn't a project" mean declined. "Not now", "later", "I'm busy", and "remind
me next week" mean snoozed. When genuinely ambiguous, default to **snoozed** — it
is the recoverable choice, and a wrong permanent decline is silently annoying
months later.

## Recording

Check the existing entry first:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/registry.sh" get "<path>"
```

If the status is already `optimized`, this directory was onboarded and the hook is
already quiet here. Say so and record nothing — writing `declined` would discard a
real result and fix nothing.

Otherwise record it:

```bash
# Permanent
bash "${CLAUDE_PLUGIN_ROOT}/scripts/registry.sh" set "<path>" declined

# Temporary, default 7 days
bash "${CLAUDE_PLUGIN_ROOT}/scripts/registry.sh" set "<path>" snoozed "" 7

# Temporary, explicit window
bash "${CLAUDE_PLUGIN_ROOT}/scripts/registry.sh" set "<path>" snoozed "" 30
```

Default `<path>` to the current working directory when none is given. When the
offer came from the SessionStart hook, reuse the exact path the hook printed in
its message rather than re-deriving it — the registry is keyed by exact string
match, and a symlink-resolved variant creates an entry that silences nothing.

## Confirming

**Run `registry.sh set` before saying anything about the outcome.** The failure
this guards against is answering "snoozed for 7 days" conversationally without
ever writing the entry: the user believes the offer is deferred, nothing is
recorded, and it returns on the very next session. A verbal acknowledgement is
not a skip. Measured at 2 of 4 deferrals before this was made explicit.

Reply in one line: what was recorded, for which directory, and when it expires if
snoozed. Do not explain the registry, restate the plugin's purpose, or offer
alternatives — the user just declined something and wants to get on with their
work.

`registry.sh` exits non-zero and writes to stderr when it cannot record, most
often because `jq` is not installed. **Never confirm a skip that did not happen.**
Say plainly that the directory was not recorded, give the error, and note that the
offer will return next session.

## If asked to undo

```bash
# Make the offer return here
bash "${CLAUDE_PLUGIN_ROOT}/scripts/registry.sh" remove "<path>"

# Show every recorded project and status
bash "${CLAUDE_PLUGIN_ROOT}/scripts/registry.sh" list
```
