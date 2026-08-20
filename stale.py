#!/usr/bin/env python3
"""List the sessions whose purpose / next-step text needs writing.

  python3 stale.py             one line each — what refresh.sh prints
  python3 stale.py --excerpts  plus the transcript excerpts needed to write them

The rule lives here so the dashboard, refresh.sh and the /session-fleet skill
can never disagree about what counts as stale. render.py imports the same
function; it used to be copied into refresh.sh, which is how the toolbar came to
say 8 while the script said 10.
"""

import argparse
import json
from pathlib import Path

HERE = Path(__file__).parent

# Rough cost of having a model write one purpose + next-steps block.
TOKENS_PER_SUMMARY = 1500


def summary_of(entries, session):
    """The summary for a session, under either of its two ids.

    Importing a CLI session into the Desktop app renames it local_<cliSessionId>,
    and the summary still belongs to it.
    """
    return (entries.get(session.get("cli_session_id") or "")
            or entries.get(session["id"]) or {})


def staleness(session, entry):
    """-> None, "new", "newer activity" or "more turns"."""
    if not entry:
        return "new"
    if session["state"] in ("running", "subagents"):
        return None              # mid-turn sessions are supposed to be moving
    if entry.get("stamp") != session.get("last_activity_at"):
        return "newer activity"
    if entry.get("turns") != session.get("turns"):
        return "more turns"
    return None


def find(data, summaries):
    entries = summaries.get("entries", {})
    out = []
    for s in data["sessions"]:
        e = summary_of(entries, s)
        why = staleness(s, e)
        if why:
            out.append((why, s))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--excerpts", action="store_true",
                    help="print the first/recent user turns and Claude's last word")
    args = ap.parse_args()

    data = json.loads((HERE / "data.json").read_text())
    sp = HERE / "summaries.json"
    summaries = json.loads(sp.read_text()) if sp.exists() else {}
    stale = find(data, summaries)

    if not stale:
        print("none — every summary is current")
        return

    for why, s in stale:
        print(f"[{why}] {s['id']}  {s['title'][:58]}")
        if not args.excerpts:
            continue
        x = s.get("excerpt") or {}
        print(f"    state={s['state']} turns={s['turns']} cwd={s.get('cwd')}"
              f" branch={s.get('branch')}")
        if s.get("question"):
            print(f"    detected question: {s['question']}")
        print(f"    opened with: {x.get('first_user', '')[:600]}")
        for m in (x.get("recent_user") or [])[-3:]:
            print(f"    dean said: {m[:400]}")
        print(f"    claude opened: {x.get('last_assistant', '')[:700]}")
        print(f"    claude closed: {x.get('last_assistant_tail', '')[:700]}")
        print()

    est_k = round(len(stale) * TOKENS_PER_SUMMARY / 1000, 1)
    print(f"{len(stale)} stale · rough cost to rewrite: ~{est_k}k tokens")


if __name__ == "__main__":
    main()
