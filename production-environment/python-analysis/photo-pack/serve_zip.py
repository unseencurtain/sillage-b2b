#!/usr/bin/env python3
"""Serve one zip, then exit so the port closes.

After the zip has been fully sent, the process shuts down. Ctrl+C also stops it.
Binds 127.0.0.1 unless you pass --bind (the cloud preview needs a public bind;
that process still dies after the download).
"""
from __future__ import annotations

import argparse
import os
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class OneShotHandler(BaseHTTPRequestHandler):
    zip_path: Path
    token: str
    done: threading.Event

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    def do_HEAD(self) -> None:  # noqa: N802
        """Health checks / Preview probes. Never send the zip; never shut down."""
        if self._is_page():
            body = self._page_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return
        if self._is_zip():
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(self.zip_path.stat().st_size))
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="{self.zip_path.name}"',
            )
            self.end_headers()
            return
        self.send_error(404, "Not found")

    def do_GET(self) -> None:  # noqa: N802
        if self._is_page():
            self._page()
            return
        if self._is_zip():
            self._send_zip()
            return
        self.send_error(404, "Not found")

    def _is_page(self) -> bool:
        return self.path in {"/", "/index.html", f"/{self.token}/", f"/{self.token}"}

    def _is_zip(self) -> bool:
        name = self.zip_path.name
        return self.path in {f"/{name}", f"/{self.token}/{name}"}

    def _page_bytes(self) -> bytes:
        href = f"/{self.token}/{self.zip_path.name}"
        size_mb = self.zip_path.stat().st_size / (1024 * 1024)
        title = getattr(self, "page_title", None) or "Sillage download"
        blurb = getattr(self, "page_blurb", None) or (
            f"{size_mb:.0f} MB zip. Click once — this server closes after the file is sent."
        )
        return f"""<!doctype html>
<meta charset="utf-8">
<title>{title}</title>
<style>body{{font:18px/1.4 system-ui;margin:2rem auto;max-width:36rem;padding:0 1rem}}
a{{display:inline-block;margin:.8rem 0;padding:.6rem 1rem;background:#111;color:#fff;text-decoration:none;border-radius:6px}}
p.note{{color:#444;font-size:14px}}</style>
<h1>{title}</h1>
<p>{blurb}</p>
<p><a href="{href}">Download zip ({size_mb:.0f} MB)</a></p>
<p class="note">When the download finishes, this server exits and the port closes.</p>
""".encode()

    def _page(self) -> None:
        body = self._page_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _send_zip(self) -> None:
        size = self.zip_path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", f'attachment; filename="{self.zip_path.name}"')
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        sent_ok = False
        try:
            with self.zip_path.open("rb") as fh:
                while True:
                    chunk = fh.read(1024 * 256)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            sent_ok = True
        except BrokenPipeError:
            self.log_message("client disconnected before the zip finished")
        if sent_ok:
            self.log_message("zip sent — shutting down")
            threading.Thread(target=self._shutdown, daemon=True).start()

    def _shutdown(self) -> None:
        # Let this response flush, then stop the server.
        import time

        time.sleep(0.4)
        self.server.shutdown()
        OneShotHandler.done.set()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--zip", required=True)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18765)
    ap.add_argument("--token", default="photos")
    ap.add_argument("--pid-file", default="")
    ap.add_argument("--minutes", type=int, default=60, help="Failsafe: stop even if nobody downloads")
    ap.add_argument("--title", default="Sillage photo pack")
    ap.add_argument("--blurb", default="")
    args = ap.parse_args()
    zpath = Path(args.zip).resolve()
    if not zpath.is_file():
        raise SystemExit(f"zip not found: {zpath}")

    OneShotHandler.zip_path = zpath
    OneShotHandler.token = args.token
    OneShotHandler.page_title = args.title
    OneShotHandler.page_blurb = args.blurb
    OneShotHandler.done = threading.Event()

    ThreadingHTTPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer((args.bind, args.port), OneShotHandler)
    pid_path = Path(args.pid_file) if args.pid_file else zpath.parent / ".serve.pid"
    pid_path.write_text(str(os.getpid()) + "\n", encoding="utf-8")

    def stop(_signum: int | None = None, _frame: object | None = None) -> None:
        httpd.shutdown()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def failsafe() -> None:
        import time

        time.sleep(max(1, args.minutes) * 60)
        print("failsafe timer — shutting down", flush=True)
        httpd.shutdown()

    threading.Thread(target=failsafe, daemon=True).start()

    url = f"http://{args.bind}:{args.port}/{args.token}/{zpath.name}"
    print(f"download {url}", flush=True)
    print(f"pid {os.getpid()}  (stop: kill $(cat {pid_path}))", flush=True)
    print("port closes after the zip is downloaded, or when you stop it", flush=True)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
        pid_path.unlink(missing_ok=True)
        print("stopped — port is closed", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
