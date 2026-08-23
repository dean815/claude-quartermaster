#!/usr/bin/env python3
"""Merge hand-authored purpose / next-step bullets into summaries.json.

Stamps each entry with the session's last_activity_at AND turn count taken from
data.json, so render.py can flag an entry stale when either has moved.

Bullet types:
  q  open question from Claude, waiting on Dean's answer
  a  action Dean has to take
  i  informational, no action needed

Re-run after editing AUTHORED below:  python3 author_summaries.py
"""

import json
from pathlib import Path

HERE = Path(__file__).parent

TITLES = {
    "bddc3c0f-46f7-4c79-a8f4-c2dc210c8851": "MCP duplicate-server investigation",
    "4ce2b192-761a-4321-993a-c37d40cd8310": "Cross-session rename probe",
    "a43fcf80-9b8b-45c6-afa6-b464e106640b": "MCP reconnect debugging",
    "ed7a7704-9d85-434a-b2f1-cfc5829ad78e": "MCP auth failure (google-sheets)",
    "6a504aa3-396f-4e7a-afe9-a48669d2ee5f": "chord-chart-maker orientation",
    "a2324028-6a0d-4f72-977b-dd5e7fe62891": "chord-chart-maker — M7 Phase A",
    "5b91eaa3-caa5-4eac-b343-224065a0cb72": "ChordPro format deep dive",
    "f39e90ad-6bb4-43cd-a8b0-dd3345e69112": "Claude Code usage insights report",
    "cab7ab36-7162-4dfa-b189-cae975537f02": "Nimbalyst mindmap format lookup",
    "22d52a6a-2d63-48f4-8ec3-673be59cd05c": "Airtable MCP connection (long-running)",
   "866d4f5d-7952-4a6d-9e42-e0c63b665033": "MCP dedup mechanism — headless proof",
   "767546c7-2d8d-411c-9c71-16d31ad7167b": "skill-creator, opened and left",
   "143c9783-1433-4be2-b7af-cc98db2a9afa": "Plugin and MCP console session",
   "677cc1ea-5bdb-4cd8-bd1a-08a5a61e1bc0": "Interrupted login",
   "2069bab7-8a36-4f18-8c7f-352b851e28b2": "Logic mouse-focus suspects",
   "8a64dbf3-6489-4595-bb71-ece59e77332c": "Google Drive multi-part zip question",
   "local_8fc1d0bd-2486-4acb-b6bd-a94e56668048": "Session sweep that never ran",
}

