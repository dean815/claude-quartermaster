---
name: audit-workspace
description: This skill should be used when the user asks what Claude Code extensions are loading, what their context costs, or whether their setup has drifted — "what's loading in this project", "what is my baseline context costing", "which plugins do I not use", "is anything configured twice", "why is my context full", "audit my Claude Code setup", "what changed since my baseline", "does toggling this need a restart". Reports across every project and every config surface, read-only. Use tune-workspace instead when the user wants something changed.
argument-hint: "[--project <path>] [--full] [--drift]"
allowed-tools: Read, Bash, Glob, Grep
---

# Audit the workspace

Report what actually loads, where, and what it costs. **This skill never changes
anything.** `tune-workspace` is the one that writes.

Claude Code has eight config surfaces that decide whether an extension is active
and they do not share a mechanism. Nothing first-party reports the combined
answer. That is what this reads.

## Invocation

```bash
node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" audit
```

Useful variants, in the order they are usually wanted:

| Ask | Command |
|---|---|
| Everything, ranked | `audit` |
| One project | `audit --project <abs-path>` |
| What has changed | `audit --drift` (needs an earlier `baseline`) |
| Plus git hygiene and schema validation | `audit --full` |
| What a toggle needs before it is live | `effect` |
| Baseline context, measured per session | `cost` |
| Record today, to diff against later | `baseline` |

`--full` spawns `claude doctor` once per project. On a large workspace that is
slow and worth warning about before running it. Without it, every settings file
reports `not checked`, which resolves exactly as parsing alone always did.

Machine-readable output is `--json` on any of them.

## Reporting the result

**Pass findings through. Do not re-interpret them.**

Each finding already carries a `detail` that says what was measured and a `fix`
that says what an action would do. Both are written to be exact about how well
the thing is known — whether a match was confirmed by launch URL or inferred from
a name, whether a count is a true invocation count or contaminated by hook
firings. Restating them in your own words drops those qualifiers, and the
qualifiers are the part that took the most work to get right.

So: surface the findings in severity order, quote `detail` and `fix` as written,
and add context only where the user asks a question the output does not answer.

**Never turn a finding into a recommendation the tool declined to make.** This
tool reports mechanism and never advises which mechanism a service should use.
That is a settled scope decision, not an oversight. If the user asks "should I
use the plugin or the connector", the honest answer is that it depends on how
they launch Claude Code, and the finding says which path wins in each case. Say
that. Do not pick for them.

**Do not invent a fix for a finding that has none.** Some findings deliberately
report a state and stop.

## Traps worth knowing before you explain a number

- **A "never used" plugin claim is only sound when its Hooks count is 0.** Plugin
  usage counters are dominated by hook firings, so a plugin providing hooks has an
  inflated count and an absent Hooks key means "could not tell", never zero.
- **Baseline context is a distribution, not a number.** Carry the sample count
  when quoting it. Across one measured workspace the MCP tool-name block ran from
  192 to 34,369 characters.
- **Changes take effect on the next session.** The running one keeps its startup
  set. Editing CLAUDE.md mid-session does not apply; it reloads on `/clear`,
  `/compact`, or restart.
- **`qm audit` reads; the `claude` subcommands it invokes can write.** On a
  machine with no `~/.claude.json`, first-party commands create one carrying a
  machineID and userID. The run says so when that happens. Do not suppress it.
