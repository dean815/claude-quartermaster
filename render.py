#!/usr/bin/env python3
"""Render data.json + summaries.json into a self-contained HTML dashboard.

  python3 render.py                          # artifact build (fleetview.html)
  python3 render.py --local --out local.html # adds refresh controls + deep links

The local build adds a Rescan button, an auto-refresh toggle, and per-card
"Open in Claude" deep links. Those need a local server behind them (serve.py),
so they are omitted from the artifact build rather than shipped dead.
"""

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import stale as stale_mod

HERE = Path(__file__).parent

# key, label, tooltip. Order is the tile order and the display order.
STATES = [
    ("running",   "Running",   "Claude is working in this thread right now."),
    ("subagents", "Subagents", "Subagents are still running for this session."),
    ("your-turn", "Your turn", "Waiting on a response or action from you. Touched in the last 24 hours."),
    ("overdue",   "Overdue",   "Waiting on you, and untouched for more than 24 hours."),
    ("idle",      "Idle",      "Nothing pending. Active within the last 48 hours."),
    ("dormant",   "Dormant",   "Nothing pending, and quiet for more than 48 hours."),
]
STATE_LABEL = {k: v for k, v, _ in STATES}
STATE_TIP = {k: t for k, _, t in STATES}


# Nerd Font private-use glyphs, embedded as a 3-glyph subset so the published
# artifact does not depend on the viewer having a patched font installed.
CLIENT_GLYPH = {
    "Claude Code Desktop": ("\uf108", "Desktop"),
    "Claude Code CLI":     ("\ue795", "CLI"),
    "Agent SDK":           ("\U000f109b", "API"),
    "Cyrus":               ("\U000f109b", "Cyrus"),
}
DEFAULT_GLYPH = ("\U000f109b", "API")
CLIENT_KEY = {"Claude Code Desktop": "desktop", "Claude Code CLI": "cli"}


GROUND_LIGHT, GROUND_DARK = "#f4f4f4", "#191a23"
MIN_CONTRAST = 4.5          # WCAG AA for small text, which the chip is


def _srgb(hexcolor):
    return tuple(int(hexcolor[i:i + 2], 16) / 255 for i in (1, 3, 5))


def _luminance(rgb):
    c = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in rgb]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def _contrast(rgb, ground):
    a, b = sorted((_luminance(rgb), _luminance(_srgb(ground))), reverse=True)
    return (a + 0.05) / (b + 0.05)


def team_ink(hexcolor):
    """Linear's team colour, walked to a lightness that clears AA on each ground.

    Clamping HLS lightness is not enough — a saturated cyan at L=.46 still only
    reaches 2.5:1 on the light page, because HLS lightness and perceived
    luminance are different things. So this steps lightness until the measured
    contrast passes, and leaves a colour that already passes untouched. Hue and
    saturation never move; the raw colour is still shown as the chip's fill.
    """
    if not (isinstance(hexcolor, str) and len(hexcolor) == 7 and hexcolor[0] == "#"):
        return None, None
    try:
        rgb = _srgb(hexcolor)
    except ValueError:
        return None, None
    import colorsys
    h, l, sat = colorsys.rgb_to_hls(*rgb)

    def walk(ground, step):
        cur = l
        for _ in range(50):
            out = colorsys.hls_to_rgb(h, cur, sat)
            if _contrast(out, ground) >= MIN_CONTRAST or not 0.02 < cur < 0.98:
                break
            cur += step
        out = colorsys.hls_to_rgb(h, min(max(cur, 0.0), 1.0), sat)
        return "#%02x%02x%02x" % tuple(round(c * 255) for c in out)

    return walk(GROUND_LIGHT, -0.02), walk(GROUND_DARK, 0.02)


CODE_RE = re.compile(r"^[A-Z][A-Z0-9]{1,7}$")
DAYS_RE = re.compile(r"^\d{1,3}$")
DATE_RE = re.compile(r"^\d{1,2}\.\d{1,2}(\s*-\s*\d{1,2}\.\d{1,2})?$")


def parse_title(raw):
    """Split a swept session name into its parts.

    The sweep writes `[* ]CODE | DAYS | Name | M.D`, but every field except the
    name is optional in practice: a directory missing from the shortnames file
    gets no code, and names written before the day counter existed have none.
    So this consumes recognisable metadata off each end and keeps the rest,
    rather than trusting a field count.
    """
    out = {"star": False, "code": None, "days": None, "date": None, "title": raw}
    if not raw:
        return out
    parts = [p.strip() for p in raw.split("|")]
    if parts[0].startswith("*"):
        out["star"] = True
        parts[0] = parts[0].lstrip("* ").strip()
        if not parts[0]:
            parts.pop(0)
    if not parts:
        return out
    # Never eat the last token: a session really called "TODO" keeps its name.
    while len(parts) > 1:
        if out["code"] is None and CODE_RE.match(parts[0]):
            out["code"] = parts.pop(0)
        elif out["days"] is None and DAYS_RE.match(parts[0]):
            out["days"] = int(parts.pop(0))
        else:
            break
    if len(parts) > 1 and DATE_RE.match(parts[-1]):
        out["date"] = parts.pop()
    title = " | ".join(p for p in parts if p).strip()
    out["title"] = title or raw
    return out

def build(data, summaries):
    entries = summaries.get("entries", {})
    rows = []
    for s in data["sessions"]:
        e = stale_mod.summary_of(entries, s)

        g = s.get("git") or {}
        stale = bool(e) and stale_mod.staleness(s, e) is not None

        t = parse_title(e.get("title") or s["title"])
        rows.append({
            "id": s["id"],
            "title": t["title"],
            "titleStar": t["star"],
            "titleCode": t["code"],
            "state": s["state"],
            "stateLabel": STATE_LABEL.get(s["state"], s["state"]),
            "stateTip": STATE_TIP.get(s["state"], ""),
            "interface": s["interface"],
            "glyph": CLIENT_GLYPH.get(s["interface"], DEFAULT_GLYPH)[0],
            "clientKey": CLIENT_KEY.get(s["interface"], "api"),
            "clientShort": CLIENT_GLYPH.get(s["interface"], DEFAULT_GLYPH)[1],
            "folder": s.get("folder") or "—",
            "repo": s.get("repo") or "—",
            "isRepo": s.get("is_repo", False),
            "cwd": s.get("cwd"),
            "branch": s.get("branch"),
            "git": {"added": g.get("added", 0), "modified": g.get("modified", 0),
                    "deleted": g.get("deleted", 0), "untracked": g.get("untracked", 0),
                    "total": g.get("total", 0)},
            "ahead": s.get("ahead", 0),
            "behind": s.get("behind", 0),
            "created": s.get("created_at"),
            "updated": s.get("last_activity_at"),
            "turns": s.get("turns", 0),
            "subagents": s.get("subagents") or [],
            "purpose": e.get("purpose"),
            # With no summary yet, the detected question is the only thing we know
            # is outstanding — surfacing it stops a "Your turn" card from also
            # claiming nothing is pending.
            "next": e.get("next") or ([{"type": "q", "text": s["question"]}]
                                      if s.get("question") else []),
            "linear": s.get("linear"),
            "subteam": s.get("subteam"),
            "subteamIcon": s.get("subteam_icon"),
            "subteamInk": team_ink(s.get("subteam_color"))[0],
            "subteamInkDark": team_ink(s.get("subteam_color"))[1],
            "subteamRaw": s.get("subteam_color"),
            "priorityRank": s.get("priority_rank", 99),
            "deeplink": s.get("deeplink"),
            "resumeCmd": s.get("resume_cmd"),
            "stale": stale,
            "unsummarized": not e,
        })
    return rows


