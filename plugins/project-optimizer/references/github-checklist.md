# GitHub Configuration Checklist

Four categories, ordered by how much damage their absence causes. Apply the rigor
level from the archetype — a private scratch repo needs category 1 only.

All commands assume `gh` is authenticated. Verify first; when `gh` is missing or
unauthenticated, report the checks as skipped rather than as passing.

```bash
gh auth status
```

**Every command below that mutates the live repository requires explicit approval
first.** Read-only `gh repo view` and `gh api` GET calls may run during scanning.

---

## 1. Repo basics

The baseline that makes a repository legible to anyone, including the user in six
months.

| Check | Scan field | Remedy |
|---|---|---|
| Remote exists | `git.remote` | `gh repo create` |
| Description set | `github.description` | `gh repo edit --description` |
| Topics set | `github.topics` | `gh repo edit --add-topic` |
| License present | `github.license` | Add `LICENSE` file |
| README present | `layout.hasReadme` | Create `README.md` |
| Visibility correct | `github.visibility` | Confirm separately — see below |

```bash
# Create a remote for a repo that has none
gh repo create <name> --private --source=. --remote=origin

# Description and topics
gh repo edit --description "One line on what this is"
gh repo edit --add-topic mcp-server --add-topic python
```

**Visibility is never changed as a routine step.** Making a repo public exposes
its entire history, including anything ever committed and later deleted. Propose
it only when the user raises it, confirm separately from the rest of the plan,
and check `layout.riskyTracked` and the commit history for secrets first.

A missing license on a public repo is a genuine finding: without one, nobody may
legally reuse the code, which usually defeats the point of publishing it.

---

## 2. Hygiene files

Preventing the mistakes that are painful to undo.

| Check | Scan field | Remedy |
|---|---|---|
| `.gitignore` adequate for stack | `git.hasGitignore` | Add or extend |
| No risky tracked files | `layout.riskyTracked` | Report — see below |
| No oversized tracked files | `layout.largeTracked` | Propose LFS or removal |
| `.env.example` present | — | Add when the project uses env vars |

Match `.gitignore` to the detected stack. Common baselines:

- **Node**: `node_modules/`, `dist/`, `.env*` (negate `!.env.example`), `*.log`
- **Python**: `__pycache__/`, `.venv/`, `*.pyc`, `.env`, `.pytest_cache/`
- **Rust**: `target/`, `**/*.rs.bk`
- **Go**: compiled binaries, `vendor/` when not vendoring
- **Always**: `.DS_Store`

**A tracked secret is a report, not a fix.** Deleting the file in a new commit
does not remove it from history — it remains retrievable. The correct response is
to tell the user plainly:

1. The credential should be treated as compromised and rotated **first**
2. Removing it from history requires a rewrite (`git filter-repo` or BFG) and
   coordination with anyone who has cloned
3. Both are the user's decision

Never rewrite history as part of onboarding. Never propose it as a quick fix.

Commit `.env.example` with variable names and empty or placeholder values. It
documents the required environment without leaking anything.

---

## 3. Collaboration config

Earns its place once more than one person touches the repo, or once a broken main
branch has consequences.

| Check | Scan field | Remedy |
|---|---|---|
| Default branch named sensibly | `github.defaultBranch` | `gh repo edit --default-branch` |
| Branch protection on default | `github.branchProtected` | `gh api` — see below |
| PR template | `github.prTemplate` | `.github/pull_request_template.md` |
| Issue templates | `github.issueTemplates` | `.github/ISSUE_TEMPLATE/` |
| CODEOWNERS | `github.codeowners` | `.github/CODEOWNERS` |
| Issues enabled | `github.issuesEnabled` | `gh repo edit --enable-issues` |

```bash
# Branch protection: require PR review and passing checks
gh api -X PUT "repos/<owner>/<repo>/branches/<branch>/protection" \
  -F "required_pull_request_reviews[required_approving_review_count]=1" \
  -F "enforce_admins=false" \
  -F "required_status_checks[strict]=true" \
  -F "required_status_checks[contexts][]=" \
  -F "restrictions=null"
```

Branch protection on a solo repo is a judgment call, not an automatic win — it
means the user cannot push to main directly. Propose it for libraries and
deployed applications; ask before applying it to a personal tool.

Issues being disabled on a public repo is worth flagging: it silently prevents
users from reporting problems, and is often an unintended default.

---

## 4. Automation

| Check | Scan field | Remedy |
|---|---|---|
| CI workflow | `github.workflows` | `.github/workflows/ci.yml` |
| Dependabot | `github.dependabot` | `.github/dependabot.yml` |
| Secret scanning | — | Settings API, public repos get it free |

CI should match the stack and stay minimal — install, lint, test, on push and PR.
An elaborate pipeline nobody maintains is worse than none, because a permanently
red badge trains everyone to ignore it.

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"      # or pip, cargo, gomod
    directory: "/"
    schedule:
      interval: "weekly"
```

Set the ecosystem from `stack.packageManager`. Weekly beats daily — daily
generates enough noise that the PRs stop being read.

```bash
# Secret scanning and push protection (public repos, or private with Advanced Security)
gh api -X PATCH "repos/<owner>/<repo>" \
  -F "security_and_analysis[secret_scanning][status]=enabled" \
  -F "security_and_analysis[secret_scanning_push_protection][status]=enabled"
```

Push protection is the highest-value item in this category: it blocks credentials
at push time, which is the only point where the fix is still cheap.

---

## Token scope limits

The authenticated token may lack scopes for some operations. When a `gh` call
fails with a permissions error, report exactly which scope is missing and the
command to add it, rather than retrying:

```bash
gh auth refresh -h github.com -s <missing-scope>
```

`admin:repo_hook` is needed for webhooks; `workflow` is needed to modify workflow
files **via the API** — pushing them over SSH does not require it.
