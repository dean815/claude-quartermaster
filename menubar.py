#!/usr/bin/env python3
"""Session Fleet menu bar agent.

Shows how many Claude sessions are waiting on you, lists them in a dropdown that
jumps straight into each one, and notifies when a session finishes its turn.

  .venv/bin/python menubar.py

Runs the local dashboard server as a child process, so quitting the agent stops
everything. Polling is free — no model, no tokens, ~0.4s per sweep.
"""

import atexit
import fcntl
import os
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

import rumps

sys.path.insert(0, str(Path(__file__).parent))
import watcher  # noqa: E402

HERE = Path(__file__).parent
PORT = 8787
POLL_SECONDS = 20
NOTIFIER = "/opt/homebrew/bin/terminal-notifier"
MAX_MENU_ITEMS = 12
ICON_IDLE = HERE / "icons/fleet.png"
ICON_ALERT = HERE / "icons/fleet-alert.png"
ICON_POINTS = 13          # menu bar is ~22pt tall; 13 keeps the item narrow
LAUNCH_LABEL = "com.deanhicks.sessionfleet"


def log(msg):
    """Timestamped line to stderr, which launchd routes to .agent.log.

    The agent died once leaving an empty log and exit code 0, which made the
    cause unrecoverable. Start, stop and error are all worth a line.
    """
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {msg}", file=sys.stderr, flush=True)