CSS = r"""
:root{
  /* Linear "Pure Light", read out of the running app: bg #ffffff / #f4f4f4 /
     #f2f2f2, text #1c1c1c / #313231 / #616261, all pure neutrals (chroma 0).
     Their border token is #fafafa, which on white erases a card edge entirely,
     so --line is a stronger neutral off the same greyscale ramp. */
  --ground:#f4f4f4; --surface:#ffffff; --surface-2:#f2f2f2;
  --ink:#1c1c1c; --ink-2:#313231; --ink-3:#616261;
  --line:#e0e0e0; --line-2:#f0f0f0;
  --accent:#4a58cc; --accent-soft:#eceefb; --on-accent:#ffffff;
  --running:#1c7c46; --running-soft:#e4f3ea;
  --subagents:#0f7466; --subagents-soft:#e2f4f0;
  --your-turn:#a2690f; --your-turn-soft:#fcf1db;
  --overdue:#b3261e; --overdue-soft:#fdeceb;
  --idle:#2a5fc9; --idle-soft:#e9f0fd;
  --dormant:#6b7280; --dormant-soft:#f1f2f5;
  --add:#1c7c46; --mod:#a2690f; --del:#b3261e; --unt:#878d9a;
  --tip-bg:#1c1c1c; --tip-ink:#ffffff;
  --shadow:0 1px 2px rgba(18,20,26,.05), 0 1px 8px rgba(18,20,26,.04);
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    /* Linear "Magic Blue": base #191a23 and border #2d2e39 come straight from
       the app; the surfaces and text sit on the same LCH hue (282.863) at the
       lightness steps Pure Light uses, mirrored for a dark ground. */
    --ground:#191a23; --surface:#20212b; --surface-2:#22232d;
    --ink:#e1e1e5; --ink-2:#c4c4ca; --ink-3:#8c8d94;
    --line:#2d2e39; --line-2:#252631;
    --accent:#8d97f2; --accent-soft:#1e2340; --on-accent:#12141a;
    --running:#5ecb8c; --running-soft:#12291d;
    --subagents:#54c9b5; --subagents-soft:#122c29;
    --your-turn:#e2ac57; --your-turn-soft:#2e2415;
    --overdue:#f2897e; --overdue-soft:#331a19;
    --idle:#84abf7; --idle-soft:#16203a;
    --dormant:#8b929e; --dormant-soft:#1c2027;
    --add:#5ecb8c; --mod:#e2ac57; --del:#f2897e; --unt:#6d7481;
    --tip-bg:#e1e1e5; --tip-ink:#191a23;
    --shadow:0 1px 2px rgba(0,0,0,.3), 0 1px 8px rgba(0,0,0,.2);
  }
  :root:not([data-theme="light"]) .subteam{--tm:var(--tmd);
    background:color-mix(in srgb, var(--tmr,transparent) 24%, transparent)}
}
:root[data-theme="dark"]{
  /* Linear "Magic Blue": base #191a23 and border #2d2e39 come straight from
     the app; the surfaces and text sit on the same LCH hue (282.863) at the
     lightness steps Pure Light uses, mirrored for a dark ground. */
  --ground:#191a23; --surface:#20212b; --surface-2:#22232d;
  --ink:#e1e1e5; --ink-2:#c4c4ca; --ink-3:#8c8d94;
  --line:#2d2e39; --line-2:#252631;
  --accent:#8d97f2; --accent-soft:#1e2340; --on-accent:#12141a;
  --running:#5ecb8c; --running-soft:#12291d;
  --subagents:#54c9b5; --subagents-soft:#122c29;
  --your-turn:#e2ac57; --your-turn-soft:#2e2415;
  --overdue:#f2897e; --overdue-soft:#331a19;
  --idle:#84abf7; --idle-soft:#16203a;
  --dormant:#8b929e; --dormant-soft:#1c2027;
  --add:#5ecb8c; --mod:#e2ac57; --del:#f2897e; --unt:#6d7481;
  --tip-bg:#e1e1e5; --tip-ink:#191a23;
  --shadow:0 1px 2px rgba(0,0,0,.3), 0 1px 8px rgba(0,0,0,.2);
}
:root[data-theme="dark"] .subteam{--tm:var(--tmd);
  background:color-mix(in srgb, var(--tmr,transparent) 24%, transparent)}

*{box-sizing:border-box}
body{margin:0; background:var(--ground); color:var(--ink);
  font-family:ui-sans-serif,-apple-system,"SF Pro Text","Segoe UI",Roboto,sans-serif;
  font-size:15px; line-height:1.5; -webkit-font-smoothing:antialiased}
.mono{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  font-variant-numeric:tabular-nums}
.wrap{max-width:1160px; margin:0 auto; padding:34px 22px 72px}

.mast{display:flex; flex-wrap:wrap; align-items:flex-end; gap:12px 26px; margin-bottom:22px}
h1{margin:0; font-size:25px; line-height:1.15; font-weight:640; letter-spacing:-.022em}
.sub{margin:6px 0 0; color:var(--ink-2); font-size:13px; max-width:78ch}
.mast-actions{display:flex; align-items:center; gap:8px; flex-wrap:wrap}
.mast-right{margin-left:auto; display:flex; flex-direction:column; align-items:flex-end;
  gap:9px}

/* ---- state tiles double as the state filter ---- */
.tiles{display:grid; grid-template-columns:repeat(auto-fit,minmax(104px,1fr)); gap:9px;
  margin-bottom:16px}
.tile{background:var(--surface); border:1.5px solid var(--line); border-radius:10px;
  padding:10px 12px; box-shadow:var(--shadow); display:flex; flex-direction:column; gap:2px;
  cursor:pointer; text-align:left; font:inherit; color:inherit; transition:border-color .12s}
.tile:hover{border-color:var(--tone,var(--ink-3))}
.tile b{font-size:20px; font-weight:620; letter-spacing:-.02em; line-height:1.1; color:var(--tone,var(--ink))}
.tile span{font-size:10.5px; letter-spacing:.05em; text-transform:uppercase;
  color:var(--ink-3); font-weight:560}
.tile[aria-pressed="true"]{border-color:var(--tone); background:var(--tone-soft)}
.tile[aria-pressed="true"] span{color:var(--tone)}
.tile.readout{cursor:default; opacity:.85}
.tile.readout:hover{border-color:var(--line)}
.t-running{--tone:var(--running); --tone-soft:var(--running-soft)}
.t-subagents{--tone:var(--subagents); --tone-soft:var(--subagents-soft)}
.t-your-turn{--tone:var(--your-turn); --tone-soft:var(--your-turn-soft)}
.t-overdue{--tone:var(--overdue); --tone-soft:var(--overdue-soft)}
.t-idle{--tone:var(--idle); --tone-soft:var(--idle-soft)}
.t-dormant{--tone:var(--dormant); --tone-soft:var(--dormant-soft)}

/* ---- toolbar ---- */
.bar{display:flex; flex-wrap:wrap; gap:7px; align-items:center; padding:9px;
  margin-bottom:14px; background:var(--surface); border:1px solid var(--line);
  border-radius:10px; box-shadow:var(--shadow); position:sticky; top:0; z-index:20}
input[type=search], select{padding:6px 9px; border:1px solid var(--line); border-radius:7px;
  background:var(--surface-2); color:var(--ink); font:inherit; font-size:13px}
input[type=search]{flex:1 1 170px; min-width:0}
input[type=search]::placeholder{color:var(--ink-3)}
select{cursor:pointer; max-width:150px}
.chip{padding:5px 10px; border-radius:999px; border:1px solid var(--line);
  background:var(--surface-2); color:var(--ink-2); font-size:12.5px; font-weight:520;
  cursor:pointer; white-space:nowrap; font-family:inherit}
.chip[aria-pressed="true"]{background:var(--accent); border-color:var(--accent); color:var(--on-accent)}
.chip:hover{border-color:var(--ink-3)}
.sep{width:1px; align-self:stretch; background:var(--line); margin:0 2px}
.sortwrap{display:flex; align-items:center; gap:6px; padding:3px 4px 3px 9px;
  border:1px solid var(--accent); border-radius:8px; background:var(--accent-soft)}
.sortwrap label{font-size:11px; letter-spacing:.05em; text-transform:uppercase;
  color:var(--accent); font-weight:620}
.sortwrap select{border-color:transparent; background:transparent; color:var(--accent);
  font-weight:560}
.sortwrap .dir{border:0; background:transparent; color:var(--accent); font:inherit;
  font-size:13px; font-weight:700; line-height:1; padding:4px 6px; border-radius:6px;
  cursor:pointer}
.sortwrap .dir:hover{background:var(--surface)}
.msel{position:relative}
.msel > button{padding:6px 10px; border:1px solid var(--line); border-radius:7px;
  background:var(--surface-2); color:var(--ink-2); font:inherit; font-size:13px;
  cursor:pointer; white-space:nowrap}
.msel > button[aria-expanded="true"], .msel > button.on{border-color:var(--accent);
  color:var(--accent)}
.mpop{position:absolute; top:calc(100% + 5px); left:0; z-index:50; min-width:190px;
  max-height:280px; overflow:auto; background:var(--surface); border:1px solid var(--line);
  border-radius:9px; box-shadow:0 8px 28px rgba(0,0,0,.18); padding:6px; display:none}
.msel.open .mpop{display:block}
.mpop label{display:flex; align-items:center; gap:8px; padding:5px 7px; border-radius:6px;
  font-size:13px; color:var(--ink); cursor:pointer; white-space:nowrap}
.mpop label:hover{background:var(--surface-2)}
.mpop input{accent-color:var(--accent); margin:0}
.mpop .clear{width:100%; margin-top:4px; padding:5px; font:inherit; font-size:12px;
  border:1px solid var(--line); border-radius:6px; background:var(--surface-2);
  color:var(--ink-2); cursor:pointer}
.count{font-size:10.5px; letter-spacing:.05em; text-transform:uppercase;
  color:var(--ink-3); font-weight:560; white-space:nowrap}
:focus-visible{outline:2px solid var(--accent); outline-offset:2px; border-radius:4px}

[data-tip]{position:relative}
[data-tip]::after{content:attr(data-tip); position:absolute; left:50%; bottom:calc(100% + 7px);
  transform:translateX(-50%) translateY(3px); background:var(--tip-bg); color:var(--tip-ink);
  font-size:12px; font-weight:450; line-height:1.4; letter-spacing:0; text-transform:none;
  padding:7px 10px; border-radius:7px; width:max-content; max-width:262px; opacity:0;
  pointer-events:none; transition:opacity .12s ease, transform .12s ease; z-index:40;
  box-shadow:0 4px 16px rgba(0,0,0,.22); white-space:normal; text-align:left}
[data-tip]:hover::after, [data-tip]:focus-visible::after{opacity:1; transform:translateX(-50%)}

/* ---- rows ---- */
.rows{display:flex; flex-direction:column; gap:8px}
.row{position:relative; border:1px solid var(--line); border-left:5px solid var(--tone);
  border-radius:10px; box-shadow:var(--shadow); display:grid; grid-template-columns:1fr 168px;
  background:color-mix(in srgb, var(--tone) 5%, var(--surface))}
.row.s-running{--tone:var(--running)} .row.s-subagents{--tone:var(--subagents)}
.row.s-your-turn{--tone:var(--your-turn)} .row.s-overdue{--tone:var(--overdue)}
.row.s-idle{--tone:var(--idle)} .row.s-dormant{--tone:var(--dormant)}
.main{padding:12px 15px 13px; min-width:0}
.aside{padding:12px 15px 13px; border-left:1px solid var(--line-2);
  display:flex; flex-direction:column; gap:8px}

.head{display:flex; flex-wrap:wrap; align-items:center; gap:6px 9px}
.head .title{order:0}
/* The sweep's own fields are stripped from the name — the day counter, start
   date and project code are all already columns elsewhere. The star is not, so
   it survives as a mark. */
.star{color:var(--accent); font-size:12px; line-height:1; cursor:help}
/* An empty chip is a placeholder holding the compact column open. Expanded
   rows have no columns to hold, so it would just be a stray 12px box. */
.row:not(.compact) .subteam:empty{display:none}
.row.compact .head{flex-wrap:nowrap; min-width:0}
.row.compact .title{overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; flex:1}
.head-right{margin-left:auto; display:flex; align-items:center; gap:10px; flex:none}
/* The team's own Linear colour. --tmr is it exactly, carrying the fill and the
   border; --tml and --tmd are that hue walked to AA contrast in render.py for
   light and dark ground, and the text uses whichever the theme selects.
   --tm must NOT be set inline: an inline custom property beats every stylesheet
   rule, so the dark blocks below could never repoint it and every chip stayed
   at its light-mode ink on a dark ground. */
.subteam{--tm:var(--tml);
  font-size:10.5px; font-weight:620; letter-spacing:.05em;
  color:var(--tm,var(--ink-3)); border-radius:4px; padding:1px 5px;
  background:color-mix(in srgb, var(--tmr,transparent) 13%, transparent);
  border:1px solid color-mix(in srgb, var(--tmr,var(--line)) 42%, transparent);
  display:inline-flex; align-items:center; justify-content:center; gap:4px}
.subteam .tmi{font-style:normal; font-size:10px; line-height:1; letter-spacing:0}
.cg{font-family:'FleetGlyph'; line-height:1; color:var(--ink-2);
  display:inline-flex; align-items:center; gap:7px}
/* The three PUA glyphs differ wildly in ink height (f108 .92em, e795 .60em,
   f109b .42em) and every one of them overruns its .615em advance, so a plain
   inline glyph renders at three different sizes and shoulders the label
   sideways. Each is scaled to a common ink height and centred in a fixed box,
   offset by half its own overrun. Numbers come from the subset font itself. */
.cg .g{flex:none; width:17px; height:16px; display:inline-flex;
  align-items:center; justify-content:center; line-height:1}
.cg.c-desktop .g{font-size:15px; transform:translateX(-.21em)}
.cg.c-cli     .g{font-size:22px; transform:translateX(-.045em)}
.cg.c-api     .g{font-size:21px; transform:translateX(-.067em)}
.cg em{font-style:normal; font-size:11.5px; font-family:inherit; color:var(--ink-3);
  font-weight:520}
.cg .lbl{font-family:ui-sans-serif,-apple-system,sans-serif; font-size:11.5px;
  color:var(--ink-3); font-weight:520}
/* Collapsed rows are scanned vertically, so the right-hand fields are real
   columns with fixed widths. Without this a row missing git counters collapses
   that slot and drags the glyph and timestamp left out of alignment. */
.ts{font-size:11.5px; color:var(--ink-3); flex:none}
.row.compact .head-right{gap:12px}
/* Fixed widths on everything left of the name, so the names still line up in a
   list — that alignment is the whole point of the compact view. */
.row.compact .pill{width:74px; text-align:center; padding:1px 0}
.row.compact .star{width:9px; text-align:center}
.row.compact .subteam{width:60px; padding:1px 0; text-align:center}
.row.compact .gitcol{width:84px; text-align:right; font-size:12px}
.row.compact .cg{width:18px; justify-content:center}
.row.compact .ts{width:62px; text-align:right}
.disclose{background:none; border:0; padding:0 2px 0 0; margin:0; cursor:pointer;
  color:var(--ink-3); font-size:11px; line-height:1; align-self:center; transition:transform .12s}
.row.compact .disclose{transform:rotate(-90deg)}
.title{font-size:15px; font-weight:590; letter-spacing:-.011em; margin:0; cursor:pointer}
.pill{font-size:10.5px; font-weight:620; letter-spacing:.05em; text-transform:uppercase;
  padding:2px 8px; border-radius:5px; white-space:nowrap; cursor:help;
  color:var(--tone); background:var(--surface); border:1.5px solid var(--tone)}
.iface{font-size:11.5px; color:var(--ink-3); font-weight:520}
.lin{font-size:10.5px; font-weight:620; letter-spacing:.04em; padding:2px 7px; border-radius:5px;
  background:var(--accent-soft); color:var(--accent); text-decoration:none}
.lin:hover{text-decoration:underline}

/* Actions ride the meta line, right-aligned under the team and client chips.
   They used to sit at the foot of the aside, which set a tall floor on every
   row: a session with two lines of prose still got a 267px card. */
.subhead{display:flex; align-items:center; justify-content:space-between;
  gap:8px 16px; flex-wrap:wrap; margin-top:7px}
.subhead .meta{margin-top:0}
.meta{display:flex; flex-wrap:wrap; gap:3px 0; align-items:center; margin-top:7px;
  font-size:12px; color:var(--ink-2)}
.meta > * + *::before{content:"·"; color:var(--ink-3); margin:0 7px; font-weight:400}
.meta .folder{color:var(--ink); font-weight:560}
.gitc{display:inline-flex; gap:6px}
.gitc i{font-style:normal}
.gitc .a{color:var(--add)} .gitc .m{color:var(--mod)}
.gitc .d{color:var(--del)} .gitc .u{color:var(--unt)}
.gitc .clean{color:var(--ink-3)}

.prose{margin-top:10px; display:flex; flex-direction:column; gap:8px}
.row.compact .prose, .row.compact .started, .row.compact .subhead,
.row.compact .aside, .row.compact .meta{display:none}
.row.compact{grid-template-columns:1fr}
.row.compact .main{padding:9px 14px}
.purpose{margin:0; font-size:13.5px; color:var(--ink-2); max-width:72ch}
.nextlist{margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:5px}
.nextlist li{display:flex; gap:8px; font-size:13.5px; max-width:72ch}
.nextlist .mark{flex:none; font-weight:700; width:13px; text-align:center}
.nextlist .n-a{color:var(--ink)} .nextlist .n-a .mark{color:var(--accent)}
.nextlist .n-q{color:var(--ink)} .nextlist .n-q .mark{color:var(--overdue)}
.nextlist .n-i{color:var(--ink-3)} .nextlist .n-i .mark{color:var(--ink-3)}
.subs{margin:0; font-size:12.5px; color:var(--subagents)}
.flag{align-self:flex-start; font-size:11px; color:var(--your-turn);
  background:var(--your-turn-soft); padding:2px 7px; border-radius:5px; font-weight:560}

.acts{display:flex; gap:5px; flex-wrap:wrap; align-items:center; margin-left:auto}
.act{font-size:11.5px; font-weight:530; padding:3.5px 9px; border-radius:6px;
  border:1px solid var(--line); background:var(--surface-2); color:var(--ink-2);
  cursor:pointer; text-decoration:none; font-family:inherit; display:inline-block}
.act:hover{border-color:var(--ink-3); color:var(--ink)}
.act{text-align:center}
.act.primary{border-color:var(--accent); color:var(--accent); background:var(--accent-soft)}

.stat{display:flex; flex-direction:column; gap:1px}
.stat dt{font-size:10px; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-3); font-weight:560}
.stat dd{margin:0; font-size:12.5px; color:var(--ink)}
.stat dd small{display:block; color:var(--ink-3); font-size:11px}

/* A shown-hidden row stays legible but reads as set aside, so it is never
   mistaken for something still on the board. */
.row.is-hidden{opacity:.5}
.row.is-hidden:hover, .row.is-hidden:focus-within{opacity:1}
.chip:disabled{opacity:.45; cursor:default}
.chip:disabled:hover{border-color:var(--line); color:var(--ink-2)}

.empty{padding:44px 16px; text-align:center; color:var(--ink-3); font-size:14px}
.toast{position:fixed; bottom:22px; left:50%; transform:translateX(-50%); background:var(--tip-bg);
  color:var(--tip-ink); padding:9px 16px; border-radius:8px; font-size:13px;
  box-shadow:0 6px 24px rgba(0,0,0,.25); opacity:0; pointer-events:none;
  transition:opacity .16s ease; z-index:60}
.toast.on{opacity:1}

footer{margin-top:32px; padding-top:18px; border-top:1px solid var(--line);
  color:var(--ink-3); font-size:12.5px; display:flex; flex-direction:column; gap:8px}
footer code{background:var(--surface); border:1px solid var(--line); border-radius:5px;
  padding:2px 6px; color:var(--ink-2); font-size:12px}
footer .note{max-width:78ch}

body.monitor .bar{display:none}
body.monitor .mast .sub{display:none}

@media (max-width:760px){
  .wrap{padding:22px 13px 54px}
  .row, .row.compact{grid-template-columns:1fr}
  .aside{border-left:0; border-top:1px solid var(--line-2); flex-direction:row;
    flex-wrap:wrap; gap:16px}
  .acts{margin-left:0}
  .bar{position:static}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
"""

