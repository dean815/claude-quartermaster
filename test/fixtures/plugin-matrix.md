# Plugin and MCP Scoping

A trimmed stand-in for `project-optimizer`'s `references/plugin-matrix.md`, keeping the
shapes that decide whether the reader is right: a prose bucket, a table bucket whose first
column is a backticked *signal* rather than a plugin, a heading that continues into an
instruction, and named plugins outside `## The matrix` that must not be picked up.

## How project scoping works

Prose before the matrix, naming `not-a-bucket-plugin` in passing. Nothing here is a
category, and a reader that took every backtick in the file would say otherwise.

## The matrix

### Universal — leave enabled everywhere

`commit-commands`, `code-review`, `superpowers`

### Git-conditional

`github`

### Language-conditional

| Stack signal | Enable |
|---|---|
| `typescript` in stack | `typescript-lsp` |
| `python` in stack | `pyright-lsp` |

### Domain-conditional

| Domain signal | Enable | Disable elsewhere |
|---|---|---|
| Web UI (`react`, `next`) | `frontend-design`, `playwright` | both |
| Designs actually in Figma | `figma` | `figma` |

### Meta-conditional

| Signal | Enable |
|---|---|
| `.claude-plugin/plugin.json` present | `plugin-dev`, `hookify` |

## MCP scoping

More prose, naming `also-not-a-bucket-plugin`. After the matrix section ends, so it is
outside every bucket.
