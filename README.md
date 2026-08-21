# Session Fleet

A dashboard of every Claude Code session on this machine — across the CLI, the
Desktop app, Cyrus, and the Agent SDK — with repo, git state, timestamps, what each
session is for, and what **you** need to do to keep it moving.

## Three ways to run it

**Menu bar agent** (recommended — install once, then forget it):

```bash
~/claude/general/fleetview/install-agent.sh
```

Installs a launchd login agent that puts a mark in your menu bar, lists the sessions
waiting on you in a dropdown that jumps straight into each one, notifies you when a
session finishes its turn, and runs the dashboard server as a child process.
`install-agent.sh uninstall` removes all of it. Menu bar only — no Dock icon.

### The icon

`make_icon.py` draws it from scratch — no image library, no font, just a supersampled
coverage buffer written out as a PNG. A robot head: filled squircle, antenna, ear tabs.

| | |
|---|---|
| **Idle** | Outlined head, no count. |
| **Alert** | Filled head with the eyes knocked out, count beside it. |

Two styles are available — `python3 make_icon.py --style bubble` swaps the head for a
speech bubble. `--preview` prints an ASCII proof without writing anything. A third
design, a cluster of linked bots, was cut: at 20pt the individual heads lose their eyes
and antennae and collapse into plain rounded rectangles.

They're **template images**: shape lives in the alpha channel and macOS paints them
black or white to match the menu bar, so they stay correct in light, dark and
auto-switching modes without a second asset. Rendered at 40px and displayed at 20pt,
which is exactly 2× on Retina — `NSImage` won't resolve an `@2x` sibling from a bare
path, so one oversized bitmap is the reliable way to stay sharp.

Redraw after editing: `python3 make_icon.py`, then `./install-agent.sh`.

### Live monitor

`http://localhost:8787/?monitor=1` starts with auto-refresh on and the toolbar hidden —
for leaving open on a spare screen. The plain URL keeps auto off.

**Just the server**, no menu bar:

```bash
python3 ~/claude/general/fleetview/serve.py
```

Either way <http://localhost:8787> re-scans and re-renders on **every page load**, so
the page is current the moment it appears. There's a Rescan button and an Auto toggle
(reloads every 3 minutes). All of it costs **zero tokens** — the scan is Python plus
`git`, with no model in the loop.

**Published artifact**, shareable and viewable from another device:

```bash
~/claude/general/fleetview/refresh.sh
```

Then ask Claude to republish `fleetview.html` to the existing artifact URL.

## What costs tokens, and what doesn't

| | Cost |
|---|---|
| Scanning sessions, git status, timestamps, state | **0** — pure Python |
| Rendering the page | **0** |
| Auto-refresh every 3 minutes, all day | **0** |
| Menu bar polling every 20 seconds, all day | **0** |
| Rewriting a session's purpose / next steps | ~1.5k tokens per session |

Only the last one needs Claude. A summary goes stale when the session's
**last-activity time or turn count** moves; the page flags those and the
"Re-summarize" button copies a prompt naming exactly which ids need rewriting.
Nothing spends tokens without you asking for it.

From a Claude session in this directory, `/session-fleet refresh` does the whole
loop — rescan, read the excerpts for the stale ids, write the bullets, republish.
`./resummarize.sh` runs that same skill headless, and the menu bar item
**Re-summarize N · ~$X** runs the script after a confirmation.

Measured, not estimated: a run over 10 stale sessions billed **$1.73** and took
about two and a half minutes. That is roughly **$0.17 a session** — well above
what the token estimate on the toolbar implies, because the model reads every
excerpt to write a few lines. It is the only thing here that costs anything,
which is why the menu item prints the price and asks before spending it.

## States

| State | Colour | Meaning |
|---|---|---|
| Running | green | A live process and Claude is mid-turn |
| Subagents | teal | Subagents still in flight for this session |
| Your turn | amber | Waiting on you, touched in the last 24h |
| Overdue | red | Waiting on you, untouched for more than 24h |
| Idle | blue | Nothing pending, active in the last 48h |
| Dormant | grey | Nothing pending, quiet for more than 48h |

