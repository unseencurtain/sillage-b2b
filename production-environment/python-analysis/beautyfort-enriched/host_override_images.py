#!/usr/bin/env python3
"""
Download remote image URLs from image_overrides.json into ecom_sites/data/media/
and rewrite those keys to PUBLIC_URL_BASE/<EAN>.<ext> (images CDN / lps-media).

Default scope: wholesale-perfumes flask_front CDN (images.elsvc.net). Never clobber
override keys that already point at the public base (or legacy /lps-media paths).
Resume-friendly (skips existing files).

Usage:
  python3 host_override_images.py --dry-run
  python3 host_override_images.py --host images.elsvc.net
  python3 host_override_images.py --host www.oceanfragrances.com --limit 50

Env (first match wins):
  LPS_MEDIA_BASE_URL / IMAGE_HOST_BASE_URL / PUBLIC_URL_BASE
  default https://images.prinscosmetic.eu
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
ANALYSIS = ROOT.parent
REPO_ECOM_MEDIA = ANALYSIS.parent / "ecom_sites" / "data" / "media"
CORE_OVERRIDES = ANALYSIS.parent / "sillage-core" / "data" / "image_overrides.json"
DEFAULT_PUBLIC = "https://images.prinscosmetic.eu"


def resolve_public_base() -> str:
    for key in ("LPS_MEDIA_BASE_URL", "IMAGE_HOST_BASE_URL", "PUBLIC_URL_BASE"):
        raw = (os.environ.get(key) or "").strip()
        if raw:
            return raw.rstrip("/")
    return DEFAULT_PUBLIC


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = val


def ext_from_url(url: str) -> str:
    path = urlparse(url).path
    suffix = Path(path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        return ".jpg" if suffix == ".jpeg" else suffix
    return ".jpg"


def download_one(ean: str, url: str, dest: Path, timeout: float) -> tuple[str, str]:
    """Returns (ean, status) where status is ok|exists|error:..."""
    if dest.is_file() and dest.stat().st_size > 0:
        return ean, "exists"
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, method="GET")
    req.add_header("User-Agent", "SillageImageHost/1.0")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
            ctype = (resp.headers.get("Content-Type") or "").lower()
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as err:
        return ean, f"error:{err}"
    if not data or len(data) < 32:
        return ean, "error:empty"
    looks_image = data[:3] == b"\xff\xd8\xff" or data[:4] == b"\x89PNG" or data[:4] == b"RIFF"
    if "image" not in ctype and not looks_image:
        return ean, f"error:not-image:{ctype or 'unknown'}"
    tmp.write_bytes(data)
    tmp.replace(dest)
    return ean, "ok"


def main(argv: list[str] | None = None) -> int:
    load_dotenv(ANALYSIS / ".env")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--overrides",
        type=Path,
        default=CORE_OVERRIDES,
        help="Path to image_overrides.json",
    )
    parser.add_argument(
        "--media-dir",
        type=Path,
        default=REPO_ECOM_MEDIA,
        help="Host directory bind-mounted into lps-media nginx (document root)",
    )
    parser.add_argument(
        "--host",
        default="images.elsvc.net",
        help="Only rewrite/download URLs whose host equals this (default WPF CDN)",
    )
    parser.add_argument(
        "--public-base",
        default=resolve_public_base(),
        help="Public URL prefix for rewritten overrides (no trailing slash)",
    )
    parser.add_argument("--concurrency", type=int, default=6)
    parser.add_argument("--limit", type=int, default=0, help="Max EANs to process (0=all)")
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--write-overrides",
        action="store_true",
        default=True,
        help="Rewrite override URLs after successful download (default on)",
    )
    parser.add_argument("--no-write-overrides", action="store_false", dest="write_overrides")
    args = parser.parse_args(argv)

    if not args.overrides.is_file():
        print(f"missing overrides: {args.overrides}", file=sys.stderr)
        return 1

    overrides: dict[str, str] = json.loads(args.overrides.read_text(encoding="utf-8"))
    jobs: list[tuple[str, str, Path]] = []
    for ean, url in overrides.items():
        if not isinstance(url, str) or not url.startswith("http"):
            continue
        if url.startswith(f"{args.public_base}/") or "/lps-media/" in url:
            continue
        host = urlparse(url).hostname or ""
        if host != args.host:
            continue
        dest = args.media_dir / f"{ean}{ext_from_url(url)}"
        jobs.append((ean, url, dest))

    jobs.sort(key=lambda t: t[0])
    if args.limit and args.limit > 0:
        jobs = jobs[: args.limit]

    print(f"host={args.host} candidates={len(jobs)} media={args.media_dir}")
    print(f"public_base={args.public_base} concurrency={args.concurrency}")
    if args.dry_run:
        for ean, url, dest in jobs[:10]:
            print(f"  would {ean} ← {url[:90]} → {dest.name}")
        if len(jobs) > 10:
            print(f"  ... and {len(jobs) - 10} more")
        return 0

    args.media_dir.mkdir(parents=True, exist_ok=True)
    stats = {"ok": 0, "exists": 0, "error": 0}
    errors: list[str] = []
    done_eans: set[str] = set()

    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        futs = {
            pool.submit(download_one, ean, url, dest, args.timeout): (ean, dest)
            for ean, url, dest in jobs
        }
        for i, fut in enumerate(as_completed(futs), 1):
            ean, dest = futs[fut]
            try:
                _, status = fut.result()
            except Exception as err:  # noqa: BLE001
                status = f"error:{err}"
            if status.startswith("error"):
                stats["error"] += 1
                if len(errors) < 15:
                    errors.append(f"{ean}: {status}")
            else:
                stats[status] = stats.get(status, 0) + 1
                done_eans.add(ean)
            if i % 50 == 0 or i == len(futs):
                print(f"  progress {i}/{len(futs)} {stats}", flush=True)

    rewritten = 0
    if args.write_overrides and done_eans:
        for ean in done_eans:
            dest = args.media_dir / f"{ean}{ext_from_url(overrides[ean])}"
            if not dest.is_file():
                # prefer whatever file we actually wrote
                matches = list(args.media_dir.glob(f"{ean}.*"))
                if not matches:
                    continue
                dest = matches[0]
            overrides[ean] = f"{args.public_base}/{dest.name}"
            rewritten += 1
        backup = args.overrides.with_suffix(".json.bak")
        backup.write_text(args.overrides.read_text(encoding="utf-8"), encoding="utf-8")
        args.overrides.write_text(
            json.dumps(overrides, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"rewrote {rewritten} override URLs (backup {backup.name})")

    print(f"done {stats}")
    if errors:
        print("sample errors:")
        for line in errors:
            print(" ", line)
    return 0 if stats["error"] == 0 or stats["ok"] + stats["exists"] > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
