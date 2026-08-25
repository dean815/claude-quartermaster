#!/usr/bin/env python3
"""Session state: what each Claude session is doing, and whether it needs you.

This module owns the state rules. `collect.py` imports them so the dashboard and
the menu bar can never disagree about what "overdue" means.

The obvious signal for "is Claude working" doesn't exist:
~/.claude/sessions/<pid>.json records a `status` only for CLI sessions, and
Desktop sessions — the majority — have none at all. So phase comes from the
transcript instead: last event a tool call, or the file written in the last 20
seconds, means mid-turn. That is uniform across CLI, Desktop, Cyrus and the SDK,
and costs nothing but a file tail and an mtime.

Standalone:  python3 watcher.py --once
"""

import argparse
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
HOME = Path.home()
PROJECTS = HOME / ".claude/projects"
DESKTOP_ROOT = HOME / "Library/Application Support/Claude/claude-code-sessions"
STATE_FILE = HERE / ".watch-state.json"
SUMMARIES = HERE / "summaries.json"

QUIET_SECONDS = 20        # a turn is over once the transcript stops being written
TAIL_BYTES = 96_000
MAX_AGE_HOURS = 36        # menu bar horizon; the dashboard uses its own window
SUBAGENT_FRESH_SECONDS = 300
STAMP_TOLERANCE = 90      # desktop and transcript clocks differ by a beat

YOUR_TURN_HOURS = 24
IDLE_HOURS = 48

# Phrases that make a trailing sentence a real ask rather than a rhetorical flourish.
ASK_PATTERN = re.compile(
    r"(want me to|should i|shall i|do you want|would you like|which (one|of)|"
    r"prefer|confirm|your call|let me know|ok(ay)? to |go ahead\?)",
    re.I)

# Ordered worst-first for display; keys are used across collect/render/menubar.
STATE_ORDER = ["running", "subagents", "your-turn", "overdue", "idle", "dormant"]
NEEDS_YOU = ("your-turn", "overdue")


# --------------------------------------------------------------------------- helpers

def _text(message):
    if not isinstance(message, dict):
        return None, None
    content = message.get("content")
    if isinstance(content, str):
        return content, "text"
    kinds = [b.get("type") for b in (content or []) if isinstance(b, dict)]
    if "tool_use" in kinds:
        return None, "tool_use"
    parts = [b.get("text", "") for b in (content or [])
             if isinstance(b, dict) and b.get("type") == "text"]
    return "\n".join(parts), "text"


def epoch(v):
    if not v:
        return 0
    if isinstance(v, (int, float)):
        return v / 1000
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0


def tail_events(path, n=12):
    """Last n parsed events of a .jsonl transcript, cheaply."""
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            if size > TAIL_BYTES:
                fh.seek(size - TAIL_BYTES)
                fh.readline()
            raw = fh.read().decode("utf-8", "replace")
    except OSError:
        return []
    out = []
    for line in raw.splitlines()[-80:]:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out[-n:]


# Messages the harness writes into the user's slot: a routine's opening prompt, a
# slash-command invocation, the skill body that follows it, the resumed-session
# caveat. None of them are Dean typing, and mistaking one for a reply is what
# would keep an unattended run on the board.
SYNTHETIC_PREFIXES = ("<scheduled-task", "<command-message>", "<command-name>",
                      "<local-command-caveat>", "Base directory for this skill:")
SCHEDULED_RE = re.compile(r'<scheduled-task name="([^"]+)"')
# The dashboard's own upkeep, run either headless by resummarize.sh or by Dean
# typing the slash command. Either way the session exists to service the board,
# so listing it on the board is just noise about itself.
SELF_CMD_RE = re.compile(r"<command-name>/session-fleet</command-name>")


def origin_of(text):
    """Who started this session, when it was not a person. None if it was.

    Anchored, not a substring search: a later message quoting one of these
    markers is Dean discussing the machinery, not the machinery running.
    """
    text = text.lstrip()
    m = SCHEDULED_RE.match(text)
    if m:
        return m.group(1)
    if SELF_CMD_RE.search(text):
        return "session-fleet"
    return None


def is_synthetic(text):
    return text.startswith(SYNTHETIC_PREFIXES)

def head_check(path):
    """(is_sidechain, is_machine_started) from the first lines of a transcript.

    Machine-started covers a routine's run and the board's own re-summarize
    pass. Neither is ever waiting on a human: whatever they end up asking is
    relayed to whoever triggered them, not read in the thread.
    """
    sidechain = machine = False
    try:
        with path.open("rb") as fh:
            for i, raw in enumerate(fh):
                if i >= 14:
                    break
                try:
                    d = json.loads(raw.decode("utf-8", "replace"))
                except json.JSONDecodeError:
                    continue
                if d.get("isSidechain"):
                    sidechain = True
                blob = d.get("content") if isinstance(d.get("content"), str) else ""
                if not blob:
                    txt, _ = _text(d.get("message"))
                    blob = txt or ""
                if blob and origin_of(blob):
                    machine = True
    except OSError:
        pass
    return sidechain, machine