The six counter tiles **are** the state filter — click one to filter, click again to
clear, multi-select allowed.

**Waiting on you** means either the summary has an open `→`/`?` bullet, or Claude's
closing line was a question. Staleness deliberately does not disqualify a summary:
requiring a current one collapsed the count to 1 of 17, because every summary goes
stale the moment a session takes another turn and the question-only fallback can't see
action items at all. A pending "merge PR #2" doesn't stop being true because the
conversation moved on.

**Running** requires a live process or writes in the last 10 minutes. Without that
guard a session abandoned mid-tool-call three days ago reads as Running forever — that
put 11 of 37 sessions in the wrong bucket on the first pass.

**Subagents** are detected from `<project>/<session>/subagents/agent-*.meta.json`. The
meta carries no status, so one counts as running when its log was written in the last
5 minutes and the parent transcript has no `tool_result` for its `toolUseId`.

## Sorting and filtering

Sorts: recency · start time · turns · changes · Linear priority. The sort control is
boxed and labelled so it doesn't read as another filter.

Filters: search · time window · folder · client · state tiles. Folder and client are
multi-select popovers; the state tiles are the state filter. Repo and subteam filters
were dropped — folder subsumes repo (about half of all sessions run in
`~/claude/general`, which is not a git repo at all), and subteam is visible on every
row anyway.

## Collapsed vs expanded

Collapsed is one line: title · state · Linear subteam · git counters · client glyph ·
last update, right-aligned on a fixed width so the times line up down the edge.
Expanded adds folder, branch, purpose, next steps, start time, turns and the actions.

The client is a Nerd Font glyph — `f108` Desktop, `e795` CLI, `f109b` API — shown alone
when collapsed and with its label when expanded. Those are Private Use Area codepoints,
so `make_glyphfont.py` subsets a patched font down to just those three and inlines it as
a ~2.7 KB data URI. Without that the published artifact would show tofu on any machine
without a Nerd Font installed.

## Linear

`linear.py` queries the GraphQL API directly with a personal API key — **zero tokens**,
no model in the loop. It reads `LINEAR_API_KEY` from the environment or `.env` (mode 600, gitignored — the
launchd agent does not inherit your shell environment, so the file is what makes it
work under the menu bar app), caches
for 10 minutes, and fails soft: no key, no network or a bad response leaves the columns
blank and the dashboard rendering.

Cyrus's stored OAuth token in `~/.cyrus/config.json` is **not** reusable — it returns
401 with both `Bearer` and raw auth schemes.

Issue matching runs branch → summary text → `links.json` override. Coverage is thin by
nature: most sessions never touch a Linear branch. Subteam is the exception — it comes
from `linear-map.json` (repo/folder → team key), which is configuration rather than
detection, so it covers everything.

Pin a session to an issue by hand in `links.json`:

```json
{ "local_abc123...": "QM-47" }
```

## Next steps are written for you, not about the session

Each bullet is one of three kinds:

| Mark | Meaning |
|---|---|
| `→` | An action you need to take |
| `?` | A question Claude asked and is still waiting on |
| `·` | Context, no action needed |

Sessions with unanswered questions get an **N asks** badge, feed the **Awaiting you**
tile, and sort to the top under **Needs me**.

## Opening a session from the dashboard

`claude://resume?session=<id>` calls the Desktop app's `importCliSession`, which looks
the session up as `local_<id>` — focusing it if it exists, importing it if it doesn't.

That means the link is only safe for sessions where no *different* desktop record
already wraps the transcript. Desktop-native sessions store a `cliSessionId` that
doesn't match their own id, so a deep link would import a **duplicate** alongside the
real session. `collect.py` checks `sessionId == "local_" + cliSessionId` and only emits
a link when it holds — 19 of 37 sessions in a typical scan. The rest show
`Open — n/a` with the reason in a tooltip, plus a **Copy resume cmd** button
(`claude -r <id>`) that works for everything.