JS = r"""
const FLEET = window.__FLEET__;
const rows = FLEET.rows, LOCAL = FLEET.local;
const genAt = new Date(FLEET.generated_at);
// Must match the key in the pre-paint theme script in the page template —
// that one runs before this file loads and cannot read this constant.
const LS = "fleetview.v3";

const esc = s => String(s ?? "").replace(/[&<>"]/g, c =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

function rel(iso){
  if(!iso) return "—";
  const mins = Math.round((genAt - new Date(iso))/60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const h = Math.round(mins/60);
  return h < 24 ? h + "h ago" : Math.round(h/24) + "d ago";
}
const abs = iso => iso ? new Date(iso).toLocaleString(undefined,
  {month:"short", day:"numeric", hour:"numeric", minute:"2-digit"}) : "";
function span(a,b){
  if(!a||!b) return "";
  const h = (new Date(b) - new Date(a))/3600000;
  if (h < 1) return Math.max(1, Math.round(h*60)) + "m span";
  if (h < 48) return h.toFixed(h<10?1:0) + "h span";
  return Math.round(h/24) + "d span";
}
const ageHours = iso => iso ? (genAt - new Date(iso))/3600000 : 1e9;

let saved = {};
try { saved = JSON.parse(localStorage.getItem(LS) || "{}"); } catch(e) {}
const state = {
  q:"", iface:new Set(), states:new Set(), folders:new Set(), sort:"updated",
  window:"any", dir:"desc",
  mode: saved.mode === "compact" ? "compact" : "full",
  overrides: saved.overrides || {},
  auto: !!saved.auto,
  // Hidden lives here, not in data.json: it is one person's view of the board,
  // and the collector has no business knowing about it. Keyed by session id, so
  // a hidden session stays hidden across rescans and falls out of the store on
  // its own once it ages past the window and stops being rendered.
  hidden: saved.hidden || {},
  showHidden: !!saved.showHidden,
  theme: ["light","dark"].includes(saved.theme) ? saved.theme : "system",
};
const persist = () => {
  try { localStorage.setItem(LS, JSON.stringify(
    {mode:state.mode, overrides:state.overrides, auto:state.auto,
     hidden:state.hidden, showHidden:state.showHidden, theme:state.theme})); } catch(e) {}
};
const hiddenCount = () => rows.filter(r => state.hidden[r.id]).length;
const isCompact = r => r.id in state.overrides
  ? state.overrides[r.id] : state.mode === "compact";

const WINDOWS = {"6":6, "24":24, "48":48, "168":168};

function matches(r){
  if (state.hidden[r.id] && !state.showHidden) return false;
  if (state.states.size && !state.states.has(r.state)) return false;
  if (state.iface.size && !state.iface.has(r.interface)) return false;
  if (state.folders.size && !state.folders.has(r.folder)) return false;
  if (state.window !== "any" && ageHours(r.updated) > WINDOWS[state.window]) return false;
  if (!state.q) return true;
  const hay = [r.title, r.repo, r.folder, r.branch, r.interface, r.stateLabel, r.purpose,
               r.cwd, r.subteam, r.linear && r.linear.identifier,
               ...r.next.map(n => n.text)].join(" ").toLowerCase();
  return state.q.split(/\s+/).every(t => hay.includes(t));
}

const MARK = {q:"?", a:"→", i:"·"};

function gitCounters(r){
  if (!r.isRepo) return "";        // absence says it plainly enough
  const g = r.git, bits = [];
  if (g.added)     bits.push(`<i class="a">+${g.added}</i>`);
  if (g.modified)  bits.push(`<i class="m">~${g.modified}</i>`);
  if (g.deleted)   bits.push(`<i class="d">−${g.deleted}</i>`);
  if (g.untracked) bits.push(`<i class="u">?${g.untracked}</i>`);
  if (r.ahead)  bits.push(`<i class="a">${r.ahead}↑</i>`);
  if (r.behind) bits.push(`<i class="d">${r.behind}↓</i>`);
  if (!bits.length) bits.push(`<i class="clean">clean</i>`);
  return `<span class="gitc">${bits.join("")}</span>`;
}

// Falls back to the code the sweep put in the title. Linear is the better
// source — it carries the colour — but a repo with no team mapping would
// otherwise lose the one label it had, now that the title is stripped.
function subteamLabel(r){ return r.subteam || r.titleCode || ""; }

function subteamChip(r, holdColumn){
  // Compact rows keep an empty chip so the fixed columns to its right hold place.
  const label = subteamLabel(r);
  if (!label) return holdColumn ? `<span class="subteam"></span>` : "";
  const ink = r.subteamInk
    ? ` style="--tml:${esc(r.subteamInk)}; --tmd:${esc(r.subteamInkDark)}; --tmr:${
        esc(r.subteamRaw)}"` : "";
  return `<span class="subteam" tabindex="0"${ink} data-tip="${
    r.subteam ? "Linear subteam" : "Project code from the session name"}">${
    r.subteamIcon ? `<i class="tmi">${esc(r.subteamIcon)}</i>` : ""}${esc(label)}</span>`;
}

function card(r){
  const compact = isCompact(r);
  return `
  <article class="row s-${esc(r.state)}${compact ? " compact" : ""}${
    state.hidden[r.id] ? " is-hidden" : ""}" data-id="${esc(r.id)}">
    <div class="main">
      <div class="head">
        <button class="disclose" type="button" data-toggle aria-expanded="${!compact}"
                aria-label="${compact ? "Expand" : "Collapse"} this session">▼</button>
        <span class="pill" tabindex="0" data-tip="${esc(r.stateTip)}">${esc(r.stateLabel)}</span>
        ${subteamChip(r, true)}
        ${r.titleStar ? `<span class="star" tabindex="0" data-tip="Carrying a large context or already compacted — start new work in a fresh session rather than resuming this one.">✦</span>` : ""}
        <h2 class="title" data-toggle>${esc(r.title)}</h2>
        ${r.linear ? `<a class="lin" href="${esc(r.linear.url)}" target="_blank"
           data-tip="${esc(r.linear.title)} — ${esc(r.linear.priorityLabel)}, ${esc(r.linear.state)}"
           >${esc(r.linear.identifier)}</a>` : ""}
        <span class="head-right">
          ${compact ? `<span class="gitcol mono">${gitCounters(r)}</span>` : ""}
          <span class="cg c-${esc(r.clientKey)}" tabindex="0" data-tip="${esc(r.interface)}"
            ><i class="g">${r.glyph}</i>${
            compact ? "" : `<span class="lbl">${esc(r.clientShort)}</span>`}</span>
          ${compact ? `<span class="ts mono" tabindex="0"
             data-tip="Last update ${esc(abs(r.updated))}">${esc(rel(r.updated))}</span>` : ""}
        </span>
      </div>

      <div class="subhead">
        <div class="meta mono">
          <span class="folder">${esc(r.folder)}</span>
          ${r.branch ? `<span>${esc(r.branch)}</span>` : ""}
          ${gitCounters(r) ? `<span>${gitCounters(r)}</span>` : ""}
        </div>
        <div class="acts">
          ${LOCAL && r.deeplink
            ? `<a class="act primary" href="${esc(r.deeplink)}">Open in Claude</a>` : ""}
          ${LOCAL && !r.deeplink
            ? `<span class="act" tabindex="0" style="cursor:help"
                 data-tip="No safe deep link: this session was created in the Desktop app, and claude://resume would import a duplicate rather than focus it.">Open — n/a</span>` : ""}
          ${r.resumeCmd ? `<button class="act" type="button" data-copy="${esc(r.resumeCmd)}">Copy resume cmd</button>` : ""}
          ${r.cwd ? `<button class="act" type="button" data-copy="${esc(r.cwd)}">Copy path</button>` : ""}
          <button class="act" type="button" data-hide="${esc(r.id)}"
            data-tip="${state.hidden[r.id]
              ? "Put this session back on the board."
              : "Drop this session from the board. Kept in this browser only — it does not touch the scan, the menu bar, or anyone else's view."}"
            >${state.hidden[r.id] ? "Unhide" : "Hide"}</button>
        </div>
      </div>

      <div class="prose">
        ${r.subagents.length ? `<p class="subs">${r.subagents.length} subagent${
          r.subagents.length === 1 ? "" : "s"} running — ${
          esc(r.subagents.map(s => s.description).join("; ").slice(0,110))}</p>` : ""}
        ${r.purpose ? `<p class="purpose">${esc(r.purpose)}</p>` : ""}
        ${r.next.length ? `<ul class="nextlist">${r.next.map(n =>
          `<li class="n-${esc(n.type)}"><span class="mark">${MARK[n.type] || "·"}</span><span>${
            esc(n.text)}</span></li>`).join("")}</ul>`
          : `<p class="purpose">Nothing pending.</p>`}
        ${r.unsummarized ? `<span class="flag">No summary yet</span>`
          : r.stale ? `<span class="flag">Summary is behind the session</span>` : ""}
      </div>

    </div>

    <div class="aside">
      <div class="stat">
        <dt>Last update</dt>
        <dd class="mono">${esc(rel(r.updated))}<small>${esc(abs(r.updated))}</small></dd>
      </div>
      <div class="stat started">
        <dt>Started</dt>
        <dd class="mono">${esc(abs(r.created))}<small>${esc(span(r.created, r.updated))}</small></dd>
      </div>
      <div class="stat started">
        <dt>Turns</dt>
        <dd class="mono">${r.turns}${r.repo !== r.folder ? `<small>${esc(r.repo)}</small>` : ""}</dd>
      </div>
    </div>
  </article>`;
}

const SORTS = {
  updated:  (a,b) => (b.updated||"").localeCompare(a.updated||""),
  created:  (a,b) => (b.created||"").localeCompare(a.created||""),
  turns:    (a,b) => b.turns - a.turns,
  changes:  (a,b) => (b.git.total + b.ahead) - (a.git.total + a.ahead),
  priority: (a,b) => a.priorityRank - b.priorityRank
                     || (b.updated||"").localeCompare(a.updated||""),
};

function render(){
  const list = rows.filter(matches);
  const cmp = SORTS[state.sort] || SORTS.updated;
  list.sort(state.dir === "asc" ? (a,b) => -cmp(a,b) : cmp);

  document.getElementById("count").textContent =
    list.length + (list.length === 1 ? " session" : " sessions") +
    (list.length !== rows.length ? " of " + rows.length : "");

  document.querySelectorAll(".tile[data-state]").forEach(t =>
    t.setAttribute("aria-pressed", String(state.states.has(t.dataset.state))));

  const hb = document.getElementById("hiddenBtn"), n = hiddenCount();
  hb.textContent = n ? `Hidden ${n}` : "Hidden";
  hb.disabled = !n;
  hb.setAttribute("aria-pressed", String(state.showHidden && !!n));
  hb.setAttribute("data-tip", n
    ? (state.showHidden ? "Showing hidden sessions, dimmed. Click to tuck them away again."
                        : `${n} session${n===1?"":"s"} hidden. Click to show them.`)
    : "No sessions hidden. Use Hide on a row to drop it from the board.");

  const host = document.getElementById("rows");
  host.innerHTML = list.length
    ? list.map(card).join("")
    : '<p class="empty">No sessions match those filters.</p>';
}

let toastTimer;
function toast(msg){
  const el = document.getElementById("toast");
  el.textContent = msg; el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 1600);
}
async function copy(text){
  try { await navigator.clipboard.writeText(text); }
  catch(e){
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch(e2){ toast("Copy blocked here"); return; }
    finally { ta.remove(); }
  }
  toast("Copied");
}

document.getElementById("rows").addEventListener("click", ev => {
  const cp = ev.target.closest("[data-copy]");
  if (cp) { copy(cp.dataset.copy); return; }
  if (ev.target.closest("a")) return;
  const tg = ev.target.closest("[data-toggle]");
  if (tg) {
    const row = tg.closest(".row"), id = row.dataset.id;
    state.overrides[id] = !isCompact(rows.find(x => x.id === id));
    persist(); render();
  }
});

document.querySelectorAll(".tile[data-state]").forEach(t =>
  t.addEventListener("click", () => {
    const k = t.dataset.state;
    state.states.has(k) ? state.states.delete(k) : state.states.add(k);
    render();
  }));

function multiSelect(hostId, label, values, set, labelFor){
  const host = document.getElementById(hostId);
  const sync = () => {
    const n = set.size;
    host.querySelector("button").textContent = n ? `${label}: ${n}` : `Any ${label.toLowerCase()}`;
    host.querySelector("button").classList.toggle("on", n > 0);
  };
  host.innerHTML =
    `<button type="button" aria-expanded="false"></button>
     <div class="mpop">${values.map(v =>
       `<label><input type="checkbox" value="${esc(v)}">${esc(labelFor ? labelFor(v) : v)}</label>`
     ).join("")}<button class="clear" type="button">Clear</button></div>`;
  const btn = host.querySelector("button");
  btn.addEventListener("click", e => {
    e.stopPropagation();
    const open = host.classList.toggle("open");
    btn.setAttribute("aria-expanded", String(open));
    document.querySelectorAll(".msel.open").forEach(m => {
      if (m !== host) { m.classList.remove("open");
        m.querySelector("button").setAttribute("aria-expanded", "false"); }
    });
  });
  host.querySelector(".mpop").addEventListener("click", e => e.stopPropagation());
  host.querySelectorAll(".mpop input").forEach(cb => cb.addEventListener("change", () => {
    cb.checked ? set.add(cb.value) : set.delete(cb.value);
    sync(); render();
  }));
  host.querySelector(".clear").addEventListener("click", () => {
    set.clear();
    host.querySelectorAll(".mpop input").forEach(cb => cb.checked = false);
    sync(); render();
  });
  sync();
}
document.addEventListener("click", () => {
  document.querySelectorAll(".msel.open").forEach(m => {
    m.classList.remove("open");
    m.querySelector("button").setAttribute("aria-expanded", "false");
  });
});

function singleSelect(hostId, options, get, set){
  const host = document.getElementById(hostId);
  const sync = () => {
    const cur = options.find(o => o.value === get()) || options[0];
    const btn = host.querySelector("button");
    btn.textContent = cur.label;
    btn.classList.toggle("on", cur.value !== options[0].value);
  };
  host.innerHTML =
    `<button type="button" aria-expanded="false"></button>
     <div class="mpop">${options.map(o =>
       `<label><input type="radio" name="${esc(hostId)}" value="${esc(o.value)}"${
         o.value === get() ? " checked" : ""}>${esc(o.label)}</label>`).join("")}</div>`;
  const btn = host.querySelector("button");
  btn.addEventListener("click", e => {
    e.stopPropagation();
    const open = host.classList.toggle("open");
    btn.setAttribute("aria-expanded", String(open));
    document.querySelectorAll(".msel.open").forEach(m => {
      if (m !== host) { m.classList.remove("open");
        m.querySelector("button").setAttribute("aria-expanded", "false"); }
    });
  });
  host.querySelector(".mpop").addEventListener("click", e => e.stopPropagation());
  host.querySelectorAll(".mpop input").forEach(rb => rb.addEventListener("change", () => {
    set(rb.value); sync(); render();
    host.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
  }));
  sync();
}

singleSelect("winMsel", [
  {value:"any", label:"Any time"}, {value:"6", label:"Last 6h"},
  {value:"24", label:"Last 24h"}, {value:"48", label:"Last 48h"},
  {value:"168", label:"Last 7d"},
], () => state.window, v => { state.window = v; });

multiSelect("folderMsel", "Folder",
  [...new Set(rows.map(r => r.folder))].filter(Boolean).sort(), state.folders);
multiSelect("clientMsel", "Client",
  [...new Set(rows.map(r => r.interface))].sort(), state.iface,
  v => v.replace("Claude Code ", ""));

document.getElementById("sortSel").addEventListener("change", e => {
  state.sort = e.target.value; render();
});
document.getElementById("sortDir").addEventListener("click", e => {
  state.dir = state.dir === "desc" ? "asc" : "desc";
  e.target.textContent = state.dir === "desc" ? "\u2193" : "\u2191";
  e.target.setAttribute("data-tip",
    state.dir === "desc" ? "Descending — click for ascending"
                         : "Ascending — click for descending");
  render();
});
document.getElementById("rows").addEventListener("click", e => {
  const b = e.target.closest("[data-hide]");
  if (!b) return;
  const id = b.dataset.hide;
  if (state.hidden[id]) delete state.hidden[id]; else state.hidden[id] = true;
  persist(); render();
  toast(state.hidden[id] ? "Hidden. Find it under Hidden in the toolbar." : "Back on the board.");
});

document.getElementById("hiddenBtn").addEventListener("click", () => {
  state.showHidden = !state.showHidden; persist(); render();
});

const THEMES = ["system", "light", "dark"];
const themeBtn = document.getElementById("themeBtn");
function applyTheme(){
  // No attribute at all is the third state: the CSS falls through to
  // prefers-color-scheme, which is what "system" has to mean.
  if (state.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
  const label = state.theme[0].toUpperCase() + state.theme.slice(1);
  themeBtn.textContent = `Theme · ${label}`;
  themeBtn.setAttribute("data-tip", state.theme === "system"
    ? "Following the system setting. Click for light."
    : `Forced ${state.theme}. Click for ${THEMES[(THEMES.indexOf(state.theme)+1) % 3]}.`);
}
themeBtn.addEventListener("click", () => {
  state.theme = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length];
  persist(); applyTheme();
});
applyTheme();

document.getElementById("q").addEventListener("input", e => {
  state.q = e.target.value.trim().toLowerCase(); render();
});
document.querySelectorAll("[data-mode]").forEach(btn => btn.addEventListener("click", () => {
  state.mode = btn.dataset.mode;
  state.overrides = {};
  document.querySelectorAll("[data-mode]").forEach(b =>
    b.setAttribute("aria-pressed", String(b === btn)));
  persist(); render();
}));
document.querySelector(`[data-mode="${state.mode}"]`)?.setAttribute("aria-pressed","true");

if (LOCAL) {
  const btn = document.getElementById("rescan");
  const autoBtn = document.getElementById("autoBtn");
  let timer = null;
  const monitor = new URLSearchParams(location.search).get("monitor") === "1";
  if (monitor) document.body.classList.add("monitor");

  const setAuto = on => {
    state.auto = on; persist();
    autoBtn.setAttribute("aria-pressed", String(on));
    autoBtn.textContent = on ? "Auto · on" : "Auto · off";
    clearInterval(timer);
    if (on) timer = setInterval(() => location.reload(), FLEET.autoSeconds * 1000);
  };
  autoBtn.addEventListener("click", () => setAuto(!state.auto));
  setAuto(monitor ? true : state.auto);

  btn.addEventListener("click", async () => {
    btn.disabled = true; btn.textContent = "Rescanning…";
    try {
      const res = await fetch("/rescan", {method:"POST"});
      if (!res.ok) throw new Error(await res.text());
      location.reload();
    } catch (e) {
      btn.disabled = false; btn.textContent = "Rescan · 0 tokens";
      toast("Rescan failed: " + e.message);
    }
  });
  const rs = document.getElementById("resummarize");
  if (rs) rs.addEventListener("click", () => copy(FLEET.resummarizePrompt));
}

render();
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(HERE / "data.json"))
    ap.add_argument("--summaries", default=str(HERE / "summaries.json"))
    ap.add_argument("--out", default=str(HERE / "fleetview.html"))
    ap.add_argument("--local", action="store_true")
    ap.add_argument("--auto-seconds", type=int, default=180)
    args = ap.parse_args()

    try:
        glyph_css = (HERE / "icons" / "glyphs.css").read_text()
    except OSError:
        glyph_css = ""      # glyphs degrade to blank rather than breaking the page

    data = json.loads(Path(args.data).read_text())
    sp = Path(args.summaries)
    summaries = json.loads(sp.read_text()) if sp.exists() else {}
    rows = build(data, summaries)

    counts = {}
    for r in rows:
        counts[r["state"]] = counts.get(r["state"], 0) + 1
    stale = [r for r in rows if r["stale"] or r["unsummarized"]]

    tiles = "".join(
        f'<button class="tile t-{k}" type="button" data-state="{k}" aria-pressed="false"'
        f' data-tip="{tip}"><b>{counts.get(k, 0)}</b><span>{label}</span></button>'
        for k, label, tip in STATES)
    # No Repos/Total readouts: the toolbar already prints the count, and repo
    # count is not something you act on.

    gen = datetime.fromisoformat(data["generated_at"].replace("Z", "+00:00"))
    gen_local = gen.astimezone().strftime("%b %-d at %-I:%M %p %Z")

    lin = data.get("linear") or {}
    lin_note = ("" if lin.get("ok") else
                f' Linear unavailable ({lin.get("error") or "no key"}); '
                f'priority sort and subteam filter are inert.')

    est_k = round(len(stale) * stale_mod.TOKENS_PER_SUMMARY / 1000, 1)
    resummarize_prompt = ("Re-summarize the stale fleetview sessions and republish. Stale ids:\n"
                          + "\n".join(f"  {r['id']}" for r in stale))

    if args.local:
        controls = f"""
    <div class="mast-actions">
      <button class="chip" type="button" id="rescan"
        data-tip="Re-reads every session store and re-runs git. Pure Python — no model, no tokens.">Rescan · 0 tokens</button>
      <button class="chip" type="button" id="autoBtn" aria-pressed="false"
        data-tip="Reload every {args.auto_seconds}s so a spare screen stays current. Still 0 tokens.">Auto · off</button>
      {f'''<button class="chip" type="button" id="resummarize"
        data-tip="Copies a prompt naming the {len(stale)} stale session(s). Paste it to Claude — a script cannot write these. Rough estimate, {est_k}k tokens.">Re-summarize {len(stale)} · ~{est_k}k</button>''' if stale else ''}
    </div>"""
        footer_note = ('<p class="note">Rescanning is free — the scan is Python, <code>git</code> '
                       'and one cached Linear call, with no model involved. Only the purpose and '
                       'next-step text costs tokens.</p>')
    else:
        controls = ""
        footer_note = ('<p class="note">This is a snapshot, not a stream. A published page is '
                       'sandboxed away from your machine — it cannot read <code>~/.claude</code>, '
                       'run <code>git</code>, or reach Linear. Refresh with '
                       '<code>~/claude/general/fleetview/refresh.sh</code>.</p>')

    payload = json.dumps({"rows": rows, "generated_at": data["generated_at"],
                          "local": bool(args.local), "autoSeconds": args.auto_seconds,
                          "resummarizePrompt": resummarize_prompt}, ensure_ascii=False)

    html = f"""<title>Session Fleet</title>
