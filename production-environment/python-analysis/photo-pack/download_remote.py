#!/usr/bin/env python3
"""Download third-party image URLs into files/remote/<host>/<ean>.ext

Skips our own CDN (those files are rsynced). Safe to re-run; existing files are kept.
Never writes the shop.
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock
from urllib.parse import urlparse

UA = "SillagePhotoPack/1.0 (+https://github.com/unseencurtain/Sillage; offline migration pack)"
MIN_BYTES = 2000


def fetch(url: str, dest: Path, timeout: int = 25) -> tuple[str, str]:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        import subprocess

        proc = subprocess.run(
            [
                "curl",
                "-sS",
                "-L",
                "--globoff",
                "--max-time",
                str(timeout),
                "--connect-timeout",
                "8",
                "--max-filesize",
                "8000000",
                "-A",
                UA,
                "-o",
                str(tmp),
                "-w",
                "%{http_code}",
                url,
            ],
            capture_output=True,
            timeout=timeout + 8,
            text=True,
        )
        code = (proc.stdout or "").strip()
        if proc.returncode != 0 or code not in {"200", "226"}:
            if tmp.exists():
                tmp.unlink()
            return url, f"http_{code or proc.returncode}"
        size = tmp.stat().st_size if tmp.exists() else 0
        if size < MIN_BYTES:
            tmp.unlink(missing_ok=True)
            return url, f"too_small_{size}"
        tmp.replace(dest)
        return url, "ok"
    except Exception as exc:
        tmp.unlink(missing_ok=True)
        return url, f"err_{type(exc).__name__}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pack", default="/workspace/photo-pack")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    pack = Path(args.pack)
    src = pack / "lists" / "third-party-urls.csv"
    if not src.exists():
        raise SystemExit(f"missing {src} — run build_index.py first")

    rows = list(csv.DictReader(src.open(encoding="utf-8")))
    jobs: list[tuple[str, Path]] = []
    for row in rows:
        url = (row.get("url") or "").strip()
        rel = (row.get("suggested_file") or "").strip()
        if not url or not rel:
            continue
        dest = pack / rel
        if dest.exists() and dest.stat().st_size >= MIN_BYTES:
            continue
        jobs.append((url, dest))
    if args.limit:
        jobs = jobs[: args.limit]

    print(f"download {len(jobs)} of {len(rows)} third-party URLs, workers={args.workers}", flush=True)
    counts: dict[str, int] = {}
    lock = Lock()
    done = 0
    t0 = time.time()

    def run(job: tuple[str, Path]) -> None:
        nonlocal done
        url, dest = job
        _, status = fetch(url, dest)
        with lock:
            counts[status] = counts.get(status, 0) + 1
            done += 1
            if done % 100 == 0 or done == len(jobs):
                print(f"  {done}/{len(jobs)} {counts} {time.time()-t0:.0f}s", flush=True)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = [pool.submit(run, job) for job in jobs]
        for fut in as_completed(futs):
            fut.result()

    report = {"attempted": len(jobs), "counts": counts, "seconds": round(time.time() - t0, 1)}
    (pack / "lists" / "remote-download-report.json").write_text(
        __import__("json").dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print(report)
    return 0 if counts.get("ok", 0) or not jobs else 1


if __name__ == "__main__":
    raise SystemExit(main())
