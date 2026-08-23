#!/usr/bin/env python3
"""Collect Claude Code session state across every interface into one JSON blob.

Sources
  desktop : ~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json
  cli/sdk : ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
  live    : ~/.claude/sessions/<pid>.json   (running processes, authoritative for State)
  git     : `git -C <cwd> ...` per unique working directory

Emits data.json. Purpose/next-steps are NOT written here — the collector only
extracts the transcript excerpts a model needs to write them (see summaries.json).

Usage: python3 collect.py [--days 7] [--out data.json]
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import linear as linear_mod
import watcher

HOME = Path.home()
DESKTOP_ROOT = HOME / "Library/Application Support/Claude/claude-code-sessions"
PROJECTS = HOME / ".claude/projects"
LIVE = HOME / ".claude/sessions"

# How much of a transcript's tail to read for "where did this leave off".
TAIL_BYTES = 400_000
EXCERPT_CHARS = 700

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
    """Who started this session, when it was not a person. None if it was."""
    m = SCHEDULED_RE.match(text)
    if m:
        return m.group(1)
    if SELF_CMD_RE.search(text):
        return "session-fleet"
    return None


def is_synthetic(text):
    return text.startswith(SYNTHETIC_PREFIXES)


# --------------------------------------------------------------------------- utils

def iso(ms_or_str):
    """Normalize epoch-ms or an ISO string to a UTC ISO-8601 string."""
    if ms_or_str is None:
        return None
    if isinstance(ms_or_str, str):
        return ms_or_str
    return datetime.fromtimestamp(ms_or_str / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def epoch(v):
    if v is None:
        return 0
    if isinstance(v, (int, float)):
        return v / 1000
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0


def text_of(message):
    """Flatten an Anthropic message content block list to plain text."""
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    out = []
    for block in content or []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            out.append(block.get("text", ""))
        elif block.get("type") == "tool_use":
            out.append(f"[tool:{block.get('name')}]")
    return "\n".join(out)


def clean(s, limit=EXCERPT_CHARS):
    if not s:
        return ""
    s = re.sub(r"<system-reminder>.*?</system-reminder>", "", s, flags=re.S)
    s = re.sub(r"<[a-z-]+-hook[^>]*>.*?</[a-z-]+-hook>", "", s, flags=re.S)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit]


# --------------------------------------------------------------------------- git

_git_cache = {}


def git_info(cwd):
    """Branch, porcelain status summary and repo identity for a working directory."""
    if cwd in _git_cache:
        return _git_cache[cwd]

    info = {"repo": None, "remote": None, "branch": None, "dirty": None,
            "ahead": 0, "behind": 0, "exists": os.path.isdir(cwd), "is_repo": False}

    def run(*args):
        try:
            r = subprocess.run(("git", "-C", cwd) + args, capture_output=True,
                               text=True, timeout=10)
            return r.stdout.strip() if r.returncode == 0 else None
        except (subprocess.SubprocessError, OSError):
            return None

    if info["exists"]:
        top = run("rev-parse", "--show-toplevel")
        if top:
            info["is_repo"] = True
            info["repo"] = os.path.basename(top)
            info["remote"] = run("remote", "get-url", "origin")
            info["branch"] = run("rev-parse", "--abbrev-ref", "HEAD")

            porcelain = run("status", "--porcelain") or ""
            lines = [l for l in porcelain.splitlines() if l.strip()]
            counts = {"added": 0, "modified": 0, "deleted": 0, "untracked": 0}
            for l in lines:
                code = l[:2]
                if code == "??":
                    counts["untracked"] += 1
                elif "D" in code:
                    counts["deleted"] += 1
                elif "A" in code or "R" in code or "C" in code:
                    counts["added"] += 1
                else:
                    counts["modified"] += 1
            counts["total"] = len(lines)
            info["dirty"] = counts

            counts = run("rev-list", "--left-right", "--count", "@{upstream}...HEAD")
            if counts:
                try:
                    behind, ahead = (int(x) for x in counts.split())
                    info["behind"], info["ahead"] = behind, ahead
                except ValueError:
                    pass

    # Claude Code records gitBranch "HEAD" outside a repo; that is not a branch.
    if info["branch"] in ("HEAD", ""):
        info["branch"] = None

    # A worktree under .cyrus or .claude/worktrees still belongs to its parent repo.
    if not info["repo"]:
        info["repo"] = os.path.basename(cwd.rstrip("/")) or cwd
    _git_cache[cwd] = info
    return info


# --------------------------------------------------------------------------- live registry

def live_processes():
    """Map sessionId -> live process record for sessions with a running claude pid."""
    out = {}
    if not LIVE.is_dir():
        return out
    for f in LIVE.glob("*.json"):
        try:
            d = json.loads(f.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        pid = d.get("pid")
        if not pid:
            continue
        try:
            os.kill(pid, 0)          # signal 0 = liveness probe, does not touch the process
        except (ProcessLookupError, PermissionError, OSError):
            continue
        sid = d.get("sessionId")
        if sid:
            out[sid] = d
    return out


# --------------------------------------------------------------------------- transcripts

def read_transcript(path):
    """Pull metadata + conversation excerpts from a .jsonl transcript.

    Reads the head for identity and the tail for recency so multi-megabyte
    transcripts stay cheap.
    """
    res = {"cwd": None, "branch": None, "entrypoint": None, "version": None,
           "sidechain": False, "first_user": "", "recent_user": [],
           "last_assistant": "", "last_assistant_tail": "",
           "turns": 0, "first_ts": None, "last_ts": None,
           "skills": [], "title": None,
           "origin": None, "human_turns": 0}

    size = path.stat().st_size
    # Head and tail overlap on short transcripts, so every user message gets fed
    # twice. human_turns has to be exact, hence the uuid guard.
    seen_user = set()

    def feed(line, head):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            return
        if d.get("isSidechain"):
            res["sidechain"] = True
        for key in ("cwd", "gitBranch", "entrypoint", "version"):
            if d.get(key) and not res[{"gitBranch": "branch"}.get(key, key)]:
                res[{"gitBranch": "branch"}.get(key, key)] = d[key]
        ts = d.get("timestamp")
        if ts:
            if not res["first_ts"] or (head and ts < res["first_ts"]):
                res["first_ts"] = ts
            if not res["last_ts"] or ts > res["last_ts"]:
                res["last_ts"] = ts
        if d.get("customTitle"):
            res["title"] = d["customTitle"]
        if d.get("attributionSkill"):
            res["skills"].append(d["attributionSkill"])

        t = d.get("type")
        if t == "user" and d.get("userType") == "external":
            txt = clean(text_of(d.get("message")))
            if txt and not txt.startswith("[tool:"):
                res["turns"] += 1
                if head and not res["first_user"]:
                    res["first_user"] = txt
                if not head:
                    res["recent_user"].append(txt)
                key = d.get("uuid") or (ts, txt[:60])
                if key not in seen_user:
                    seen_user.add(key)
                    # Only the opening message says who started the session. A
                    # /session-fleet run later in one of Dean's own threads is
                    # him working, not the board servicing itself.
                    if head and len(seen_user) == 1:
                        res["origin"] = origin_of(txt)
                    if not is_synthetic(txt):
                        res["human_turns"] += 1
        elif t == "assistant" and not head:
            txt = clean(text_of(d.get("message")), 4000)
            if txt:
                # Head carries the verdict; tail carries the open questions and
                # asks. Both matter, and they are usually not the same text.
                res["last_assistant"] = txt[:900]
                res["last_assistant_tail"] = txt[-900:]

    with path.open("rb") as fh:
        for i, raw in enumerate(fh):
            if i >= 60:
                break
            feed(raw.decode("utf-8", "replace"), head=True)

        if size > TAIL_BYTES:
            fh.seek(size - TAIL_BYTES)
            fh.readline()            # discard the partial line the seek landed inside
        else:
            fh.seek(0)
        for raw in fh:
            feed(raw.decode("utf-8", "replace"), head=False)

    res["recent_user"] = res["recent_user"][-4:]
    res["skills"] = sorted(set(res["skills"]))[:6]
    return res


def index_transcripts(cutoff):
    """sessionId -> transcript path, for every top-level transcript touched since cutoff."""
    idx = {}
    if not PROJECTS.is_dir():
        return idx
    for proj in PROJECTS.iterdir():
        if not proj.is_dir():
            continue
        for f in proj.glob("*.jsonl"):
            try:
                if f.stat().st_mtime < cutoff:
                    continue
            except OSError:
                continue
            idx[f.stem] = f
    return idx


# --------------------------------------------------------------------------- interface

# Throwaway working directories: harness scratchpads and probe runs launched from /.
NOISE_PREFIXES = ("/private/tmp/", "/tmp/", "/var/folders/")


def is_noise(cwd, turns):
    """True for sessions that are test harness runs rather than real work."""
    if not cwd or cwd == "/":
        return True
    if cwd.startswith(NOISE_PREFIXES):
        return True
    return turns < 2


def is_unattended(origin, human_turns, waiting):
    """True for a machine-started run that never turned into a conversation.

    Two kinds qualify: a scheduled task's own run, and the dashboard's own
    re-summarize pass. Both post a prompt, work, and stop — nothing is expected
    back, so listing them is noise on a board about what needs Dean. Either one
    stops being noise the moment he replies in the thread, or the run ends on
    something addressed to him.
    """
    return bool(origin) and not human_turns and not waiting


def classify(cwd, entrypoint, kind):
    """Best-effort mapping to a human-facing interface name."""
    cwd = cwd or ""
    if "/.cyrus/worktrees/" in cwd or cwd.startswith(str(HOME / ".cyrus")):
        return "Cyrus"
    if entrypoint == "claude-desktop":
        return "Claude Code Desktop"
    if entrypoint == "cli":
        return "Claude Code CLI"
    if entrypoint in ("sdk-cli", "sdk-ts"):
        return "Agent SDK" if kind != "scheduled" else "Scheduled task"
    return "Unknown"


# --------------------------------------------------------------------------- collection

def collect_desktop(cutoff, transcripts):
    sessions = []
    if not DESKTOP_ROOT.is_dir():
        return sessions
    for f in DESKTOP_ROOT.rglob("local_*.json"):
        if f.suffix != ".json":
            continue
        try:
            if f.stat().st_mtime < cutoff:
                continue
            d = json.loads(f.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if epoch(d.get("lastActivityAt")) < cutoff:
            continue
        sessions.append({
            "id": d.get("sessionId"),
            "cli_session_id": d.get("cliSessionId"),
            "source": "desktop",
            "title": d.get("title"),
            "title_source": d.get("titleSource"),
            "cwd": d.get("cwd") or d.get("originCwd"),
            "created_at": iso(d.get("createdAt")),
            "last_activity_at": iso(d.get("lastActivityAt")),
            "archived": bool(d.get("isArchived")),
            "model": d.get("model"),
            "effort": d.get("effort"),
            "permission_mode": d.get("permissionMode"),
            "turns": d.get("completedTurns"),
            "entrypoint": "claude-desktop",
            "origin": d.get("scheduledTaskId"),
        })
    return sessions


def collect_transcript_only(cutoff, transcripts, claimed):
    sessions = []
    for sid, path in transcripts.items():
        if sid in claimed:
            continue
        try:
            t = read_transcript(path)
        except (OSError, json.JSONDecodeError):
            continue
        if t["sidechain"] or t["turns"] == 0:
            continue
        if epoch(t["last_ts"]) < cutoff:
            continue
        sessions.append({
            "id": sid,
            "cli_session_id": sid,
            "source": "transcript",
            "title": t["title"],
            "title_source": "auto" if t["title"] else None,
            "cwd": t["cwd"],
            "created_at": t["first_ts"],
            "last_activity_at": t["last_ts"],
            "archived": False,
            "model": None,
            "effort": None,
            "permission_mode": None,
            "turns": t["turns"],
            "entrypoint": t["entrypoint"],
            "origin": t["origin"],
            "_transcript": t,
        })
    return sessions


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=float, default=7)
    ap.add_argument("--out", default=str(Path(__file__).parent / "data.json"))
    ap.add_argument("--include-archived", action="store_true")
    ap.add_argument("--include-routines", action="store_true",
                    help="keep machine-started runs nobody is expected to answer")
    ap.add_argument("--include-noise", action="store_true",
                    help="keep scratchpad and single-turn probe sessions")
    args = ap.parse_args()

    cutoff = time.time() - args.days * 86400
    live = live_processes()
    transcripts = index_transcripts(cutoff)

    summaries = watcher.load_summaries()
    linear_data = linear_mod.fetch()
    try:
        links = json.loads((Path(__file__).parent / "links.json").read_text())
    except (OSError, json.JSONDecodeError):
        links = {}

    desktop = collect_desktop(cutoff, transcripts)
    claimed = {s["cli_session_id"] for s in desktop if s["cli_session_id"]}
    claimed |= {s["id"] for s in desktop}
    rest = collect_transcript_only(cutoff, transcripts, claimed)

    out = []
    for s in desktop + rest:
        t = s.pop("_transcript", None)
        if t is None:
            tp = transcripts.get(s.get("cli_session_id") or "")
            if tp:
                try:
                    t = read_transcript(tp)
                except (OSError, json.JSONDecodeError):
                    t = None
        t = t or {}

        cwd = s["cwd"] or t.get("cwd") or ""
        turns = s["turns"] or t.get("turns") or 0
        if s["archived"] and not args.include_archived:
            continue
        if is_noise(cwd, turns) and not args.include_noise:
            continue

        proc = live.get(s.get("cli_session_id")) or live.get(s["id"])
        g = git_info(cwd) if cwd else {}

        # State comes from watcher, which owns the rules so the dashboard and the
        # menu bar can never disagree about what "overdue" means.
        age_h = (time.time() - epoch(s["last_activity_at"])) / 3600
        tp = transcripts.get(s.get("cli_session_id") or "")
        if tp:
            phase, question, _ = watcher.classify(tp)
            subs = watcher.subagents_running(tp)
        else:
            phase, question, subs = "waiting", None, []

        entry = watcher.summary_for(summaries, s.get("cli_session_id") or "", s["id"])
        waiting = watcher.is_waiting(entry, question)
        state = watcher.classify_state(phase, len(subs), waiting, age_h,
                                       live=bool(proc))

        origin = s.get("origin") or t.get("origin")
        if (proc or {}).get("kind") == "scheduled":
            origin = origin or "scheduled"
        if (is_unattended(origin, t.get("human_turns", 0), waiting)
                and not args.include_routines):
            continue

        # claude://resume?session=<id> calls importCliSession, which looks the
        # session up as "local_<id>". If that record already exists it focuses it;
        # if not it imports a fresh one. So the link is only safe when no
        # DIFFERENT desktop record already wraps this transcript — otherwise the
        # app would create a duplicate session alongside the real one.
        cli_id = s.get("cli_session_id")
        desktop_native = s["source"] == "desktop" and s["id"] != f"local_{cli_id}"
        deeplink = (f"claude://resume?session={cli_id}"
                    if cli_id and not desktop_native else None)

        out.append({
            "id": s["id"],
            "cli_session_id": cli_id,
            "deeplink": deeplink,
            "resume_cmd": f"claude -r {cli_id}" if cli_id else None,
            "title": s["title"] or (proc or {}).get("name") or clean(t.get("first_user", ""), 70) or "(untitled)",
            "title_source": s["title_source"],
            "interface": classify(cwd, s.get("entrypoint") or t.get("entrypoint"),
                                  (proc or {}).get("kind")),
            "state": state,
            "phase": phase,
            "subagents": subs,
            "question": question,
            "waiting": waiting,
            "origin": origin,
            "pid": (proc or {}).get("pid"),
            "archived": s["archived"],
            "cwd": cwd,
            "folder": os.path.basename(cwd.rstrip("/")) or cwd,
            "repo": g.get("repo"),
            "remote": g.get("remote"),
            "is_repo": g.get("is_repo", False),
            "path_exists": g.get("exists", False),
            "branch": g.get("branch") or (t.get("branch") if t.get("branch") != "HEAD" else None),
            "git": g.get("dirty"),
            "ahead": g.get("ahead", 0),
            "behind": g.get("behind", 0),
            "created_at": s["created_at"] or t.get("first_ts"),
            "last_activity_at": s["last_activity_at"] or t.get("last_ts"),
            "model": s["model"],
            "effort": s["effort"],
            "permission_mode": s["permission_mode"],
            "turns": turns,
            "skills": t.get("skills", []),
            # Excerpts feed the purpose / next-steps pass. Not rendered verbatim.
            "excerpt": {
                "first_user": t.get("first_user", ""),
                "recent_user": t.get("recent_user", []),
                "last_assistant": t.get("last_assistant", ""),
                "last_assistant_tail": t.get("last_assistant_tail", ""),
            },
        })

    # Linear enrichment. The summary text is a real source of issue ids — several
    # next-step bullets name them — so it is fed to the matcher alongside branch.
    for rec in out:
        entry = watcher.summary_for(summaries, rec.get("cli_session_id") or "", rec["id"])
        rec["_summary_text"] = " ".join(
            [(entry or {}).get("purpose", "")]
            + [b.get("text", "") for b in (entry or {}).get("next", [])])
        rec.update(linear_mod.enrich(rec, linear_data, links))
        rec.pop("_summary_text", None)

    out.sort(key=lambda s: epoch(s["last_activity_at"]), reverse=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "window_days": args.days,
        "host": os.uname().nodename,
        "linear": {"ok": linear_data.get("ok"), "error": linear_data.get("error"),
                   "teams": linear_data.get("teams", {})},
        "sessions": out,
    }
    Path(args.out).write_text(json.dumps(payload, indent=2))
    print(f"{len(out)} sessions -> {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