# --------------------------------------------------------------------------- phase

def classify(path):
    """-> (phase, question, last_text). phase in {waiting, working, unknown}."""
    events = tail_events(path)
    if not events:
        return "unknown", None, ""

    last_text, last_kind, tool_after_text = "", None, False
    for ev in events:
        t = ev.get("type")
        if t == "assistant":
            txt, kind = _text(ev.get("message"))
            if kind == "tool_use":
                last_kind, tool_after_text = "tool", True
            elif txt and txt.strip():
                last_text, last_kind, tool_after_text = txt.strip(), "assistant", False
        elif t == "user" and ev.get("userType") == "external":
            last_kind, last_text = "user", ""
        elif t == "queue-operation":
            last_kind = "user"

    if last_kind != "assistant" or tool_after_text:
        return "working", None, last_text
    try:
        if time.time() - path.stat().st_mtime < QUIET_SECONDS:
            return "working", None, last_text
    except OSError:
        return "unknown", None, last_text

    # An ask is a question in the closing stretch, not any "?" in the whole reply.
    closing, question = last_text[-320:], None
    if "?" in closing:
        for s in reversed([x.strip() for x in re.split(r"(?<=[.!?])\s+", closing) if x.strip()]):
            if s.endswith("?") and (ASK_PATTERN.search(s) or len(s) < 180):
                question = re.sub(r"\s+", " ", s)[:200]
                break
    return "waiting", question, last_text