AUTHORED = {
"local_3fa6a9e2-ce03-4914-a30f-d89669d44641": (
    "Get GitHub Desktop syncing the local repositories.",
    [("i", "Done — 21 repos synced in Desktop. Nothing pending.")]),

"local_20c213dd-544c-46d7-adda-56bfc3f323e3": (
    "Build Session Fleet: the dashboard, the local server, and the macOS menu bar agent.",
    [("a", "Allow terminal-notifier under System Settings → Notifications if the test alerts "
           "never appeared — still the one unverified piece."),
     ("i", "Since the v2 write-up: the four right-hand fields are real fixed-width columns so "
           "the times line up, 'not a repo' no longer renders, and the menu bar mark is down to "
           "14.1 × 13 from 20 × 20."),
     ("i", "linear-map.json maps repo/folder to Linear team keys and was seeded by guessing "
           "from repo names; correct any wrong ones and re-run.")]),

"local_597d5790-54ef-4480-873b-6bd72f0e8512": (
    "Automated daily-brief run for the tool stack; this run also reconciled the "
    "SKILL.md and prompt.md copies.",
    [("i", "You approved syncing the drifted paragraph and committing. Claude is "
           "finishing that now.")]),

"local_0cdc232e-2954-4d91-a8c7-7669153f2ec8": (
    "Tailor the CV for Cursor's product education role, then sync the agreed edits "
    "back into the master cv.md.",
    [("i", "All six edits applied and cv.md synced. Cursor reorder skipped as you asked."),
     ("a", "Know that your CV no longer references LinkedIn anywhere — deanhicks.com "
           "replaced it rather than joining it. Fine for Cursor, which has its own "
           "LinkedIn field, but any application relying on the CV alone won't have it."),
     ("i", "The Cursor tailoring was deliberately not pulled back into cv.md; the "
           "competency grid still reads “Technical Implementation” on the master.")]),

"local_28466034-b832-4efe-9ee6-ebb0a9ec689d": (
    "Career-ops cleanup, then a rule making Claude hyperlink every role reference to its "
    "Airtable record.",
    [("i", "Both PRs merged — #167 (frame-aware liveness) and #168 (Tracker # → record-id map). "
           "Suite green, 33 self-test checks, main fast-forwarded."),
     ("a", "Two files were already dirty when this session started and still are: "
           "`.claude/settings.json` and `LOCAL.md`."),
     ("i", "Your premise needed one correction: Tracker # can't generate an Airtable URL — "
           "records are addressed by opaque `rec…` ids, so a persisted map was the only honest "
           "way to do it."),
     ("i", "Pre-existing trap worth knowing: importing refresh-airtable-dump.mjs runs main() — "
           "no entrypoint guard — so any test that imports it hits the network.")]),

"local_a32a70d7-db5e-472e-9285-e1830dd513f9": (
    "Count Airtable API calls from session transcripts, then stop normal usage from blocking "
    "unattended runs — and prove the guard actually fires.",
    [("a", "Set the override in the environment of any cron or SDK run — it is inert otherwise, "
           "which is the whole point of the design."),
     ("i", "Verified end to end in production, which earlier tests couldn't do: two identical "
           "list_bases calls, the second served entirely from cache. Per-agent keying is live — "
           "state keys on transcript_path, not session_id, so parallel subagents no longer "
           "share a ledger."),
     ("i", "A verification run is scheduled for Sun Aug 23, 9:00 AM against a locked baseline "
           "(91 calls, 68 billed, 24 avoidable), and the analysis script now lives at "
           "~/.claude/user-scripts/airtable-usage-report.py rather than in scratchpad.")]),

"local_f7d8dd68-bff6-4c00-bd39-3759649ad6c7": (
    "Work out why PayPal won't connect on knobcloud.com when buying an Ableton licence.",
    [("a", "Revoke KnobCloud in PayPal privacy settings, then reconnect — the existing "
           "grant is a narrow one that gets reused silently."),
     ("a", "On the fresh consent screen, approve everything and check it lists your "
           "address, not just name and email. Unchecking the address lands you back here."),
     ("a", "If that screen never mentions your address, stop and email KnobCloud support "
           "— their PayPal app has lost the address scope and you cannot grant it.")]),

"local_1a0057a0-039c-4a2d-8784-4652db7b8d5a": (
    "Automated hourly session-name-date-sweep run.",
    [("i", "Automated — 35 examined, 1 renamed. Nothing for you to do.")]),

"a2324028-6a0d-4f72-977b-dd5e7fe62891": (
    "Pick chord-chart-maker back up after a context break, which became the M7 Phase A "
    "discovery run.",
    [("a", "Phase A finished and then the session died on an API error (ENOTFOUND) before "
           "Claude could report it, so the findings were never delivered. The raw result is on "
           "disk in the session's task output; re-open and ask for the readout rather than "
           "re-running the fan-out."),
     ("q", "Worth checking before you trust it: the workflow returned **130 avenues and 88 "
           "corrections but a null document and zero ranked items**, so the discovery half "
           "landed and the ranking half did not."),
     ("i", "Housekeeping is clean: PR #3 (the M7 spec) merged, `main` at edddceb, and the "
           "`m3-import-probe` branch deleted local and remote after verifying it held no "
           "commits that weren't already merged."),
     ("i", "`.claude/settings.json` is modified in your working tree and was left alone — "
           "it isn't from this session."),
     ("i", "Next after M7 is M4, auto-fit and print.")]),

"local_cf24f1e7-7602-44e0-bdfb-57c680cb4dcd": (
    "Main working chat for Claude Quartermaster — design, build and issue triage.",
    [("q", "QM-8 / Phase 3 is still blocked on your scoping call: is encoding first-party "
           "guidance a fact the tool reports, or the judgement it hands back?"),
     ("a", "Close QM-48 as Done pointing at PR #43 — it was decided inside QM-44 "
           "(`Attestation.basis` is not published, doc corrected) but left open in Linear for "
           "you. Reopen it instead if you disagree with not publishing."),
     ("i", "QM-44 merged: the grid writes now, 697 tests, clean tree, no open PRs. The Phase 2 "
           "badge is gone."),
     ("i", "QM-30 (retire `SettingsFile.rest`) is the suggested next one — it shares "
           "src/view/model.ts with the write path that just landed.")]),

"local_7f3d1925-f4bd-46d1-9879-d07f6646853e": (
    "The running career-ops chat — job scans and tracker upkeep; the deanhicks.com "
    "redesign is now shipped.",
    [("a", "Your GitHub profile still points at deanhicks.me. Ten seconds in profile settings, "
           "and it's the link recruiters actually click."),
     ("a", "JOBS-38 is still open: wind deanhicks.me down to Cloudflare Email Routing before "
           "the 2026-11-11 expiry."),
     ("i", "The redesign is live and verified against the real URL, not localhost — valid cert, "
           "HTTP/2 200, both self-hosted fonts actually loading, four requests total and zero "
           "off-site, so the no-external-requests promise in your README still holds."),
     ("i", "Résumé content and markup are byte-identical to before; index.html changed by one "
           "line. Dark for OS-dark, light paper otherwise, both measured at WCAG AA (worst pair "
           "4.97:1), and print still gives the two-page CV."),
     ("i", "The last scan evaluated 14 roles and every report said don't apply, ceiling 3.9. "
           "Glean #557 contradicts itself — Greenhouse says remote, the JD says hybrid four "
           "days in SF or Mountain View.")]),

"b50d1a54-3cfe-4033-bd63-a06e9ce27c24": (
    "Draft answers to Cursor's application questions, stress-test them with peer agents, "
    "then research Cursor's recent marketing positioning to aim the rewrite.",
    [("q", "Abstract or concrete? You asked for mostly-abstract drafts; four independent "
           "analyses then called missing concrete detail the biggest AI tell. One concrete "
           "failure was added and flagged as unresolved rather than silently overriding you."),
     ("a", "Rework the drafts against Cursor's actual direction — agent swarms, cloud "
           "agents, production monitoring. Your current framing is single-developer, "
           "single-agent."),
     ("i", "A handoff is written for a fresh session. Tracker and Airtable untouched "
           "since nothing is submitted; step 5 has the exact command and record id.")]),

"local_7d1383a1-0b56-4def-900e-460da7e7996e": (
    "Reconfigure Gmail labels and filters around a deny-by-default design, and build the digest "
    "pipeline that rides on it.",
    [("a", "The verification gate runs itself today at 10:30. Read that report before anything "
           "touches the 181k backlog — archiving is explicitly forbidden to the scheduled "
           "run, so the call stays yours."),
     ("i", "Your mislabel is now a working feedback loop: `gmailops corrections` reads the "
           "label, proposes carve-out entries, restores the messages and rebuilds. It edits "
           "senders.yml by textual insert so the comments survive, and refuses to write if "
           "anything but the corrections key changed."),
     ("i", "Two live changes shipped: the bulk rule now requires the word “unsubscribe” "
           "before archiving (about 2 more messages a day stay in your inbox), and "
           "lennyrachitsky.com is carved out so Product Pass mail stops being archived."),
     ("i", "That fix exposed a bug that would have silently undone every future correction — "
           "Gmail has no filter-update operation, so changing the carve-out was creating a "
           "second bulk filter beside the old one. 122 tests passing.")]),

"bddc3c0f-46f7-4c79-a8f4-c2dc210c8851": (
    "Find why duplicate MCP servers appear across CLI, Desktop and Cyrus, and pin the mechanism.",
    [("i", "Finished — mechanism observed and the guide republished. No open asks.")]),

"local_23b76de3-dc8f-4eb6-bd83-eedf38ac958b": (
    "Run the career-ops cleanup and job-scan pipeline and clear the failures peer review surfaced.",
    [("q", "Decide whether “Internal Knowledge Manager” should surface in scans — it still "
           "doesn't despite the negative-filter fix, and it changes scan volume."),
     ("a", "Commit or discard the 2 uncommitted files left in the tree.")]),

"5b91eaa3-caa5-4eac-b343-224065a0cb72": (
    "Deep dive on ChordPro as the app's backing format — now a 73-item survey artifact plus "
    "feature suggestions and five proposals for reshaping the roadmap.",
    [("q", "Five roadmap proposals are on the table and Claude is waiting on which ones you "
           "want written into the design doc as a branch. The biggest is turning M6 into a "
           "playable stage view — pedals, autoscroll, minimal setlist — which roughly doubles "
           "M6 and pushes v1 out."),
     ("q", "Decide 'personal tool or product' before something forces it: ChordSheetJS is "
           "GPL-2.0-only and a shipped PWA bundle counts as distribution."),
     ("a", "Spend an evening with iReal Pro (~$20) and OnSong's free tier before M4 — they're "
           "your two nearest competitors and the feel is the point."),
     ("i", "The catalogue is done: 105 items trimmed to 73, scored across 10 columns in a "
           "sortable artifact. Original numbers kept, so earlier notes still resolve.")]),

"local_a47c7ae9-154e-40ec-86c7-5d46635927b4": (
    "Refine the daily ecosystem-report routine, and fence in what the unattended run is allowed "
    "to write.",
    [("i", "Nothing pending. The push you asked for was already done by another session; HEAD "
           "and origin/main are level."),
     ("i", "The boundary held under test: the task may now regenerate and commit toolstack.yaml "
           "and nothing else — the allowlist narrowed from `git add *` to `add toolstack.yaml`, "
           "so it can't stage its own instructions."),
     ("i", "Both copies of the prompt (repo file and the task's SKILL.md) were drifting apart "
           "and are now byte-identical. Six of fourteen Tier 2 URLs were wrong and were fixed "
           "by hand, since the task is no longer allowed to repair its own instructions.")]),

"7e267d09-6a88-40d8-8d25-5ca279423961": (
    "One-off question: which output style this session runs.",
    [("a", "Fix the naming mismatch Claude flagged — the output-style file's frontmatter says "
           "name: Rundown, but the settings key and filename say attention-kind.")]),

"local_58f55c0e-c093-4aa8-bdea-b61141a5ef2a": (
    "Automated session-name-date-sweep run.",
    [("i", "Automated — 33 examined, 5 renamed. Nothing for you to do.")]),

"local_77427ab3-a2f8-4a17-b43e-e6aeddbca875": (
    "Automated daily-brief run for the tool stack, which also pushed six pending commits.",
    [("a", "~/.claude/settings.json is modified locally and unpushed — the task left it alone "
           "on purpose. Commit it or revert it.")]),

"4ce2b192-761a-4321-993a-c37d40cd8310": (
    "Throwaway probe testing whether one Claude session can rename another over the message socket.",
    [("i", "Rename declined by design. Disposable — close it. Now also imported into "
           "the Desktop app by a deep-link test.")]),

"a43fcf80-9b8b-45c6-afa6-b464e106640b": (
    "Debug MCP server connections from the CLI, chasing a google-sheets reconnect failure.",
    [("a", "google-sheets times out after 30s. Re-authorize it or remove the server.")]),

"ed7a7704-9d85-434a-b2f1-cfc5829ad78e": (
    "Earlier attempt at the same google-sheets reconnect problem.",
    [("i", "Superseded by the later session. Close it.")]),

"6a504aa3-396f-4e7a-afe9-a48669d2ee5f": (
    "Orientation pass on chord-chart-maker that surfaced two loose threads.",
    [("a", "Push 213c048 — it's local-only right now."),
     ("a", "Write the M3 findings doc. PR #1 merged without it, and the handoff called that "
           "doc M3's actual deliverable.")]),

"5946e358-9c0d-4119-a5fb-068e2e47a9b7": (
    "Plan the next chord-chart-maker milestone and scope the deep import probe.",
    [("q", "Does audio analysis get to break the no-backend rule? In-browser WASM, a local "
           "service, and an MCP seam to music-analysis are architecturally different answers — "
           "this is the biggest fork in the plan."),
     ("q", "How public is this project becoming?"),
     ("a", "Upload the sample charts you said you'd send."),
     ("a", "Push the docs/deep-import-probe branch — committed but never pushed.")]),

"b994fc42-7253-4e5d-a776-b35426bfdd83": (
    "Fix a ChordPro CLI install that looked broken on Apple Silicon.",
    [("a", "Eject and delete the ChordPro (Apple Silicon) DMG — it isn't needed."),
     ("i", "Worth remembering: the packaged launcher never flushes stdout when stdout isn't a "
           "terminal, so piping chordpro output silently produces nothing with exit code 0.")]),

"6670ab65-8101-4192-83a0-29ce45236cbd": (
    "Check the Vercel tier and pricing, and land the layout fixes that missed the previous merge.",
    [("a", "Merge PR #2 — it's open with green checks, and production doesn't have the fixes "
           "until you do.")]),

"local_9c844152-c687-40fe-8a02-44ccfff41bce": (
    "Automated session-name-date-sweep run.",
    [("i", "Automated — 38 examined, 0 renamed. Nothing for you to do.")]),

"local_5e7c87c5-af2b-4939-805c-4ee25efd5a23": (
    "Automated session-name-date-sweep run.",
    [("i", "Automated — 37 examined, 0 renamed. Nothing for you to do.")]),

"local_1f539194-80e8-4eb6-a403-eee000a2ad34": (
    "Automated session-name-date-sweep run.",
    [("i", "Automated — 42 examined, 8 renamed. Nothing for you to do.")]),

"local_5ec2eb98-7256-4012-94d8-1e77ab2b5786": (
    "Build and ship the Carnevil VII attendee info form, backed by Airtable.",
    [("a", "Commit the 1 modified and 1 untracked file left in the tree.")]),

"5453e345-c045-4333-8b5a-74a0f3706c2c": (
    "Run project-optimizer onboarding on chord-chart-maker and verify the handoff loads in a "
    "fresh session.",
    [("i", "Confirmed working. Note that plugin changes only apply to sessions started after "
           "that one.")]),

"98d7c023-ed33-4890-9295-d51775d206dd": (
    "First half of the chord-chart-maker onboarding pass — setup hardening and getting CI green.",
    [("a", "Optional one-liner: bump actions/checkout, setup-node and pnpm/action-setup to v5. "
           "GitHub warns the v4 pins target Node 20, now deprecated on their runners.")]),

"cab7ab36-7162-4dfa-b189-cae975537f02": (
    "Answer what a Nimbalyst .mindmap file is — an SDK lookup, not interactive work.",
    [("i", "Answered. Nothing pending.")]),

"ed401f56-661e-44c6-ae11-149032db9535": (
    "One-off version check on the running Claude session.",
    [("q", "Claude offered to run project onboarding for ~/claude/general and you never "
           "answered. Still want it?")]),

"22d52a6a-2d63-48f4-8ec3-673be59cd05c": (
    "Long-running Airtable MCP connection session, latterly just being told to “continue”.",
    [("i", "Genuinely empty — the last open item (Linear MCP re-auth) is done. Close it.")]),

"local_90cb9bce-b954-4aac-8ad3-34a8e282904c": (
    "Design an ADHD-friendly workflow system — now an eight-agent audit of whether the "
    "board matches reality.",
    [("a", "Carnevil's town-board permit is filed as “2027 town board approval” with no "
           "owner and no due date, for an event 37 days out. Three siblings share the bug, "
           "including “Set 2027 ticket price”, 18 days overdue — and Price 1-day "
           "and Price 2-day are blank on all three festival records."),
     ("q", "The arithmetic is the real finding and it needs a decision, not a re-rank: "
           "385 hours of work require you present, against 53–106 hours before Sept 26. "
           "Only 30 of those hours are Carnevil-critical. Nothing on the board covers "
           "rehearsals, load-in, or performing in two bands."),
     ("i", "The board is wrong in both directions: music-analysis is already public while MUSA-6 "
           "sits in Todo, and cashortrade-search is still private while its project reads 100%.")]),

"local_d8dd537d-bd4c-4b53-b445-d285dafa15b6": (
    "Set up cloud sessions that work while the laptop is offline — bootstrap kit plus repo forks.",
    [("a", "Give the PlaySync fork the same doc regeneration logic2ableton already got.")]),

"f39e90ad-6bb4-43cd-a8b0-dd3345e69112": (
    "Generate a Claude Code usage insights report.",
    [("i", "Report generated locally. Nothing pending.")]),

"local_969b639c-fb6b-4eae-9e78-35e192fd2a2e": (
    "Diagnose slow Logic Pro startup, then inventory Waves plugin usage across every project.",
    [("i", "Reports regenerated and delivered. Nothing pending.")]),

"866d4f5d-7952-4a6d-9e42-e0c63b665033": (
    "Settle, once and for all, how Claude Code deduplicates MCP servers — the research behind "
    "claude-project-optimizer and the quartermaster plugin.",
    [("i", "Answered on live evidence, not docs: on 2.1.232 a lazy dedup suppresses plugin "
           "servers that duplicate claude.ai connectors, then suppresses the connector back — a "
           "mechanism neither of you predicted. Written into the guide artifact."),
     ("i", "The interactive TUI path stayed unobservable under `script`; only the headless path "
           "is proven. No config drift resulted from any of the experiments."),
     ("a", "Session is live and just compacted — pick it back up or close it; nothing is "
           "waiting on an answer.")]),

"767546c7-2d8d-411c-9c71-16d31ad7167b": (
    "Opened /skill-creator and never said what to build.",
    [("a", "Empty shell — the skill loaded, you logged in, and nothing followed. Say what skill "
           "you want or close it.")]),

"local_c9e14a2c-1f01-4409-90bb-f04d449780f9": (
    "Carnevil 7 artist comms, and latterly a seamless falling-chips background for the festival "
    "art.",
    [("a", "Run the Nano Banana prompt in Google AI Studio with `carnevil_graphics_0731.png` "
           "attached as the style reference. That's where this left off."),
     ("i", "Three approaches were tried and rejected in order: procedurally stamping icons onto "
           "the chips (bad spacing, leftover fragments, white residue in dark mode), then "
           "Midjourney, which kept producing sketchy Calvin-and-Hobbes linework however the "
           "prompt was tightened."),
     ("i", "The palette in the prompt is the real one, pulled from the design system's seven "
           "`--lucky-*` inks rather than eyeballed. Art sits on true black by the design "
           "system's own rule, which skips background removal entirely."),
     ("i", "Earlier in the session: the email went out, and all 16 acts are in Airtable with "
           "days assigned and marked Confirmed.")]),

"143c9783-1433-4be2-b7af-cc98db2a9afa": (
    "A console session — nothing but /mcp and /plugin runs, no conversation.",
    [("i", "Vercel MCP authenticated, oz-harness-support installed, two marketplaces removed. "
           "No model work happened here; safe to close.")]),

"local_70546ab7-7adc-4409-9459-1514d37b8209": (
    "Automated session-name-date-sweep run.",
    [("i", "Automated — 40 Desktop examined, 2 renamed (date tails only); 434 CLI transcripts, "
           "0 renamed. Nothing for you to do.")]),

"677cc1ea-5bdb-4cd8-bd1a-08a5a61e1bc0": (
    "Nothing happened here — a /login that was interrupted.",
    [("i", "Three messages, no conversation. Close it.")]),

"local_8f672474-ae9d-432b-99a0-c4b396b03255": (
    "Automated Tool Stack daily-brief run, which you then answered live to correct an Airtable "
    "record.",
    [("a", "The commit is local — `916759c` (Warp Build: Claude Usable no → yes) has not been "
           "pushed."),
     ("i", "Both research tiers were empty for the window; the only finding was your own data "
           "being wrong. Claude Code still 2.1.233."),
     ("i", "It declined to invent an `Access` value for 'Claude Code plugin' — the schema has "
           "no such choice and adding one is outside lane 2.")]),

"2069bab7-8a36-4f18-8c7f-352b851e28b2": (
    "Find what was stealing mouse focus in Logic Pro.",
    [("a", "Two suspects cleared, four still live if it recurs: Wispr Flow (11 processes with a "
           "global key listener), Universal Control, Granola, BetterDisplay."),
     ("i", "Five LogicProMCP processes are gone, so the logic-pro MCP tools are disconnected "
           "for that session until it reconnects. Loom uninstalled — 824MB, no recordings lost; "
           "its Screen Recording and Accessibility entries survive in the TCC database and can "
           "only be removed from System Settings.")]),

"local_879ec185-3bb3-4ec3-aac8-6cf55bc2e08a": (
    "Automated session-name-date-sweep run.",
    [("i", "Automated — 40 Desktop and 433 CLI transcripts examined, 0 renamed. Nothing for you "
           "to do.")]),

"8a64dbf3-6489-4595-bb71-ece59e77332c": (
    "Answer why a shared Google Drive folder downloads as several incomplete-looking zips.",
    [("i", "Answered — they're parts, not duplicates; Drive splits anything over ~2GB. Advice "
           "was to add a shortcut and use Drive for desktop. Nothing pending.")]),

"local_b05e4e95-67a8-4ba7-8dee-0dfa6a0145cd": (
    "Write the “Why Anthropic?” answer for the DevRel application, which turned into "
    "logging the night's applications into the tracker.",
    [("a", "Three roles logged with no evaluation run, so they carry no score: #586 Google "
           "Developer Relations Engineer, #587 LaunchDarkly Senior Developer Advocate, and a "
           "backfill of #385 Baseten. Follow-ups seeded for Aug 23 and Aug 26."),
     ("i", "Two things the eval pass would have caught: Google's $138–197K sits under your "
           "$150–250K target, and LaunchDarkly is a sales-adjacent growth motion — "
           "trial activation, response-time SLAs, pipeline attribution — not straight "
           "advocacy."),
     ("i", "Baseten's applied date is recorded as 2026-08-16 “approximate” on both "
           "sides, from your “sunday maybe”, rather than fabricated as exact."),
     ("i", "reconcile-airtable came back clean: 533 ↔ 533, matched on Tracker #, zero "
           "orphans either side.")]),

"local_62dced08-c223-490e-a9b5-403092da151c": (
    "Check four Decagon roles against the pipeline, which became a 21-role evaluation batch and "
    "an effort-rating repair.",
    [("a", "Three cleared the bar and none are applied to yet: #566 Anthropic Developer "
           "Relations at 4.8 (route via Ryland, don't cold-apply), #579 Plaid Sr DevRel at 4.6, "
           "#583 RunPod Senior Developer Advocate."),
     ("i", "You caught a real gap: effort ratings were computed by every eval and then never "
           "written to Airtable. 91 rows repaired, plus 14 more after refetching forms. Every "
           "active role now has one — zero blanks outside terminal rows."),
     ("i", "PR #171 merged (Ashby forms on custom career domains), 2284 tests green. The "
           "Make.com portals fix is gitignored user-layer data, so it lives only on this "
           "checkout."),
     ("i", "Still dirty from an earlier session and deliberately left out of every commit: "
           "`.claude/settings.json` and `LOCAL.md`. Two Dependabot branches also arrived.")]),

"local_80f5f8b4-33a6-445b-98d3-53b0e8e769e7": (
    "Keep Session Fleet current — rewrite stale summaries, and work the comment threads "
    "left on the published page.",
    [("a", "Flip Linear to dark for a moment if you want Magic Blue exact. Its base #191a23 and "
           "border #2d2e39 were read from your app; the surfaces and text are derived on the "
           "same LCH hue, because reading the real ones meant changing your theme setting."),
     ("a", "The eight comment threads are all acted on but still show open — resolving them "
           "needs a claude.ai session, which this one isn't."),
     ("i", "Pure Light is verbatim from your app; accent and the six state colours were left "
           "alone. Every subteam chip was refit against the new grounds and still clears AA, "
           "worst case 4.55:1 light and 4.59:1 dark."),
     ("i", "`author_summaries.py` had accumulated 3 duplicate entries — the splice matched on "
           "blank lines that an earlier splice had collapsed, so it appended instead of "
           "replacing. It's parser-based now, 56 unique entries, output verified identical."),
     ("i", "Dropping the Total tile means `?monitor=1` shows no session count at all, since "
           "monitor mode hides the toolbar where the count lives."),
     ("i", "This routine is now duplicated work — `/session-fleet refresh` does the same "
           "rescan-and-rewrite from the project directory. Worth retiring one of them."),
     ("i", "The artifact's live watch dropped and stopped retrying. Only affects notifications; "
           "the published page is unchanged, and a concurrent publish would 409 rather than "
           "silently overwrite.")]),

"local_ee75a028-de17-4750-bb38-6e797c0e31b6": (
    "Design hooks that surface the right tool at the right moment, plus a weekly routine that "
    "spends each service's unused allotment — latterly, wiring Cursor in as a code reviewer.",
    [("a", "Run `cursor-agent login`. The CLI is installed (2026.08.11, the build with the "
           "wedged-session fix) and the test is staged, but signing you into an account isn't "
           "something Claude will do for you and no `CURSOR_API_KEY` is set."),
     ("i", "The other two homes for this are both blocked: GitHub's Bugbot needs Cursor "
           "Business and you're on Pro, and Linear's @Cursor agent is an implementation agent, "
           "not a reviewer. The headless CLI is the one that fits."),
     ("i", "The test is deliberately a calibration, not a smoke test — it points at "
           "`toolstack-regen.py`, whose bare `IndexError` on a wrong call your CLAUDE.md "
           "already documents. If Cursor finds that, the tool works; if it returns generic "
           "advice, that's worth knowing too."),
     ("q", "The original hooks design still isn't approved, and it now carries the two extra "
           "workstreams you added — Linear Business with Loops, and Cursor Pro."),
     ("a", "Open Lovable's billing page and read one line: does it say resets Aug 22 or Sep 1? "
           "That single data point settles the whole cohort. Your credit pools almost certainly "
           "reset on the billing anniversary, not the 1st — every renewal date clusters on "
           "Jul 22 and Jul 26, so the real deadlines are Aug 22 and Aug 26, not month-end."),
     ("q", "Claude offered to start the Lovable half of the spend-the-credits work now."),
     ("i", "Airtable claims `calendar-month` for these, but that's an unverified assumption and "
           "the one service actually checked contradicts it — Cursor resets on the billing "
           "date, and Cursor is in the Jul 22 cohort."),
     ("i", "Not on a clock: Google AI Pro has no monthly pool (5-hour refresh), ElevenLabs just "
           "reset with 121k available through Sep 18, and n8n, Notion, Linear, Cyrus and "
           "Supabase have no monthly reset at all."),
     ("a", "Google AI Pro was downgraded on 2026-05-17: the 1,000 monthly AI credits left the "
           "base plan. `claimed-unused` also moved the wrong way, 8 → 10, with Supabase "
           "and ElevenLabs starting fresh clocks at zero extraction.")]),

"local_b69e3945-c4a5-455c-8525-2da6bc6d731c": (
    "Automated session-name-date-sweep run.",
    [("i", "Automated — 43 Desktop and 574 CLI transcripts examined, 2 renamed. Nothing for "
           "you to do.")]),

"local_8fc1d0bd-2486-4acb-b6bd-a94e56668048": (
    "A scheduled name sweep that died on an API error and never recovered.",
    [("q", "Claude is waiting on “what's the task for this session?” — it lost the "
           "thread after the failure. Nothing is pending; close it."),
     ("a", "This sweep never ran. It hit a 529, and after you switched to Sonnet it derailed "
           "into the project-optimizer onboarding offer instead of retrying the task. Later runs "
           "have since swept, so nothing is missing."),
     ("i", "One durable result: onboarding is now permanently declined for ~/claude/general, so "
           "the hook stops interrupting routines there.")]),

"local_ecfc7982-fae6-468f-b115-b05af4a3ad16": (
    "Automated session-name-date-sweep run.",
    [("i", "Automated — 37 renames, the biggest run yet: 1 Desktop plus a 36-session "
           "backfill of this task's own past runs, which had been sitting bare with no code "
           "or dates."),
     ("a", "Those leftovers accumulate at roughly 5–6 a day. They're the ones you archive "
           "in bulk, so the pile rebuilds itself between clean-ups.")]),

"local_66995bb1-9a44-4b63-9c19-fb9a957a9743": (
    "Build out Session Fleet's UI and tooling — hide unattended routine runs, tighten the "
    "row layout, and turn the re-summarize workflow into a skill.",
    [("i", "All three original asks shipped and are committed: routine runs are filtered out "
           "unless you actually replied in the thread, the row buttons moved to the meta line "
           "(cards down 267px → 180px), and `/session-fleet refresh` now exists as a skill."),
     ("i", "In flight: whether the refresh can run headless from the CLI so the menu bar gets "
           "a one-click button for it. Claude is working that out — nothing waiting on you.")]),

"local_9cf8e76f-1964-435c-be35-d3cf6011993c": (
    "Work out why CLI-started sessions rename inconsistently, then rebuild the session-name "
    "format around it.",
    [("q", "Fire the sweep once now so you can see the new titles, or let the schedule pick "
           "it up on its next run?"),
     ("i", "New format is live and verified end to end: `GEN | 0 | Session renaming CLI "
           "inconsistency | 8.20`. The idle counter reads the last **assistant** timestamp, not "
           "`lastActivityAt` — that field moves on any activity including a rename, so it would "
           "have reported 0 for every session the sweep touched."),
     ("i", "The prefix must be stripped exactly once, never in a loop: loop it and a name "
           "starting with a number gets eaten (`JOBS | 3 | 500 | error triage | 8.20` loses the "
           "`500` on the second pass). Nine cases unit-tested."),
     ("i", "The leading `*` means start-a-new-session-instead, and fires on compaction or very "
           "large context — roughly 15% of sessions, and it lands on exactly the long heavy "
           "threads. Note ~100k of any context figure is startup overhead; the thresholds "
           "already account for it."),
     ("i", "Changed: the sweep's SKILL.md and CLAUDE.md §5, which is the standard every other "
           "session reads.")]),

"3d4df9c2-1630-4cad-bfd1-158d1e2f8989": (
    "Hunt down whatever is leaking window-server shields and pinning WindowServer at 45% CPU.",
    [("a", "After the restart, just use the machine normally for a couple of hours, then check "
           "the shield count. That baseline rate is the measurement everything else compares "
           "against — testing against the poisoned 641 would tell you nothing."),
     ("i", "State at the pause: 641 shields, WindowServer 45%, Manus ruled out, Airtable quit "
           "but never tested. Remaining suspects are Claude desktop, Granola, 1Password, "
           "Brain.fm and replayd."),
     ("i", "Watch for the count staying near zero with everything running — that would mean the "
           "leak needs a specific trigger (a screen share, a recording, a meeting) rather than "
           "an app merely being open.")]),

"13c51216-0733-479f-8991-19d40b1c14d4": (
    "Install and authenticate the Higgsfield CLI so image and video generation works from "
    "Claude Code.",
    [("i", "Done and working — signed in as your account, Pro plan, ~611 credits. Just ask for "
           "what you want in plain English; the skills pick the model and params."),
     ("i", "The skills are project-scoped to `~/claude/general`, so they won't load anywhere "
           "else. Say the word and they move to `~/.claude/skills`."),
     ("i", "Two small things: `account status` needed a workspace, so your only one (Private, "
           "pro) was selected; and credits ticked 611.92 → 610.92 between two read-only calls. "
           "Nothing run here generates anything, so glance at it if it keeps drifting."),
     ("i", "Video models can be expensive — `higgsfield generate cost` prices a job before it "
           "spends.")]),

"local_afe5ba70-3715-4be7-a136-f0e6f8dce5ad": (
    "Squeeze the free-unlimited Manus window for research, media, and long-form autonomous "
    "builds before it closes.",
    [("a", "Fire the prompts while the window is open — eight are drafted and ready, three "
           "aimed at your existing projects and five at long autonomous runs (a full-stack app "
           "build deployed to a live URL, design work, productivity)."),
     ("a", "Anything Manus builds lives in its VM and on its hosting. Pull the source as a zip "
           "or push it to your own GitHub before the window closes, or you'll own a demo you "
           "can't rebuild."),
     ("i", "The app-build prompt is written to be reusable — swap the app description and "
           "re-fire it for any future build.")]),

"local_4234a808-e85b-40a5-8bdf-b18cc33f3003": (
    "Evaluate a batch of ~30 job postings and land the results in the tracker and Airtable.",
    [("i", "Batch fully closed out — 27 evaluated, 4 skipped as exact duplicates of existing "
           "reports, tracker and Airtable both synced and spot-checked. Nothing pending."),
     ("i", "17 new company records were created bare-minimum (Asana, Tenex, Nectar Social, "
           "Novig, Nebius, Harness, Ode, Modal, Sierra, Linear, Railway, Runware, LogRocket, "
           "Oso, Ritual, Meshy, Vibe). Full enrichment — Glassdoor, HQ, valuation — can run "
           "later via `analyze-companies` whenever you want it."),
     ("i", "11 of 25 roles have no salary data because none was disclosed, not because the sync "
           "missed it.")]),
}


