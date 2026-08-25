# Archive Tiers and Store Disposition

## The six stores

Archiving a project means deciding what happens in each of these. Deleting the
working directory alone orphans the other five.

| Store | Location | Recoverable if lost? |
|---|---|---|
| Working directory | `<project>/` | Only via the remote, and only what was committed |
| Conversation history | `~/.claude/projects/<encoded>/` | **No. Nothing else holds a copy** |
| Git worktrees | `<project>/.claude/worktrees/`, `.git/worktrees` | Only if pushed |
| GitHub repo | remote | Deletion is permanent; archiving is not |
| Linear | project, label, `~/.claude/linear-sync/registry.json` | Issue history lost on delete |
| project-optimizer | `~/.claude/project-optimizer/registry.json` | Trivially rebuilt |

Conversation history is the asymmetric one. Code is usually reproducible or
pushed; the reasoning that produced it exists in exactly one place.

## Tiers

Pick the tier before doing anything. Most directories do not need the full
procedure, and running it anyway is how archiving becomes a chore nobody does.

### `delete` — nothing of value

For `empty` archetype directories: `contentFiles == 0`.

| Store | Action |
|---|---|
| Working dir | Remove |
| History | Remove if present, mention the size first |
| Everything else | Nothing to do |

No git, no GitHub, no ceremony. Confirm the directory is genuinely empty from the
scan rather than by eye — hidden state is easy to miss.

### `cold` — notes worth keeping, no code

For `context-workspace`: documents, research, specs. No source.

| Store | Action |
|---|---|
| Working dir | Move to the archive root |
| History | Move alongside it — for a notes project this is often the *more* valuable half |
| Git / GitHub | Usually absent. Do not initialize one on the way out |
| Registries | Deregister |

### `full` — a real project, done

| Store | Action |
|---|---|
| Working dir | Verify pushed, then move to the archive root |
| History | Move alongside |
| Worktrees | Remove properly, then prune |
| GitHub | `gh repo archive` — never delete |
| Linear | Set project state to completed; keep the label |
| Registries | Deregister |

### `dormant` — finished, but others may use it

A published library or tool. The repo stays discoverable and installable; only
local state is cleaned up.

| Store | Action |
|---|---|
| Working dir | Move to the archive root (re-cloneable) |
| History | Move alongside |
| GitHub | `gh repo archive` — read-only, keeps URL, issues, stars |
| Registries | Deregister |

Do not make a public repo private on the way out. It breaks every existing clone
and any documentation linking to it.

## Ordering, and why

1. **Resolve blockers** — uncommitted work, stashes, unpushed commits, local-only
   branches, worktrees with unsaved work
2. **Push everything** — the irreversible boundary; nothing is removed before this
3. **Preserve history** — copy before any directory moves, so a failure loses nothing
4. **Remove worktrees** — before touching the main checkout
5. **Move the working directory**
6. **GitHub archive**
7. **Deregister**
8. **Verify, then delete originals**

Copy history *before* moving the working directory. If the move fails halfway,
the irreplaceable part is already safe.

## Store-specific procedure

### Worktrees

```bash
git worktree list
git worktree remove <path>      # never rm -rf — corrupts .git/worktrees metadata
git worktree prune
```

A worktree removed with `rm -rf` leaves the parent repo's metadata pointing at a
directory that no longer exists, and `git worktree add` will later refuse to
reuse the name.

### Conversation history

Locate by the `cwd` recorded inside each transcript, which `archive-preflight.sh`
already does. **Never reverse the encoded directory name** — hyphens in a project
name are indistinguishable from path separators, so
`-Users-deanhicks-claude-career-ops-private` has several plausible readings and
no way to choose between them.

Worktree sessions are recorded under their own encoded directories with a `cwd`
beneath the project, so a project with many worktrees has many history
directories. Preflight returns all of them.

Keep transcripts **outside** any git repository. They routinely contain pasted
credentials, absolute paths, and API responses.

### GitHub

```bash
gh repo archive <owner>/<repo>          # reversible; read-only
```

Archiving preserves the URL, issues, PRs, stars, and forks. `--delete-repo` is
permanent and breaks existing clones' remotes.

Check open issues and PRs first. Archiving a repo with open issues silently
abandons other people's reports.

### Linear

Set the project's state to completed rather than deleting it — deletion discards
the issue history, which is usually the reason the project was tracked. Keep the
issue label; it stays attached to closed issues.

Remove the `~/.claude/linear-sync/registry.json` entry only if the directory is
going away entirely. A moved project keeps its Linear link.

### Untracked credential files

Preflight reports untracked `.env`, `*secrets*`, `*.pem`, and key files. Git will
not preserve them and neither will anything else — they simply disappear with the
directory.

For each, ask: still needed elsewhere, or safe to lose? Never copy one into a git
repository as part of archiving. If the credential is still live, note that
archiving is a good moment to rotate it.

## The archive root

`~/claude-archive/` works. Any location is fine — but note what does **not**
follow from it:

**Being outside `~/claude` does not stop the SessionStart hook.** The hook fires
in any directory that is not in its noise list, wherever it sits. Moving a
project to an archive root therefore re-arms the offer at the new path unless it
is registered. Record both:

```bash
registry.sh set "<original-path>" declined     # if the directory is recreated
registry.sh set "<archived-path>" declined     # the new location
registry.sh set "<archive-root>" declined      # once, covers cd-ing to the root
```

The hook matches exact paths, not prefixes, so registering the archive root does
not cover the projects beneath it — each archived project needs its own entry.

Suggested layout, keeping each project's two halves together:

```
~/claude-archive/<project>/
├── repo/       # the working directory
└── history/    # the conversation transcripts
```
