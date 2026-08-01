# Fixtures

| | committed | used by |
|---|---|---|
| `plugin-details/` | yes | `cost-plugins.test.ts` — real `claude plugin details` output, captured verbatim |
| `transcripts/synthetic.jsonl` | yes | `cost-transcript.test.ts` — hand-built, pins the arithmetic |
| `local-snapshot/` | **no** | nothing, currently — see below |

## The local snapshot is deliberately not committed

`local-snapshot/` is a redacted snapshot of a real Claude Code workspace. Regenerate it
locally; do not hand-edit it:

```bash
node --experimental-strip-types scripts/make-fixtures.ts
```

It is gitignored because **redacting paths is not the same as anonymising them**. The
generator rewrites `$HOME` to `/Users/testuser`, which hides who you are but not what
you work on: 133 project directory names survive intact, and on the machine this was
built against those included a job search in progress and several
security-research-sounding repo names. In a public repo that is a disclosure, and git
history is the wrong place to discover it.

No test currently reads it — the suite uses synthetic workspaces built in
memory, which are clearer about what they are testing. It earns its keep as an
exploratory tool: it is how the `~`-is-a-project scope collision was found.

## Redaction

Allowlist-first: every value is dropped unless a rule keeps it, so an unanticipated
key cannot leak. Home paths become `/Users/testuser`. MCP `env` and `headers` keep
their key names — a server *having* an env block is meaningful — but every value
becomes `<redacted>`. Per-project telemetry (`lastCost`, `lastSessionId`, and the rest
of the `last*` family) is dropped entirely.

Verified on capture: no real home paths, no secret-shaped strings.

## What the snapshot captures

| | |
|---|---|
| Project entries in `~/.claude.json` | 137 |
| …pointing at directories that no longer exist | 115 |
| Projects with settings files fixtured | 15 |
| Plugins in the global `enabledPlugins` | 42 |
| Top-level MCP servers | 6 |

## Edge cases it deliberately preserves

**`~` is itself a project, and its project-scope settings file *is* the user-scope
file.** When Claude Code runs in the home directory, `~/.claude/settings.json` serves
as both the user scope and the project scope — byte-identical, same inode. A resolver
that treats scopes as independent will read every one of the 42 global plugins as set
at both user and project scope with the same value, and report 42 false `restated`
findings.

The rule this forces: **deduplicate chain links by resolved file path.** A single file
contributes to the chain once, at its lowest applicable precedence. `_home` in the
snapshot exists to hold this case.

**Projects carrying both `settings.json` and `settings.local.json`.** Five of them in
the snapshot this was built from. This is the precedence chain that has to render as a
chain rather than a flat three-state — a project can hold a value in its tracked
settings *and* override it locally.

**Dead project entries.** 115 of 137 paths no longer exist, and 35 of those still
carry a non-empty `disabledMcpServers` deny-list. Each is marked with `_fixtureAlive`
so the orphan detector has both a positive and a negative case. The `_fixture*` keys
are fixture metadata and are never present in real config.

**A project-declared server.** At least one project carries its own `.mcp.json`, and
so does `_home` — with the declared server switched on through `enabledMcpjsonServers`
in `~/.claude/settings.local.json`. That is the full project-MCP path: declared in one
file, enabled in another, and neither file alone tells you the answer.

> Project and server names are deliberately absent from this file. It is
> gitignored because directory names identify what someone works on; describing it by
> name here would have leaked exactly what excluding it prevents. It did, in the first
> published commit — see the note in the repo history.
