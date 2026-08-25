#!/usr/bin/env python3
"""Linear enrichment for Session Fleet. Zero tokens — direct GraphQL, no model.

Needs a read-only personal API key in fleetview/.env:

    LINEAR_API_KEY=lin_api_...

Create one at Linear -> Settings -> Security & access -> Personal API keys.
Cyrus's stored OAuth token in ~/.cyrus/config.json is NOT reusable — it returns
401 against the GraphQL API with both Bearer and raw auth schemes.

Everything here fails soft. No key, no network, a bad response, a schema change:
all of them return an empty result rather than raising, because a dashboard that
refuses to render because Linear is down is worse than one with blank columns.

  python3 linear.py          # show what would be fetched
  python3 linear.py --raw    # dump the cache payload
"""

import argparse
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
ENV = HERE / ".env"
CACHE = HERE / ".linear-cache.json"
REPO_MAP = HERE / "linear-map.json"
API = "https://api.linear.app/graphql"

CACHE_TTL = 600           # 10 minutes; a 3-minute monitor then hits Linear ~6x/hour
TIMEOUT = 12
ISSUE_LIMIT = 250

# Linear priority is 0=none, 1=urgent .. 4=low. Sort "none" last, not first.
PRIORITY_RANK = {1: 0, 2: 1, 3: 2, 4: 3, 0: 9}

QUERY = """
{
  teams(first: 100) { nodes { id key name color icon parent { key name } } }
  issues(first: %d, orderBy: updatedAt,
         filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
    nodes {
      identifier title url priority priorityLabel
      state { name type }
      team { key name parent { key name } }
    }
  }
}
""" % ISSUE_LIMIT

IDENT_RE = re.compile(r"\b([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,5})\b")

# Linear stores a team icon either as a Slack-style shortcode or as the name of
# one of its own vector icons, and neither is renderable here. Only the ones the
# workspace actually uses are mapped; an unknown icon simply drops out and the
# team keeps its colour, which is the half that carries the identification.
TEAM_ICON = {
    ":face_with_cowboy_hat:": "\U0001f920", ":lizard:": "\U0001f98e",
    ":circus_tent:": "\U0001f3aa",          ":robot_face:": "\U0001f916",
    ":moneybag:": "\U0001f4b0",             ":broccoli:": "\U0001f966",
    ":ticket:": "\U0001f3ab",               ":headphones:": "\U0001f3a7",
    ":briefcase:": "\U0001f4bc",            ":minidisc:": "\U0001f4bd",
    ":male-technologist:": "\U0001f468\u200d\U0001f4bb", ":golf:": "\u26f3",
    "Cloud": "\u2601\ufe0f", "Golf": "\u26f3", "Home": "\U0001f3e0",
    "Claude": "\u2733\ufe0f", "Mic": "\U0001f3a4", "Attachment": "\U0001f4ce",
    "Team": "\U0001f465", "Dino": "\U0001f995", "Mask": "\U0001f3ad",
    "Robot": "\U0001f916", "Dollar": "\U0001f4b5", "Label": "\U0001f3f7\ufe0f",
    "Hear": "\U0001f442", "Briefcase": "\U0001f4bc", "FloppyDisk": "\U0001f4be",
    "Computer": "\U0001f4bb",
}


