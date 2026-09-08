#!/usr/bin/env python3
"""Restore shop photos that live on the images CDN.

Git tracks EAN → URL in ``sillage-core/data/image_overrides.json``. The JPEG/WebP
bytes are **not** in git (~400 MB). On a new VPS, put those files back into
``~/ecom_sites/data/media/`` so ``https://images.<domain>/<file>`` resolves.

Restore order (first hit wins per filename):

  1. Copy from ``--media-src`` (rsync of an old VPS ``ecom_sites/data/media``)
  2. Copy from ``--brasty-root`` when the CDN filename stem matches a Brasty
     ``EAN.jpg`` (skip camera placeholders)
  3. HTTP GET the live CDN URL (``images.prinscosmetic.eu``, then the old
     ``images.slilverbelt.xyz`` host) while that host still serves the file

Shopify / BTS / oceanfragrances URLs stay as remote hotlinks — they do not need
to be on disk.

After files land, copy ``image_overrides.json`` onto the new VPS bind-mount,
recreate ``sillage-core`` / ``sillage-cron``, then:

  docker exec sillage-core bun run sync -- --mode=full --source=cache --rewrite-only
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import urllib.request
from collections import Counter
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from brasty_placeholders import file_is_brasty_placeholder  # noqa: E402

CDN_HOSTS = ("images.prinscosmetic.eu", "images.slilverbelt.xyz")


def cdn_filename(url: str) -> str | None:
    parsed = urlparse(url)
    host = (parsed.netloc or "").lower()
    if not any(host == h or host.endswith("." + h) for h in CDN_HOSTS):
        if "images.slilverbelt.xyz" not in url:
            return None
    name = os.path.basename(parsed.path)
    return name or None


def walk_brasty(root: str) -> dict[str, str]:
    """stem (filename without ext, as stored) and also normalized-digit stem → path."""
    index: dict[str, str] = {}
    if not root or not os.path.isdir(root):
        return index
    for dirpath, _, files in os.walk(root):
        for fn in files:
            stem, ext = os.path.splitext(fn)
            if ext.lower() not in {".jpg", ".jpeg", ".webp", ".png"}:
                continue
            disk = os.path.join(dirpath, fn)
            if file_is_brasty_placeholder(disk):
                continue
            index.setdefault(fn, disk)
            index.setdefault(stem + ".jpg", disk)
            digits = "".join(ch for ch in stem if ch.isdigit()).lstrip("0") or stem
            index.setdefault(digits + ".jpg", disk)
    return index


def download(url: str, dest: str, timeout: int = 30) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "sillage-image-restore/1"})
        with urllib.request.urlopen(req, timeout=timeout) as resp, open(dest, "wb") as out:
            shutil.copyfileobj(resp, out)
        return os.path.getsize(dest) > 0
    except OSError:
        return False


def write_manifest(overrides: dict[str, str], path: str) -> dict:
    by_host: Counter[str] = Counter()
    cdn_files: list[str] = []
    for url in overrides.values():
        host = urlparse(url).netloc.lower() or "(empty)"
        by_host[host] += 1
        fn = cdn_filename(url)
        if fn:
            cdn_files.append(fn)
    cdn_files = sorted(set(cdn_files))
    payload = {
        "override_keys": len(overrides),
        "by_host": dict(by_host.most_common()),
        "cdn_file_count": len(cdn_files),
        "cdn_files": cdn_files,
        "note": (
            "Binaries are not in git. Restore with restore_found_images.py onto "
            "ecom_sites/data/media/. Shopify/BTS/ocean URLs are hotlinked and do not "
            "need to be copied."
        ),
    }
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
    return payload


def main() -> int:
    ap = argparse.ArgumentParser(description="Restore CDN-hosted product photos onto a new VPS.")
    ap.add_argument(
        "--overrides",
        default=os.path.join(
            os.path.dirname(__file__), "..", "..", "sillage-core", "data", "image_overrides.json"
        ),
    )
    ap.add_argument("--dest", help="Target media directory (e.g. ~/ecom_sites/data/media)")
    ap.add_argument("--media-src", default="", help="Existing media tree to copy from (old VPS rsync)")
    ap.add_argument("--brasty-root", default="", help="Brasty dump root (filename stem = EAN)")
    ap.add_argument("--from-cdn", action="store_true", help="HTTP GET missing files from the live CDN")
    ap.add_argument("--write-manifest", default="", help="Write found-images-manifest.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with open(args.overrides, encoding="utf-8") as f:
        overrides = json.load(f)
    if not isinstance(overrides, dict):
        print("overrides file is not an object", file=sys.stderr)
        return 1

    if args.write_manifest:
        man = write_manifest(overrides, args.write_manifest)
        print(
            json.dumps(
                {k: man[k] for k in ("override_keys", "by_host", "cdn_file_count")},
                indent=2,
            )
        )

    needed: dict[str, str] = {}
    for url in overrides.values():
        fn = cdn_filename(url)
        if fn:
            needed[fn] = url

    if not args.dest:
        if args.write_manifest:
            return 0
        print("--dest is required unless only --write-manifest", file=sys.stderr)
        return 1

    dest = os.path.abspath(args.dest)
    if not args.dry_run:
        os.makedirs(dest, exist_ok=True)

    brasty = walk_brasty(args.brasty_root) if args.brasty_root else {}
    stats = Counter()
    missing: list[str] = []

    for fn, url in sorted(needed.items()):
        target = os.path.join(dest, fn)
        if os.path.isfile(target) and os.path.getsize(target) > 0:
            if file_is_brasty_placeholder(target):
                stats["placeholder_already_on_disk"] += 1
                if not args.dry_run:
                    os.remove(target)
            else:
                stats["already_present"] += 1
                continue

        src = None
        origin = None
        media_hit = os.path.join(args.media_src, fn) if args.media_src else ""
        if media_hit and os.path.isfile(media_hit) and not file_is_brasty_placeholder(media_hit):
            src, origin = media_hit, "media_src"
        elif fn in brasty:
            src, origin = brasty[fn], "brasty"

        if src:
            stats[f"copy_{origin}"] += 1
            if not args.dry_run:
                shutil.copy2(src, target)
            continue

        if args.from_cdn:
            stats["download_cdn"] += 1
            if args.dry_run:
                continue
            tmp = target + ".part"
            if download(url, tmp) and not file_is_brasty_placeholder(tmp):
                os.replace(tmp, target)
            else:
                if os.path.isfile(tmp):
                    os.remove(tmp)
                stats["download_failed"] += 1
                missing.append(fn)
            continue

        stats["missing"] += 1
        missing.append(fn)

    print(json.dumps(dict(stats), indent=2))
    print(f"cdn files needed: {len(needed)}")
    if missing:
        print(f"still missing {len(missing)} files (first 10): {missing[:10]}", file=sys.stderr)
        return 2 if not args.dry_run else 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
