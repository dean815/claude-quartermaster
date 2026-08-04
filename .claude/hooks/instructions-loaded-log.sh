#!/bin/sh
# InstructionsLoaded probe (DEA-126). An instrument, not part of the tool.
#
# `qm` never installs this. It fires only if a settings file registers it, and the file
# that does -- `.claude/settings.local.json` -- is gitignored, so cloning this repo gets
# the script and no behaviour. That asymmetry is deliberate: a hook is a live-environment
# write, and one that arrives with a checkout is one nobody chose.
#
# To wire it up, add to `.claude/settings.local.json`:
#
#     { "hooks": { "InstructionsLoaded": [ { "hooks": [
#         { "type": "command",
#           "command": "sh \"$CLAUDE_PROJECT_DIR/.claude/hooks/instructions-loaded-log.sh\"",
#           "timeout": 5 } ] } ] } }
#
# Then start a *new* session -- hooks load at startup.
#
# What it is for. Three of quartermaster's detectors rest on documented mechanism rather
# than observation: that `@path` imports load at launch, that `paths:`-scoped rules defer,
# and which memory files load against the 200-line limit. This event reports the first two
# directly. Measured 2026-08-02 on v2.1.220: an unscoped rule fires at `session_start`, a
# `paths:`-scoped one does not -- so scoping genuinely defers. The control is what makes
# that a finding: a scoped rule's silence alone is equally consistent with `.claude/rules/`
# not being read at all.
#
# It does *not* cover auto-memory. All 11 firings observed were CLAUDE.md or
# `.claude/rules/*.md`, matching the changelog's scope for the event, and `MEMORY.md` never
# appeared -- so `oversizedMemory` cannot be grounded this way.
#
# The payload is logged whole rather than parsed. Its shape is undocumented, and guessing a
# field name yields an empty log indistinguishable from "the hook never fired" -- the one
# answer this experiment must not fabricate. Observed fields: `session_id`,
# `transcript_path`, `cwd`, `hook_event_name`, `file_path`, `memory_type` (User/Project),
# and `load_reason`. `load_reason` is the instrument; `session_start` being one *value* of
# it rather than the only thing reported is what makes deferral observable.
#
# The log holds absolute paths and session ids, so it stays out of git -- covered by the
# `*.log` rule in .gitignore. Writes only to this repo's `.claude/`, never to `~/.claude/`.

LOG="$CLAUDE_PROJECT_DIR/.claude/instructions-loaded.log"
printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(cat)" >> "$LOG"
exit 0
