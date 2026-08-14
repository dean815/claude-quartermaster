# Session Naming

## Why this matters

Dean's Claude Code sessions follow a single naming standard so a long session list
stays scannable:

```
QM | Claude quartermaster main chat | 7.31 - 8.10
```

A project short code, the session name, then the M.D of the first message and of the
most recent one. Two independent systems produce that, and a project needs one line of
configuration to participate in either.

Onboarding's job is small: pick the project's short code, register it, and set it as
the Remote Control prefix. Everything else is automatic afterwards.

## The two consumers

| System | What it uses the code for | Where it reads it |
|---|---|---|
| `session-name-date-sweep` scheduled task | the `SHORT \|` prefix on session titles, refreshed every 4 hours | `~/.claude/session-name-shortnames.json` |
| Remote Control | the name a session shows on claude.ai, the mobile app, and in Claude Desktop's sidebar | `env.CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX` in `.claude/settings.json` |

They are genuinely separate mechanisms — the sweep rewrites stored titles, while
Remote Control names a session at launch and cannot be changed afterwards except with
`/rename` inside the session. Keeping both fed from the same code is what makes a
project read consistently across the terminal, the sidebar, and the phone.

## Picking a code

Prefer the project's **Linear sub-team key** when it has one. That is the canonical
identifier and it is what Dean already recognizes: `QM`, `JOBS`, `MUSA`, `BNCR`.

Careful: Linear's MCP does not expose a team's key — `list_teams` and `get_team` both
omit it. Derive it from an issue identifier instead:

```
list_issues(fields: ['url','team'])   # ids come back as QM-1, MUSA-6, ...
```

Team names do not track directory names. `career-ops-private` is the "Career & Job
Search" team, whose key is `JOBS` — no guess from the folder name would produce that.

When the project has no Linear team, invent a short uppercase code: 2–6 characters,
`[A-Z0-9]` only, and unique across the existing map. Check the map before choosing;
a collision makes two projects indistinguishable in the session list.

## What to write

Two files, both additive.

**1. Register the code** in `~/.claude/session-name-shortnames.json` under
`shortnames`, keyed by the project's absolute path. Also append the path to
`_linearKeys` if the code came from Linear, or `_unofficial` if it was invented —
those lists are provenance only, but they record which codes are authoritative.

```json
{
  "shortnames": {
    "/Users/deanhicks/claude/new-project": "NEWP"
  }
}
```

Paths are matched by longest prefix, so worktrees under the project inherit its code
automatically. Nothing extra is needed for them.

**2. Set the Remote Control prefix** in the project's `.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX": "NEWP"
  }
}
```

Merge into any existing `env` block rather than replacing the file — these projects
usually already carry `enabledPlugins` and `permissions`.

Without this, Remote Control falls back to the machine hostname, so every session from
every project reads `deans-dang-macbook-graceful-unicorn` and the list becomes useless
for telling projects apart. With it, they read `NEWP-graceful-unicorn`.

## What not to promise

The prefix only replaces the hostname portion. The random suffix remains, and the full
`SHORT | Name | dates` form is not achievable for a Remote Control session name — that
is set at launch. A session gets its real title once it has been prompted, or when the
user runs `/rename`. Do not tell the user onboarding makes remote session names match
the standard exactly; it makes them project-scoped rather than machine-scoped.

The sweep, separately, does apply the full standard to stored session titles. Those are
different surfaces and it is worth being precise about which one is being fixed.
