---
name: session-fleet
description: Refresh the Session Fleet dashboard — rescan every Claude Code session and write the purpose / next-step text for any summary that has gone stale. Use when Dean says "/session-fleet refresh", "refresh the fleet", "re-summarize the fleet", or asks for the session dashboard to be brought up to date.
---

# Session Fleet

The dashboard lives at `${CLAUDE_PLUGIN_ROOT}`. Scanning is free — pure Python,
`git` and one cached Linear call. Only the purpose and next-step prose needs a
model, which is the part this skill exists to do.

Run everything from `${CLAUDE_PLUGIN_ROOT}`.

## `/session-fleet refresh`

Rescan, then rewrite every stale summary.

### 1. Rescan

```bash
cd "${CLAUDE_PLUGIN_ROOT}" && ./refresh.sh
```

Prints the session counts and the stale list. If nothing is stale, say so and
stop — do not burn a model pass confirming what is already current.

### 2. Read what changed

```bash
python3 stale.py --excerpts
```

One block per stale session: its state, turn count, working directory, the
detected open question, how the session opened, Dean's last few messages, and
Claude's first and last words in its closing turn.

Those excerpts are the whole input. **Do not open the raw transcripts** — they
run to megabytes, and the collector already pulled the parts that matter. Only
go to a transcript if an excerpt is genuinely unreadable.

### 3. Write the summaries

Edit the `AUTHORED` dict in `author_summaries.py`, keyed by the id `stale.py`
printed. Each entry is `(purpose, [(type, text), ...])`.

**Purpose** — one sentence, what this session is *for*. Not a transcript recap.

**Bullets** — what is true now, in the order Dean should act:

| type | meaning |
|---|---|
| `q` | an open question from Claude, waiting on Dean's answer |
| `a` | an action Dean has to take |
| `i` | context, no action needed |

Rules that keep the board honest:

- A session with a `q` or `a` bullet counts as needing Dean, and shows as **Your
  turn** or **Overdue**. Never add one for work Claude can finish alone — that
  is what puts phantom items on the board.
- Say the specific thing. "Decide whether to ship M6 as a playable stage view"
  beats "continue the discussion".
- Carry forward what is still true from the previous entry; a summary going
  stale means the session moved, not that its open items were resolved.
- If a session finished with nothing pending, one `i` bullet saying so is the
  right answer.
- Add a `TITLES` entry only when the session's own title is genuinely useless
  (`(untitled)`, a raw `<local-command-caveat>` dump, a first-message fragment).

### 4. Publish

```bash
python3 author_summaries.py && ./refresh.sh
```

`author_summaries.py` regenerates `summaries.json` and stamps each entry with the
session's activity time and turn count, which is what makes it go stale later.
The second `refresh.sh` re-renders both pages.

Confirm the stale count is now zero, and report what you wrote — one line per
session, plus anything you found that Dean should know about.

## Headless

`./resummarize.sh` runs this same skill through `claude -p`, which is what the
menu bar's **Re-summarize** item shells out to. It exits early and free when
nothing is stale. Nothing about the steps above changes — a headless run is the
same work with no one watching, so be more careful, not less, about only writing
`a` and `q` bullets for things that genuinely need Dean.

## Bare `/session-fleet`

Rescan only (`./refresh.sh`) and report the counts and the stale list. Free —
no model involved. Ask before going on to step 3, which is not.

## What the board hides

`collect.py` drops three kinds of session:

- scratchpad and single-turn probe runs (`--include-noise` keeps them)
- archived sessions (`--include-archived`)
- machine-started runs nobody is expected to answer (`--include-routines`) — a
  scheduled task's own session, and **this skill's own run**, unless Dean
  replied in the thread or its summary carries an `a` or `q` bullet

  Signing off with a question does not keep one on the board. Ask for what you
  need in the output — that is what Dean reads — and do not add an `a` or `q`
  bullet to a machine-started run's own summary just to be seen.

That last one includes the session you are in right now, so it will not appear
in the stale list and needs no summary. Never write an entry for it.

Pass those flags to `refresh.sh` to see them: `./refresh.sh 7 --include-routines`.
