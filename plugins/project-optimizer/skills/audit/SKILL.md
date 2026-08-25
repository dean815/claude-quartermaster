---
name: audit
description: This skill should be used when the user asks to "audit this project", "check project configuration", "what's missing in this repo", "is this project set up correctly", "has this project drifted", "re-run the project checks", "audit all my projects", or "which of my projects need setup". Reports configuration gaps read-only, ranked by severity, and changes nothing — use the onboard skill instead when the user wants the gaps fixed. Supports a batch mode that ranks every project under a directory.
argument-hint: "[path] [--fix] | --batch <root>"
allowed-tools: Read, Bash, Glob, Grep, Skill
---

# Project Audit

Report configuration gaps in one project or across many. **This skill never
changes anything** — it finds and ranks problems; `onboard` fixes them.

Projects drift: a repo goes public without gaining a license, a CLAUDE.md goes
stale after a rewrite, a `.env` gets committed. Audit catches that, and also
triages projects that were never onboarded at all.

## Invocation

Default the path to the current working directory when none is given, and resolve
it to an absolute path — the registry is keyed by absolute path and will not match
otherwise.

## Single project

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/scan-project.sh" "<project-path>"
```

Report findings grouped by the four areas, each rated:

- **Blocking** — actively harmful right now: a tracked secret, a public repo with
  no license, credentials in a committed file
- **Gap** — a missing baseline: no CLAUDE.md, no README, no `.gitignore`,
  unscoped plugin config
- **Polish** — worth doing but not urgent: missing topics, no PR template, no
  Dependabot

Order by severity, not by area. State what was checked and found fine in a single
closing line rather than enumerating passes — the value is in the gaps.

For each finding, give the concrete remedy: the exact command, file, or setting.
A finding the user cannot act on is noise.

### Drift versus gap

Look up the registry entry and compare against it:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/registry.sh" get "<absolute-path>"
```

An empty object means the project was never onboarded — report gaps, not drift.
Otherwise note explicitly when something configured during onboarding has since
regressed. That is drift, and it is more interesting than a gap never filled.

## Batch mode

With `--batch <root>`, sweep every immediate subdirectory and rank them.

```bash
for d in "<root>"/*/; do
  [ -d "$d" ] || continue
  bash "${CLAUDE_PLUGIN_ROOT}/scripts/scan-project.sh" "$d" --no-github
done
```

Always pass `--no-github` in batch mode. A sweep of thirty projects makes sixty
network calls otherwise, which is slow and burns API quota for information that is
mostly not needed at triage time.

Each scan object carries its own absolute `path` — key the table off that rather
than loop order.

**Separate non-projects before ranking.** Following the classification order in
`references/archetypes.md`, split out directories where `contentFiles == 0`
(`empty`) or `sourceFiles == 0` (`context-workspace`). These
are not gaps to be filled, and counting a missing CLAUDE.md against a notes
directory inflates the report with work nobody should do. Report them as a single
collapsed line — "N directories are notes or empty, not projects" — and exclude
them from the ranking.

Present the remaining projects as a single ranked table:

| Project | Stack | CLAUDE.md | README | Scoped config | Blocking | Gaps | Last commit |
|---|---|---|---|---|---|---|---|

Rank by a stated rule: blocking findings first, then gap count, then recency from
`git.lastCommitEpoch`. State the rule in the output so the ordering is legible
rather than mysterious.

A mechanical rank cannot tell dormant from neglected. When the top of the table is
a project untouched for a year, say so rather than recommending it first.

Close with the three to five projects most worth onboarding first, and why. Do not
offer to onboard all of them in one pass — that is far too much change to review at
once. Suggest working through them individually.

## The --fix flag

`--fix` does not apply changes directly. It hands off to the `onboard` skill for a
single project. Invoke the Skill tool with `project-optimizer:onboard` and the
project path, carrying the audit findings forward so the scan is not repeated. All
of onboard's plan-then-apply behavior governs from that point — the audit findings
become the starting proposal, not an approved changelist.

## Constraints

- Never create, modify, move, or delete a file — including `.gitignore` additions
  and `.github/` templates that seem obviously correct. Report them as findings
- Never issue a `gh` mutation. Read-only `gh` queries via the scan script only
- Never run `git commit`, `git push`, `git checkout`, or any history operation
- Never write a registry entry. Auditing is not onboarding, and a project that was
  audited has not been optimized
- Refuse `--fix` in batch mode. Fixing many projects unattended is exactly the kind
  of bulk change that should not happen without per-project review

## Reporting honestly

Report what the scan actually found. When a probe could not run — `gh` missing,
network unavailable, not a git repo — say the check was skipped and why. Never
report an unrun check as a pass. In particular, `github.reachable: false` means the
repo state is **unknown**, not that the repo is missing.

When the scan emits an `error` key instead of a result (`jq` missing, path not a
directory), report the scan as failed for that project rather than as a project
with no findings. In batch mode this matters especially — thirty identical error
objects must not be read as thirty clean projects.

The `riskyTracked` list flags files by name pattern; it is a prompt to look, not
proof of a leak. Confirm before calling something a committed secret, and note
that removing one from history is a decision for the user, not an audit action.

## Additional Resources

### Reference Files

Shared with the `onboard` skill:

- **`${CLAUDE_PLUGIN_ROOT}/references/archetypes.md`** — Expectations per project type
- **`${CLAUDE_PLUGIN_ROOT}/references/github-checklist.md`** — What "properly
  configured" means for each GitHub category
- **`${CLAUDE_PLUGIN_ROOT}/references/layout-checks.md`** — Directory organization checks

### Scripts

- **`${CLAUDE_PLUGIN_ROOT}/scripts/scan-project.sh`** — Deterministic scan, emits JSON
- **`${CLAUDE_PLUGIN_ROOT}/scripts/registry.sh get|list`** — Recorded state
  (`get` takes an absolute path)
