# Directory Organization Checks

"Well organized" is only actionable as specific checks with specific remedies.
This is the list.

## The governing constraint

**Never delete. Never move without approval.** A file that looks like scratch may
be load-bearing. Every finding here produces a proposal, not an action.

Moving files also breaks things silently: imports, scripts, CI paths, and
`.gitignore` rules. When proposing a move, check whether the path is referenced
elsewhere first:

```bash
grep -rn "<filename>" . --exclude-dir=node_modules --exclude-dir=.git | head
```

## Check 1 — Root clutter

**Signal**: `layout.rootFileCount` above roughly 20.

Judge the count in context. Many ecosystems legitimately require a dozen or more
root config files (`package.json`, `tsconfig.json`, `.eslintrc`, `vite.config.ts`,
`Dockerfile`, and so on). Configuration at root is convention, not clutter.

What is actually clutter: source files, scripts, notes, and data at root that
belong in a subdirectory.

**Remedy**: propose moving loose scripts to `scripts/`, loose docs to `docs/`,
loose source to `src/`. Never propose moving a config file that a tool expects at
root.

## Check 2 — Stray and scratch files

**Signal**: `layout.strayFiles` — names matching `test.js`, `tmp*`, `scratch*`,
`untitled*`, `foo*`, `notes.md`, `*.bak`, `*.old`, `*.orig`, or names containing
spaces.

These accumulate and are rarely deliberate. But some are: a `notes.md` may be the
user's actual working notes.

**Remedy**: list them and ask. Offer three options per file — keep as is, move to
a gitignored `scratch/` directory, or the user deletes it themselves. Never
delete on the user's behalf.

For files with spaces in the name, note that they break shell scripts and CI
paths in ways that are annoying to debug, and propose a rename.

## Check 3 — Missing standard directories

**Signal**: archetype expects a directory the scan did not find.

Compare against the archetype's layout in `archetypes.md`.

**Remedy**: propose creating the directory **only when there is content to put in
it.** An empty `tests/` directory is not organization; it is a false signal that
tests exist. When source files are already scattered at root, propose the
directory and the moves together as one change.

## Check 4 — Risky tracked files

**Signal**: `layout.riskyTracked` is non-empty.

Files matching `.env`, `*.pem`, `*.key`, `id_rsa`, `credentials.json`,
`secrets.yaml`. Template variants (`.env.example`) are excluded by the scan.

**Remedy**: this is a **report**, not a fix. See the hygiene section of
`github-checklist.md`. Confirm the file actually contains a credential before
calling it a leak — a `.env` with only `NODE_ENV=development` is harmless.

Where it is a real credential: state that it needs rotating first, that removing
it requires history rewriting, and that both are the user's call.

Do propose adding the pattern to `.gitignore` to prevent recurrence — that part
is safe and additive.

## Check 5 — Oversized tracked files

**Signal**: `layout.largeTracked` — tracked files over 1MB.

Large files bloat every clone permanently, since git keeps them in history.

**Remedy**: distinguish the cases.

- Build artifacts or dependencies: should be gitignored, not tracked
- Data files: propose Git LFS, or gitignore plus a documented fetch step
- Legitimately large assets (images, fonts, sample documents): leave alone

Note that gitignoring an already-tracked file does not shrink history — the same
rewrite constraint applies.

## Check 6 — Missing README

**Signal**: `layout.hasReadme` is false.

**Remedy**: propose a README with what the project is, how to run it, and how to
develop on it. Keep it short. A README and a CLAUDE.md serve different readers —
README is for humans arriving cold, CLAUDE.md is for the agent's working context.
Do not generate one by duplicating the other.

## Check 7 — Test location and consistency

**Signal**: `layout.hasTests` is false while the stack has a test framework, or
tests are split across multiple conventions.

**Remedy**: report the inconsistency and propose one convention. Do not migrate
existing tests as part of onboarding — that is a real refactor with real risk, and
it belongs in its own change.

## Check 8 — Gitignore adequacy

**Signal**: `git.hasGitignore` is false, or present but missing stack essentials.

**Remedy**: propose additions matching `stack.detected`. Show the exact lines to
append rather than replacing the file — an existing `.gitignore` usually contains
deliberate project-specific entries.

Always include `.DS_Store` on macOS.

## Reporting layout findings

Present as a short table. Layout findings are individually small, and a wall of
prose makes them feel heavier than they are:

| File / Area | Finding | Proposal |
|---|---|---|
| `tmp-notes.md` | Scratch file at root | Move to `scratch/` or delete |
| `.env` | Tracked, may contain secrets | Report only — rotate and rewrite is your call |
| `data/large.csv` (14MB) | Oversized tracked file | Git LFS or gitignore |
| — | No `tests/` directory | Create alongside first test |

When the layout is fine, say so in one line and move on. Manufacturing findings to
look thorough wastes the user's review attention on nothing.