## Notifications

The obvious signal doesn't exist: `~/.claude/sessions/<pid>.json` records a `status`
only for **CLI** sessions, and Desktop sessions — the majority — have none at all.

So `watcher.py` reads the transcripts instead. A session is **waiting on you** when the
last event is an assistant text message and the file has been quiet for 20 seconds;
it's **working** when the last event is a tool call or the file was just written. That
is uniform across every interface and costs nothing but a file tail and an `mtime`.

A badge only counts sessions that are waiting **and** still live in the moment — the
process is up, or it went quiet within 90 minutes. Without that, every abandoned
transcript counts as "waiting", which was 152 of them on the first run. Subagent
sidechains and scheduled tasks are excluded; neither is waiting on a human.

If the closing sentences contain a question, it rides along in the notification and
the dropdown, so you can answer without opening anything.

**Permissions:** notifications go through `terminal-notifier`, so macOS attributes
them to that. If nothing appears, enable it under System Settings → Notifications.

## Files

| File | Role |
|---|---|
| `collect.py` | Scans all session stores + git, writes `data.json` |
| `watcher.py` | Turn-completion detector (`--once` to print current state) |
| `menubar.py` | rumps menu bar agent; owns the server as a child process |
| `install-agent.sh` | launchd login agent, install/uninstall |
| `author_summaries.py` | Hand-authored purpose/next bullets → `summaries.json` |
| `summaries.json` | Model-written text, keyed by session id, stamped with time + turns |
| `render.py` | `data.json` + `summaries.json` → HTML (`--local` adds controls) |
| `serve.py` | Local server, rebuilds on every load |
| `refresh.sh` | One-shot rebuild + stale report |
| `resummarize.sh` | Headless `claude -p` run of the skill — the only part that costs money |
| `stale.py` | Which summaries need rewriting — the one definition of "stale" |
| `.claude/skills/session-fleet/` | `/session-fleet refresh` — rescan and rewrite the stale summaries |
| `linear.py` | Linear GraphQL client, disk cache, fail-soft |
| `linear-map.json` | repo/folder → Linear team key |
| `links.json` | optional session id → issue identifier pins |
| `make_glyphfont.py` | subsets the 3 client glyphs into `icons/glyphs.css` |

## Where the data comes from

| Field | Source |
|---|---|
| Title, created, last activity, model | Desktop: `~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json`<br>CLI/SDK: first & last lines of `~/.claude/projects/*/<id>.jsonl` |
| State | `~/.claude/sessions/<pid>.json` when the pid is alive (authoritative), else derived from recency |
| Interface | Transcript `entrypoint` (`claude-desktop`, `cli`, `sdk-cli`, `sdk-ts`), overridden to Cyrus under `~/.cyrus/worktrees` |
| Repo, branch, git status | `git -C <cwd>` at scan time |
| Purpose, next steps | Claude, from transcript excerpts (head for the verdict, tail for open questions) |

## What gets filtered out

Archived sessions, anything under `/tmp` or `/private/tmp`, `cwd` of `/`, and
single-turn probes. Override with `--include-archived` and `--include-noise`.

Also dropped: a scheduled task's own run, when you never replied in the thread
and it did not end on a question. The routine posts its prompt, works, and stops
— nothing is expected back, so it is noise on a board about what needs you. It
reappears the moment either of those is untrue. `--include-routines` keeps them.
Detected from `scheduledTaskId` on the Desktop record, or the `<scheduled-task>`
prompt the harness injects as the opening user message.

## State values

| State | Meaning |
|---|---|
| Running / Live | A live `claude` process holds this session |
| Live · idle | Process alive, waiting on input |
| Warm | No process, active in the last 6 hours |
| Idle | Active 6–48 hours ago |
| Dormant | Older than that, still inside the scan window |

## Security note

`serve.py` binds to `127.0.0.1` only. The page contains excerpts of your session
transcripts — don't expose it beyond this machine.