<style>{glyph_css}{CSS}</style>
<script>
try {{
  var t = (JSON.parse(localStorage.getItem("fleetview.v3") || "{{}}") || {{}}).theme;
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
}} catch (e) {{}}
</script>
<div class="wrap">
  <header class="mast">
    <div>
      <h1>Session Fleet</h1>
      <p class="sub">Every Claude Code session across CLI, Desktop, Cyrus and the SDK —
        last {data['window_days']:g} days on {data['host']}. Snapshot {gen_local}.{lin_note}</p>
    </div>
    <div class="mast-right">{controls}
      <span class="count" id="count"></span>
    </div>
  </header>

  <div class="tiles">{tiles}</div>

  <div class="bar">
    <input type="search" id="q" placeholder="Search title, folder, branch, purpose…"
           aria-label="Filter sessions">
    <span class="msel" id="winMsel"
      data-tip="Only show sessions touched inside this window."></span>
    <span class="msel" id="folderMsel"></span>
    <span class="msel" id="clientMsel"></span>
    <span class="sep"></span>
    <span class="sortwrap">
      <label for="sortSel">Sort</label>
      <select id="sortSel" aria-label="Sort by">
        <option value="updated">Recency</option>
        <option value="created">Start time</option>
        <option value="turns">Turns</option>
        <option value="changes">Changes</option>
        <option value="priority">Linear priority</option>
      </select>
      <button class="dir" id="sortDir" type="button" aria-label="Sort direction"
        data-tip="Descending — click for ascending">&#8595;</button>
    </span>
    <button class="chip" type="button" data-mode="compact"
      data-tip="One line: title, state, Linear subteam, git changes, client and last update.">Collapse all</button>
    <button class="chip" type="button" data-mode="full"
      data-tip="Add folder, branch, purpose, next steps, start time and turns.">Expand all</button>
    <span class="sep"></span>
    <button class="chip" type="button" id="hiddenBtn" aria-pressed="false">Hidden</button>
    <button class="chip" type="button" id="themeBtn">Theme</button>
  </div>

  <div class="rows" id="rows"></div>

  <footer>
    <p class="note"><b>→</b> something for you to do &nbsp;·&nbsp;
      <b>?</b> a question Claude asked and is waiting on &nbsp;·&nbsp;
      <b>·</b> context, no action needed. Click any state tile to filter by it.</p>
    {footer_note}
  </footer>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>window.__FLEET__ = {payload};</script>
<script>{JS}</script>
"""
    Path(args.out).write_text(html)
    summary = " · ".join(f"{k} {counts.get(k, 0)}" for k, _, _ in STATES)
    print(f"{len(rows)} rows ({summary}) · {len(stale)} stale -> {args.out}")


if __name__ == "__main__":
    main()