def main():
    data = json.loads((HERE / "data.json").read_text())
    # Index under both ids so an entry keeps matching after a CLI session is
    # imported into the Desktop app and renamed local_<cliSessionId>.
    by_id = {}
    for s in data["sessions"]:
        by_id[s["id"]] = s
        if s.get("cli_session_id"):
            by_id[s["cli_session_id"]] = s

    entries = {}
    for sid, (purpose, bullets) in AUTHORED.items():
        s = by_id.get(sid)
        if not s:
            print(f"  skip (not in current scan): {sid}")
            continue
        entry = {
            "stamp": s["last_activity_at"],
            "turns": s["turns"],
            "purpose": purpose,
            "next": [{"type": t, "text": txt} for t, txt in bullets],
        }
        if sid in TITLES:
            entry["title"] = TITLES[sid]
        entries[sid] = entry

    out = {
        "_note": "Model-written. 'stamp' and 'turns' are the session's values when this was "
                 "written; render.py flags the entry stale when either has moved. Bullet types: "
                 "q = open question awaiting Dean, a = action for Dean, i = informational.",
        "entries": entries,
    }
    (HERE / "summaries.json").write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")

    missing = [s for s in data["sessions"]
               if s["id"] not in entries and (s.get("cli_session_id") or "") not in entries]
    print(f"wrote {len(entries)} entries; {len(missing)} sessions unsummarized")
    for s in missing:
        print("  missing:", s["id"], s["title"][:60])


if __name__ == "__main__":
    main()
