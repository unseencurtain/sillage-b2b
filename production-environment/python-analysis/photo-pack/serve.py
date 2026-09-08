#!/usr/bin/env python3
"""Serve the photo pack on localhost, with a stop file and a time limit.

Default bind is 127.0.0.1 — the port is not reachable from the internet.
Never use `python3 -m http.server` on 0.0.0.0 for this pack.

Stop any of these ways:
  - scripts/stop-serve.sh
  - kill $(cat .serve.pid)
  - Ctrl+C
  - wait for --minutes to elapse (default 45)

A random token is required in the URL so a guessed port is not enough.
"""
from __future__ import annotations

import argparse
import os
import secrets
import signal
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class TokenHandler(SimpleHTTPRequestHandler):
    token = ""
    pack_name = "photo-pack"

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    def do_GET(self) -> None:  # noqa: N802
        prefix = "/" + self.token
        if self.path in {"/", "/index.html"}:
            self._index()
            return
        if not self.path.startswith(prefix + "/") and self.path != prefix:
            self.send_error(403, "token required — open the URL printed by start-serve.sh")
            return
        rest = self.path[len(prefix) :] or "/"
        if rest == "/":
            self._index()
            return
        self.path = rest
        return SimpleHTTPRequestHandler.do_GET(self)

    def _index(self) -> None:
        body = f"""<!doctype html>
<meta charset="utf-8">
<title>Sillage photo pack</title>
<style>
 body {{ font: 16px/1.45 system-ui, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1rem; }}
 code {{ background: #f3f3f3; padding: 0.1em 0.35em; }}
 .stop {{ color: #8a1f1f; }}
</style>
<h1>Sillage photo pack</h1>
<p>This server is bound to <strong>127.0.0.1</strong> (or the bind printed at start). Close it when you are done.</p>
<ul>
 <li><a href="/{self.token}/README.md">README.md</a> — missing counts + how to restore</li>
 <li><a href="/{self.token}/STATE.json">STATE.json</a></li>
 <li><a href="/{self.token}/lists/">lists/</a></li>
 <li><a href="/{self.token}/sillage-photo-pack.zip">sillage-photo-pack.zip</a> (if present)</li>
</ul>
<p class="stop">Stop: <code>./scripts/stop-serve.sh</code> or <code>kill $(cat .serve.pid)</code></p>
""".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default="/workspace/photo-pack")
    ap.add_argument("--bind", default="127.0.0.1", help="Use 127.0.0.1. Do not pass 0.0.0.0 unless you must.")
    ap.add_argument("--port", type=int, default=18765)
    ap.add_argument("--minutes", type=int, default=45)
    ap.add_argument("--pid-file", default="")
    ap.add_argument("--token-file", default="")
    ap.add_argument("--token", default="")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    if not root.is_dir():
        raise SystemExit(f"root does not exist: {root}")
    os.chdir(root)

    if args.bind in {"0.0.0.0", "::", "[::]"}:
        print(
            "REFUSING 0.0.0.0 / :: — that is how a pack stayed on the internet last time.\n"
            "Bind 127.0.0.1 and SSH-tunnel: ssh -L 18765:127.0.0.1:18765 ovhe",
            file=sys.stderr,
        )
        return 2

    token = args.token or secrets.token_urlsafe(18)
    TokenHandler.token = token
    handler = partial(TokenHandler, directory=str(root))
    httpd = ThreadingHTTPServer((args.bind, args.port), handler)
    pid_path = Path(args.pid_file or (root / ".serve.pid"))
    token_path = Path(args.token_file or (root / ".serve.token"))
    pid_path.write_text(str(os.getpid()) + "\n", encoding="utf-8")
    token_path.write_text(token + "\n", encoding="utf-8")

    url = f"http://{args.bind}:{args.port}/{token}/"
    print(f"serving {root}")
    print(f"URL     {url}")
    print(f"PID     {os.getpid()}  ({pid_path})")
    print(f"auto-stop in {args.minutes} minutes")
    print("stop with:  kill $(cat .serve.pid)   or   scripts/stop-serve.sh")

    def shutdown_later() -> None:
        time.sleep(max(1, args.minutes) * 60)
        print("time limit reached — shutting down", flush=True)
        httpd.shutdown()

    threading.Thread(target=shutdown_later, daemon=True).start()

    def handle_stop(signum: int, _frame: object) -> None:
        print(f"signal {signum} — shutting down", flush=True)
        httpd.shutdown()

    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)

    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
        pid_path.unlink(missing_ok=True)
        print("stopped — port is closed", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
