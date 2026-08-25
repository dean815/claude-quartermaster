---
name: Bug report
about: Something the plugin did wrong
labels: bug
---

## What happened

<!-- What the plugin did. If the hook offered onboarding when it should not have,
     or stayed silent when it should have offered, say which. -->

## What you expected

## Reproduction

Directory type (git repo? has CLAUDE.md? has a remote?):

```
# Output of the scan for the affected project, with any private paths redacted:
bash scripts/scan-project.sh <path> --no-github
```

## Environment

- OS:
- `bash --version`:
- `jq --version`:
- `gh --version` (if the issue involves GitHub checks):
- Claude Code version:

## Notes

- Hook changes need a full Claude Code restart to take effect — please confirm
  you restarted before filing.
- `bash tests/run.sh` output, if it fails:
