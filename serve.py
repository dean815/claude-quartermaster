#!/usr/bin/env python3
"""Serve Session Fleet locally, rebuilt on every page load.

  python3 serve.py                 # http://localhost:8787, 7-day window
  python3 serve.py --port 9000 --days 14

Every GET / re-runs collect.py and render.py, so the page is current the moment
it loads. That costs zero tokens — the scan is Python plus `git`, with no model
in the loop. Only the purpose/next-step text needs Claude, and it is cached in
summaries.json until you ask for it to be rewritten.

Binds to 127.0.0.1 only. The page reads your session transcripts, so do not
expose it beyond this machine.
"""

import argparse
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "local.html"
build_lock = threading.Lock()


def rebuild(days, auto_seconds):
    """Re-scan and re-render. Returns (ok, message)."""
    with build_lock:
        for cmd in (
            [sys.executable, str(HERE / "collect.py"), "--days", str(days)],
            [sys.executable, str(HERE / "render.py"), "--local",
             "--auto-seconds", str(auto_seconds), "--out", str(OUT)],
        ):
            r = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE)
            if r.returncode != 0:
                return False, f"{Path(cmd[1]).name} failed:\n{r.stderr}"
        return True, "ok"


def error_page(msg):
    return f"""<title>Session Fleet — build failed</title>
<body style="font-family:ui-monospace,Menlo,monospace;background:#0f1115;color:#e7e9ef;
padding:40px;line-height:1.6">
<h1 style="font-family:ui-sans-serif,-apple-system,sans-serif">Rebuild failed</h1>
<p>The scan or render step errored. The last good page is still at
<code>local.html</code>.</p>
<pre style="white-space:pre-wrap;background:#171a20;padding:16px;border-radius:8px;
border:1px solid #262a33">{msg}</pre>
</body>""".encode()


def make_handler(days, auto_seconds):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, body, status=200, ctype="text/html; charset=utf-8"):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            # ?monitor=1 is handled client-side (auto-refresh on, toolbar hidden),
            # so the query string is stripped for routing but kept in the URL.
            if self.path.split("?")[0] not in ("/", "/index.html"):
                self._send(b"not found", 404, "text/plain")
                return
            ok, msg = rebuild(days, auto_seconds)
            if not ok:
                sys.stderr.write(msg + "\n")
                if OUT.exists():
                    self._send(OUT.read_bytes())
                else:
                    self._send(error_page(msg), 500)
                return
            self._send(OUT.read_bytes())

        def do_POST(self):
            if self.path != "/rescan":
                self._send(b"not found", 404, "text/plain")
                return
            ok, msg = rebuild(days, auto_seconds)
            self._send(msg.encode(), 200 if ok else 500, "text/plain")

        def log_message(self, fmt, *a):
            pass                      # the default access log is pure noise here

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--days", type=float, default=7)
    ap.add_argument("--auto-seconds", type=int, default=180)
    args = ap.parse_args()

    ok, msg = rebuild(args.days, args.auto_seconds)
    if not ok:
        sys.exit(msg)

    srv = ThreadingHTTPServer(("127.0.0.1", args.port),
                              make_handler(args.days, args.auto_seconds))
    print(f"Session Fleet  →  http://localhost:{args.port}")
    print(f"  rebuilds on every load · {args.days:g}-day window · 0 tokens per refresh")
    print("  ctrl-c to stop")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