def api_key():
    """Key from the environment, else from .env. Never logged."""
    import os
    if os.environ.get("LINEAR_API_KEY"):
        return os.environ["LINEAR_API_KEY"].strip()
    try:
        for line in ENV.read_text().splitlines():
            line = line.strip()
            if line.startswith("LINEAR_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def repo_team_map():
    """repo or folder name -> Linear team key.

    Configuration, not detection: only a handful of sessions carry a discoverable
    issue id, so this map is what gives the subteam filter full coverage.
    """
    try:
        return json.loads(REPO_MAP.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _cached():
    try:
        blob = json.loads(CACHE.read_text())
        if time.time() - blob.get("fetched_at", 0) < CACHE_TTL:
            return blob
    except (OSError, json.JSONDecodeError):
        pass
    return None


def fetch(force=False):
    """-> {ok, error, teams, issues, fetched_at}. Never raises."""
    empty = {"ok": False, "error": None, "teams": {}, "issues": {}, "fetched_at": 0}

    if not force:
        hit = _cached()
        if hit:
            return hit

    key = api_key()
    if not key:
        empty["error"] = "no LINEAR_API_KEY in environment or .env"
        return empty

    try:
        req = urllib.request.Request(
            API, data=json.dumps({"query": QUERY}).encode(),
            headers={"Content-Type": "application/json", "Authorization": key})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        empty["error"] = f"HTTP {e.code}"
        return empty
    except Exception as e:                      # network, DNS, timeout, bad JSON
        empty["error"] = f"{type(e).__name__}"
        return empty

    if body.get("errors"):
        empty["error"] = str(body["errors"])[:160]
        return empty

    try:
        data = body["data"]
        teams = {}
        for t in data["teams"]["nodes"]:
            parent = (t.get("parent") or {})
            teams[t["key"]] = {"name": t["name"],
                               "color": t.get("color"),
                               "icon": TEAM_ICON.get(t.get("icon") or ""),
                               # kept so an unmapped icon can be named out loud
                               # rather than silently rendering nothing
                               "iconRaw": t.get("icon"),
                               "parent": parent.get("key"),
                               "parentName": parent.get("name")}
        issues = {}
        for i in data["issues"]["nodes"]:
            team = i.get("team") or {}
            parent = team.get("parent") or {}
            issues[i["identifier"].upper()] = {
                "identifier": i["identifier"],
                "title": i["title"],
                "url": i["url"],
                "priority": i.get("priority") or 0,
                "priorityLabel": i.get("priorityLabel") or "No priority",
                "state": (i.get("state") or {}).get("name", ""),
                "team": team.get("key", ""),
                "teamName": team.get("name", ""),
                # Every team here is a child of the DEA workspace team, so the
                # team's own key IS the subteam. Rolling up to the parent would
                # collapse all 19 of them into one useless bucket.
                "subteam": team.get("key", ""),
                "subteamName": team.get("name", ""),
                "parentTeam": parent.get("key") or "",
            }
    except (KeyError, TypeError) as e:
        empty["error"] = f"unexpected response shape ({e})"
        return empty

    out = {"ok": True, "error": None, "teams": teams, "issues": issues,
           "fetched_at": time.time()}
    try:
        CACHE.write_text(json.dumps(out))
    except OSError:
        pass
    return out


def find_identifier(*fields):
    """First plausible Linear issue id across the given strings."""
    for f in fields:
        if not f:
            continue
        for m in IDENT_RE.finditer(str(f)):
            yield f"{m.group(1).upper()}-{m.group(2)}"


def enrich(session, data, links=None):
    """Attach Linear fields to one session dict. Returns the fields to merge."""
    out = {"linear": None, "subteam": None, "subteam_color": None,
           "subteam_icon": None, "priority_rank": 99}

    def decorate(key):
        """Colour and icon for a subteam key, if Linear gave us any."""
        t = (data.get("teams") or {}).get(key or "") or {}
        out["subteam"] = key
        out["subteam_color"] = t.get("color")
        out["subteam_icon"] = t.get("icon")
    if not data.get("ok"):
        # Subteam from the repo map still works with no API access at all.
        team = repo_team_map().get(session.get("repo") or "") \
            or repo_team_map().get(session.get("folder") or "")
        if team:
            decorate(team)
        return out

    issues = data["issues"]
    pinned = (links or {}).get(session["id"])
    candidates = [pinned] if pinned else list(find_identifier(
        session.get("branch"), session.get("title"), session.get("_summary_text")))

    for ident in candidates:
        hit = issues.get((ident or "").upper())
        if hit:
            out["linear"] = hit
            decorate(hit["subteam"])
            out["priority_rank"] = PRIORITY_RANK.get(hit["priority"], 9)
            return out

    team = repo_team_map().get(session.get("repo") or "") \
        or repo_team_map().get(session.get("folder") or "")
    if team:
        decorate(team)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    d = fetch(force=args.force)
    if args.raw:
        print(json.dumps(d, indent=2)[:4000])
        return
    if not d["ok"]:
        print(f"Linear unavailable: {d['error']}")
        print("Dashboard still renders; priority sort and subteam filter stay hidden.")
        return
    print(f"ok · {len(d['teams'])} teams · {len(d['issues'])} open issues "
          f"· cached {int(time.time() - d['fetched_at'])}s ago")
    for k, t in sorted(d["teams"].items()):
        sub = f"  (sub of {t['parent']})" if t["parent"] else ""
        print(f"  {k:<7} {t.get('icon') or ' '} {t['name']}{sub}")
    gaps = {t["iconRaw"] for t in d["teams"].values()
            if t.get("iconRaw") and not t.get("icon")}
    if gaps:
        print(f"\nno glyph for {len(gaps)} Linear icon(s): {', '.join(sorted(gaps))}"
              f"\n  those teams render colour only — add them to TEAM_ICON")


if __name__ == "__main__":
    main()
