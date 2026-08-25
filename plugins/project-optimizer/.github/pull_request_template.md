## What changed

<!-- One or two sentences. What does this do that the code did not do before? -->

## Why

<!-- The problem being solved. Link an issue if there is one. -->

## Verification

<!-- How you know it works. Paste relevant output. -->

- [ ] `bash tests/run.sh` passes
- [ ] Tested by loading the plugin: `claude --plugin-dir .`

## Checklist

- [ ] Changes to `scripts/` are covered by a test in `tests/run.sh`
- [ ] No filename or other untrusted input is interpolated into a command string
- [ ] `scripts/session-start.sh` still writes nothing
- [ ] Skill changes keep `SKILL.md` lean, with detail in `references/`
