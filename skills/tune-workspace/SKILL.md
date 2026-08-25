---
name: tune-workspace
description: This skill should be used when the user wants to change which Claude Code extensions load in a project — "turn off this plugin here", "disable that MCP server for this project", "stop this skill loading", "enable X in this repo", "undo that config change", "apply what the audit found". Writes one settings key per axis behind a printed diff and a confirmation, and can undo the last apply. Use audit-workspace instead when the user only wants to know what is loading.
argument-hint: "--project <path> [--axis plugin|skill|mcp] <id>=<value>"
allowed-tools: Read, Bash, Glob, Grep
---

# Tune the workspace

Change what loads, one reviewed batch at a time. This is the only part of
quartermaster that writes.

## Invocation

```bash
node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" \
  set --project <abs-path> --axis <plugin|skill|mcp> <id>=<value>
```

`--project` must be absolute. The axis is **never inferred** and there is no
default worth relying on: plugins and skills share a file and share the `on`/`off`
spellings, so a guess writes a live-looking entry into a key nothing reads.

| Axis | Writes | Accepts |
|---|---|---|
| `plugin` | `<proj>/.claude/settings.local.json` → `enabledPlugins` | `on` / `off` |
| `skill` | same file → `skillOverrides` | `on` / `name-only` / `user-invocable-only` / `off` |
| `mcp` | `~/.claude.json` → `projects[<abs>].disabledMcpServers` | `on` / `off` |

Skills take four values and **no booleans**, because there is no answer to which
of `on` and `name-only` a `true` would have meant.

`--axis mcp` is a deny-list with inverted polarity: `off` adds the name, `on`
removes it.

## How to run it

**Show the user the plan and let them answer the prompt.** The command prints the
whole file diff, what the change needs before it is live, and any notes, then
asks. Do not pass `--yes` unless the user has explicitly said to skip the
confirmation for this specific run.

**Relay refusals rather than working around them.** The command refuses when
Claude Code would discard the target file, when `claude doctor` reported on it in
words this release cannot place, or when the write would decide nothing. Each
refusal names the reason. A refusal is the tool doing its job; report it and stop.

**`undo` is one step and guarded.**

```bash
node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" undo
```

It restores the last apply and refuses if what it wrote has changed since.

## The one case where "off" can increase what loads

On the MCP axis, denying a **manually-configured** server can un-suppress copies
it was holding down. Claude Code hides an MCP server whose launch signature
duplicates a manually-configured one, and it builds that map from the servers that
are *enabled* — so denying the winner takes it out of the map and the plugin or
connector copies come back.

The plan prints a note when this applies, naming the twins. **Read that note out
rather than summarising it**, and do not describe the write as "turning the server
off" when the note is present. Which copy returns depends on how Claude Code was
started, so the note does not name one, and neither should you.

## Two things not to do

**Do not treat a plugin toggle as a security boundary.** It controls loading, not
authority. `permissions.deny` is the mechanism for that, and it merges across
scopes rather than overriding.

**Do not hand-edit the files instead.** `~/.claude.json` is written by every live
session, and the safe write path exists because of that. If the command refuses,
the answer is to address the reason, not to bypass it.