def claim_singleton():
    """Refuse to start if another agent already holds the lock.

    Two agents means two menu bar icons and duplicate notifications, and the
    second one's server child dies on the taken port — confusing to diagnose.
    The lock is released automatically when the process exits, however it exits.
    """
    lock = open(HERE / ".menubar.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("refusing to start: another agent holds the lock")
        sys.exit("Session Fleet is already running. "
                 "Use ./install-agent.sh uninstall to stop it.")
    return lock                    # keep a reference alive for the process lifetime


def notify(title, subtitle, message, open_url=None):
    """Post a macOS notification. Falls back to osascript if terminal-notifier is absent."""
    if Path(NOTIFIER).exists():
        cmd = [NOTIFIER, "-title", title, "-subtitle", subtitle,
               "-message", message, "-group", "session-fleet",
               "-sender", "com.apple.Terminal"]
        if open_url:
            cmd += ["-open", open_url]
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        safe = message.replace('"', "'")
        subprocess.Popen(
            ["osascript", "-e",
             f'display notification "{safe}" with title "{title}" subtitle "{subtitle}"'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class Fleet(rumps.App):
    def __init__(self):
        super().__init__("Session Fleet", title="",
                         icon=str(ICON_IDLE), template=True, quit_button=None)
        self._icon_state = None
        self.server = None
        self.rows = []
        self.notifications_on = True
        self._fit_icon()
        self.start_server()
        self.refresh(seed=True)

    # ---------------------------------------------------------------- server

    def start_server(self):
        if self.server and self.server.poll() is None:
            return
        self.server = subprocess.Popen(
            [sys.executable, str(HERE / "serve.py"), "--port", str(PORT)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=HERE)

    # ---------------------------------------------------------------- menu

    def rebuild_menu(self, hot, working):
        self.menu.clear()
        items = []

        if hot:
            n_over = sum(1 for r in hot if r["state"] == "overdue")
            head = f"{len(hot)} waiting on you"
            if n_over:
                head += f" ({n_over} overdue)"
            items.append(rumps.MenuItem(head, callback=None))
            for r in hot[:MAX_MENU_ITEMS]:
                flag = "! " if r["state"] == "overdue" else "  "
                label = f" {flag}{r['repo'][:16]} · {r['title'][:36]}" if r["repo"] \
                        else f" {flag}{r['title'][:46]}"
                item = rumps.MenuItem(label, callback=self.open_session)
                item.session = r
                items.append(item)
                if r["question"]:
                    q = rumps.MenuItem(f"        ? {r['question'][:60]}", callback=None)
                    items.append(q)
            if len(hot) > MAX_MENU_ITEMS:
                items.append(rumps.MenuItem(
                    f"   …and {len(hot) - MAX_MENU_ITEMS} more", callback=None))
        else:
            items.append(rumps.MenuItem("Nothing waiting on you", callback=None))

        items += [
            rumps.separator,
            rumps.MenuItem(f"{working} running", callback=None),
            rumps.separator,
            rumps.MenuItem("Open dashboard", callback=self.open_dashboard, key="d"),
            rumps.MenuItem("Refresh now", callback=self.manual_refresh, key="r"),
            rumps.MenuItem(
                f"Notifications: {'on' if self.notifications_on else 'off'}",
                callback=self.toggle_notifications),
            rumps.separator,
            rumps.MenuItem("Quit", callback=self.quit_all, key="q"),
        ]
        for it in items:
            self.menu.add(it)

    # ---------------------------------------------------------------- actions

    def open_session(self, sender):
        r = getattr(sender, "session", None)
        if not r:
            return
        # A deep link only exists where importing can't create a duplicate;
        # otherwise send them to the dashboard row instead of doing damage.
        if r.get("deeplink"):
            subprocess.Popen(["open", r["deeplink"]])
        else:
            self.open_dashboard(None)

    def open_dashboard(self, _):
        self.start_server()
        webbrowser.open(f"http://localhost:{PORT}/")

    def manual_refresh(self, _):
        self.refresh()

    def toggle_notifications(self, _):
        self.notifications_on = not self.notifications_on
        self.refresh()

    def quit_all(self, _):
        log("quit requested from the menu")
        if self.server and self.server.poll() is None:
            self.server.terminate()
        # launchd has KeepAlive=true, so exiting alone would just respawn us.
        # Boot the job out first; that is what makes Quit mean quit.
        subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LAUNCH_LABEL}"],
                       capture_output=True)
        rumps.quit_application()

    def _fit_icon(self):
        """Scale the icon to ICON_POINTS tall, preserving aspect.

        rumps hardcodes 20x20 on every status image, which both squashes a
        non-square mark and reserves more width than the artwork needs. The PNGs
        are cropped to their bounding box, so honouring their real aspect is what
        keeps the item narrow.
        """
        try:
            img = self._icon_nsimage
            # img.size() is useless here: rumps already stamped 20x20 on it, so
            # reading that back gives a 1:1 aspect and squares the mark again.
            # The bitmap representation still knows the real pixel dimensions.
            reps = img.representations()
            w, h = (reps[0].pixelsWide(), reps[0].pixelsHigh()) if reps else img.size()
            if h:
                img.setSize_((round(w / h * ICON_POINTS, 1), ICON_POINTS))
            if getattr(self, "_nsapp", None):
                self._nsapp.setStatusBarIcon()
        except Exception as e:
            log(f"icon resize skipped: {e}")

    # ---------------------------------------------------------------- poll

    def refresh(self, seed=False):
        try:
            results = watcher.scan()
        except Exception as e:                       # never let a bad sweep kill the agent
            self.title = " ⚠"
            self.menu.clear()
            self.menu.add(rumps.MenuItem(f"Scan failed: {e}", callback=None))
            self.menu.add(rumps.MenuItem("Quit", callback=self.quit_all))
            return

        hot = watcher.needs_you(results)
        working = sum(1 for r in results if r["state"] in ("running", "subagents"))
        fresh = watcher.diff(results, seed=seed)

        # The icon carries state on its own, so a quiet menu bar stays quiet:
        # no number at all when nothing needs you.
        want = "alert" if hot else "idle"
        if want != self._icon_state:
            self.icon = str(ICON_ALERT if hot else ICON_IDLE)
            self._fit_icon()
            self._icon_state = want
        self.title = f"{len(hot)}" if hot else ""
        self.rebuild_menu(hot, working)

        if self.notifications_on and not seed:
            for r in fresh:
                if not any(h["sid"] == r["sid"] for h in hot):
                    continue                          # transitioned but already stale
                notify(
                    title=r["title"][:60] or "Claude session",
                    subtitle=(r["repo"] or "") + (" · asked a question" if r["question"] else ""),
                    message=r["question"] or "Finished its turn and is waiting on you.",
                    open_url=r.get("deeplink") or f"http://localhost:{PORT}/",
                )

    @rumps.timer(POLL_SECONDS)
    def tick(self, _):
        if not getattr(self, "_probed", False):
            self._probed = True
            try:
                item = self._nsapp.nsstatusitem
                img = item.image()
                sz = img.size() if img else None
                log(f"statusitem={item is not None} title={item.title()!r} "
                    f"image={sz and (round(sz.width,1), round(sz.height,1))} "
                    f"visible={item.isVisible()} length={round(item.length(),1)}")
            except Exception as e:
                log(f"statusitem probe failed: {e}")
        self.refresh()


def hide_from_dock():
    """Menu bar only — no Dock icon, no ⌘-Tab entry.

    A plain Python script has no bundle of its own, so the usual LSUIElement
    key has nowhere to live: the process inherits the Python framework's
    Info.plist, which declares a regular app. Setting the activation policy to
    Accessory on the shared application does the same job at runtime, and has
    to happen before the event loop starts.
    """
    from AppKit import NSApplication, NSApplicationActivationPolicyAccessory
    NSApplication.sharedApplication().setActivationPolicy_(
        NSApplicationActivationPolicyAccessory)


if __name__ == "__main__":
    _lock = claim_singleton()
    log(f"starting (pid {os.getpid()})")
    atexit.register(lambda: log("exiting"))
    hide_from_dock()
    Fleet().run()
