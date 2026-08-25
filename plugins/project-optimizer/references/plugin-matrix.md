# Plugin and MCP Scoping

## Why this matters

Every enabled plugin contributes skill descriptions to context, and every
connected MCP server contributes full tool schemas — before the user types
anything. A globally-enabled set tuned for all work is, in any single project,
mostly noise competing for attention with the actual task.

MCP servers are the larger cost. A plugin's skill metadata is roughly a hundred
words; an MCP server can contribute dozens of tool definitions with full parameter
schemas. **Scope MCP servers first** — that is where the leverage is.

## How project scoping works

A project's `.claude/settings.json` merges over the user's `~/.claude/settings.json`
on a per-key basis. Setting a plugin to `false` there disables it for that project
without touching the global setup.

```json
{
  "enabledPlugins": {
    "figma@claude-plugins-official": false,
    "typescript-lsp@claude-plugins-official": true
  }
}
```

Keys use the full `plugin@marketplace` form — the same form as in the global
settings file. A bare plugin name will not match.

Two constraints worth stating to the user rather than discovering later:

- **Changes take effect on the next session.** Plugin configuration loads at
  startup; the current session keeps the old set.
- **Verify after restart.** Confirm the intended set is active before assuming the
  scoping worked.

Only list plugins that are actually being changed. A settings file that restates
every global default is noise, and it silently drifts as the global set evolves.

## The matrix

Categorize by how a plugin relates to the project, not by what it does.

### Universal — leave enabled everywhere

Useful in any project; not worth the churn of disabling.

`commit-commands`, `code-review`, `code-simplifier`, `superpowers`, `remember`,
`claude-md-management`, `claude-code-setup`

### Git-conditional

Enable when the project has a remote; irrelevant otherwise.

`github`

### Language-conditional

Match to the detected stack. These are the most valuable **enables** — an LSP for
the project's language is a real capability gain, and it is commonly left off.

| Stack signal | Enable |
|---|---|
| `typescript` in stack | `typescript-lsp` |
| `python` in stack | `pyright-lsp` |

### Domain-conditional

Enable only when the project genuinely works in that domain. These are the most
valuable **disables** — each is dead weight in a project it does not apply to.

| Domain signal | Enable | Disable elsewhere |
|---|---|---|
| Web UI (`react`, `next`, `vue`, `svelte`, `astro`) | `frontend-design`, `playwright` | both |
| Designs actually in Figma | `figma` | `figma` |
| Browser debugging needed | `chrome-devtools-mcp` | `chrome-devtools-mcp` |
| Supabase backend | `supabase` | `supabase` |
| Vercel deployment | `vercel` | `vercel` |

Do not enable `figma` merely because a project has a UI. Enable it when designs
live in Figma and will actually be referenced.

### Meta-conditional

For projects that build Claude Code tooling itself.

| Signal | Enable |
|---|---|
| `.claude-plugin/plugin.json` present | `plugin-dev`, `skill-creator`, `hookify` |
| `mcp-sdk` in frameworks | `mcp-server-dev` |

### Workflow-conditional

Project-management integrations. Enable only when the project's work is actually
tracked there — not merely because the user has an account.

`linear`, `notion`, `airtable`, `zapier`

Ask before enabling any of these. A stale integration is worse than none, because
it invites reliance on data nobody is maintaining.

### User-level — do not scope

Personal tooling, unrelated to any project's code. Leave exactly as the user has
them globally; touching these is meddling.

`minutes`, `proficiently`, `humanizer`, `message-timestamps`, `playground`,
`warp`, `andrej-karpathy-skills`, output-style plugins

## MCP scoping

Project MCP servers are declared in `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["./dist/index.js"],
      "env": { "API_BASE": "https://api.example.com" }
    }
  }
}
```

Two rules that are not optional:

- **Never write a credential into `.mcp.json`.** Reference an environment variable
  (`"${MY_TOKEN}"`) and document the variable name in the README. A committed token
  is a leak with a git history attached.
- **Add `.mcp.json` to git only when the server is shared.** A machine-specific
  local path helps nobody else and creates confusing failures.

Control which project-declared servers activate:

```json
{
  "enabledMcpjsonServers": ["my-server"],
  "enableAllProjectMcpServers": false
}
```

Prefer the explicit list. `enableAllProjectMcpServers: true` means a future
addition to `.mcp.json` silently activates.

For an MCP server project specifically, pointing `.mcp.json` at the local build is
the highest-value thing this whole area produces — it turns the project into a
live test of its own tool surface.

## Proposing changes

Present plugin and MCP scoping as a short table with a reason per row. A bare list
of toggles is unreviewable:

| Plugin | Change | Why |
|---|---|---|
| `typescript-lsp` | enable | TypeScript project; type-aware navigation |
| `figma` | disable | No Figma designs referenced here |
| `playwright` | disable | No browser tests in this project |

Keep the change set small. Three well-reasoned toggles get reviewed and approved;
twenty get waved through or rejected wholesale, and neither is a real decision.