def subagents_running(path):
    """Subagents still in flight for this session.

    Layout: <project>/<session-id>/subagents/agent-*.{jsonl,meta.json}. The meta
    carries no status, so a subagent counts as running when its log was written
    recently AND the parent has no tool_result for its toolUseId yet. The mtime
    check comes first so the parent scan only happens for plausible candidates.
    """
    d = path.parent / path.stem / "subagents"
    if not d.is_dir():
        return []
    fresh = []
    for meta in d.glob("agent-*.meta.json"):
        log = meta.with_name(meta.name.replace(".meta.json", ".jsonl"))
        try:
            if time.time() - log.stat().st_mtime > SUBAGENT_FRESH_SECONDS:
                continue
            m = json.loads(meta.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if m.get("toolUseId"):
            fresh.append(m)
    if not fresh:
        return []

    try:
        blob = path.read_text(errors="replace")
    except OSError:
        return []
    out = []
    for m in fresh:
        tid = m["toolUseId"]
        done = any(tid in line and '"tool_result"' in line for line in blob.splitlines())
        if not done:
            out.append({"description": m.get("description", "subagent"),
                        "agentType": m.get("agentType", "")})
    return out


# --------------------------------------------------------------------------- waiting

def load_summaries():
    try:
        return json.loads(SUMMARIES.read_text()).get("entries", {})
    except (OSError, json.JSONDecodeError):
        return {}


def summary_for(entries, *ids):
    for i in ids:
        if i and i in entries:
            return entries[i]
    return None


def is_waiting(entry, question, last_activity=None, turns=None):
    """Does this session need something from Dean?

    Either signal is enough: an open action or question bullet in the summary, or
    a question in Claude's closing line.

    Staleness deliberately does NOT disqualify the summary. Treating a stale
    entry as unusable was tried first and collapsed the count to 1 of 17 — every
    summary goes stale the moment a session takes one more turn, and the
    question-only fallback can't see action items at all. A pending "merge PR #2"
    doesn't stop being true because the conversation moved on. Staleness still
    drives the "summary is behind" badge; it just doesn't erase the obligation.
    """
    if entry and any(b.get("type") in ("a", "q") for b in entry.get("next", [])):
        return True
    return question is not None


RUNNING_GRACE_HOURS = 1 / 6.0        # 10 minutes


def classify_state(phase, n_subagents, waiting, age_hours, live=False):
    """The single definition of state, shared by the dashboard and the menu bar.

    Subagents outrank the plain running state: when a Task is in flight the main
    thread is technically mid-turn too, and "subagents running" is the more
    useful thing to say.

    "Working" alone is not enough for Running. A session abandoned mid-tool-call
    three days ago still has a tool_use as its last event forever, which put 11
    of 37 sessions in Running on the first pass. Require either a live process or
    very recent writes.
    """
    if n_subagents:
        return "subagents"
    if phase == "working" and (live or age_hours < RUNNING_GRACE_HOURS):
        return "running"
    if waiting:
        return "your-turn" if age_hours < YOUR_TURN_HOURS else "overdue"
    return "idle" if age_hours < IDLE_HOURS else "dormant"


# --------------------------------------------------------------------------- registry

def desktop_index():
    """cliSessionId -> {title, sessionId, archived} for recently touched sessions."""
    out = {}
    if not DESKTOP_ROOT.is_dir():
        return out
    cutoff = time.time() - MAX_AGE_HOURS * 3600
    for f in DESKTOP_ROOT.rglob("local_*.json"):
        if f.suffix != ".json":
            continue
        try:
            if f.stat().st_mtime < cutoff:
                continue
            d = json.loads(f.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if d.get("cliSessionId"):
            out[d["cliSessionId"]] = {"title": d.get("title") or "",
                                      "sessionId": d.get("sessionId"),
                                      "archived": bool(d.get("isArchived"))}
    return out


def live_pids():
    """cliSessionId -> (pid, name) for sessions whose process is still alive."""
    out = {}
    reg = HOME / ".claude/sessions"
    if not reg.is_dir():
        return out
    for f in reg.glob("*.json"):
        try:
            d = json.loads(f.read_text())
            os.kill(d["pid"], 0)
        except Exception:
            continue
        if d.get("sessionId"):
            out[d["sessionId"]] = (d["pid"], d.get("name") or "")
    return out


NOISE = ("/private/tmp/", "/tmp/", "/var/folders/")


def scan():
    """Current state of every recently-active, non-archived session."""
    desktop, pids, entries = desktop_index(), live_pids(), load_summaries()
    cutoff = time.time() - MAX_AGE_HOURS * 3600
    results = []

    for proj in (PROJECTS.iterdir() if PROJECTS.is_dir() else []):
        if not proj.is_dir():
            continue
        for f in proj.glob("*.jsonl"):
            try:
                mtime = f.stat().st_mtime
                if mtime < cutoff:
                    continue
            except OSError:
                continue
            sid = f.stem

            meta = desktop.get(sid, {})
            if meta.get("archived"):
                continue                       # archived is archived, everywhere

            phase, question, _ = classify(f)
            if phase == "unknown":
                continue
            sidechain, machine = head_check(f)
            if sidechain or machine:
                continue                       # neither is waiting on a human

            cwd = ""
            for ev in tail_events(f, 4):
                if ev.get("cwd"):
                    cwd = ev["cwd"]
                    break
            if not cwd or cwd == "/" or cwd.startswith(NOISE):
                continue

            subs = subagents_running(f)
            last_iso = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z")
            entry = summary_for(entries, sid, meta.get("sessionId") or "")
            waiting = is_waiting(entry, question, last_iso)
            age_h = (time.time() - mtime) / 3600
            pid, reg_name = pids.get(sid, (None, ""))
            state = classify_state(phase, len(subs), waiting, age_h, live=bool(pid))
            desktop_id = meta.get("sessionId")
            results.append({
                "sid": sid,
                "desktop_id": desktop_id,
                "pid": pid,
                "title": meta.get("title") or reg_name or Path(cwd).name or sid[:8],
                "repo": Path(cwd).name if cwd else "",
                "cwd": cwd,
                "state": state,
                "phase": phase,
                "subagents": subs,
                "question": question,
                "mtime": mtime,
                "deeplink": (f"claude://resume?session={sid}"
                             if desktop_id in (None, f"local_{sid}") else None),
            })
    results.sort(key=lambda r: r["mtime"], reverse=True)
    return results


def needs_you(results):
    """Sessions in a state that is literally waiting on Dean."""
    return [r for r in results if r["state"] in NEEDS_YOU]


# --------------------------------------------------------------------------- notify state

def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(st):
    try:
        STATE_FILE.write_text(json.dumps(st))
    except OSError:
        pass


def diff(results, seed=False):
    """Sessions that just stopped working. Seeds silently on first run."""
    prev = load_state()
    fresh, now = [], {}
    for r in results:
        now[r["sid"]] = r["state"]
        was = prev.get(r["sid"])
        if r["state"] in NEEDS_YOU and was in ("running", "subagents"):
            fresh.append(r)
    save_state(now)
    return [] if (seed or not prev) else fresh


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.parse_args()
    results = scan()
    counts = {s: 0 for s in STATE_ORDER}
    for r in results:
        counts[r["state"]] = counts.get(r["state"], 0) + 1
    print(f"{len(results)} sessions · " + " · ".join(f"{k} {v}" for k, v in counts.items()))
    print()
    for r in results:
        if r["state"] == "dormant":
            continue
        tag = f"[{r['state']}]"
        sub = f"  ({len(r['subagents'])} subagents)" if r["subagents"] else ""
        print(f"  {tag:<12} {r['repo'][:18]:<18} {r['title'][:44]}{sub}")
        if r["question"]:
            print(f"               ? {r['question'][:88]}")


if __name__ == "__main__":
    main()
