#!/usr/bin/env python3
"""Zip scraped photos for inspection.

By default this does **not** write the shop, CDN, or image_overrides.json.
Pass --apply-to-shop only after someone has inspected ~/sillage/ean-image-scrape/scraped/.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from barcodes import normalize_ean  # noqa: E402

CDN = "https://images.prinscosmetic.eu"


def load_overrides(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def product_eans(row: dict[str, str]) -> list[str]:
    out: list[str] = []
    for raw in [row.get("primary_ean"), row.get("lookup_ean"), *(row.get("extra_eans") or "").split(";")]:
        n = normalize_ean(raw)
        if n and n not in out:
            out.append(n)
    return out


def mark_dirty(eans: list[str]) -> None:
    if not eans:
        return
    pw = subprocess.check_output(
        ["bash", "-lc", "grep ^MYSQL_ROOT_PWD= ~/sillage/.env | cut -d= -f2-"],
        text=True,
    ).rstrip("\n")
    # Chunk so the IN list stays small on a 4 GB box.
    for i in range(0, len(eans), 400):
        chunk = eans[i : i + 400]
        in_list = ",".join("'" + e.replace("'", "") + "'" for e in chunk)
        sql = f"""
        UPDATE sillage.sil_products p
          JOIN sillage.sil_offers o ON o.id = p.primary_offer_id
           SET p.needs_content_write = 1, p.needs_price_write = 1
         WHERE o.primary_ean IN ({in_list})
            OR TRIM(LEADING '0' FROM o.primary_ean) IN ({in_list});
        """
        subprocess.check_call(
            [
                "docker",
                "exec",
                "-e",
                f"MYSQL_PWD={pw}",
                "ecom-db",
                "mariadb",
                "-uroot",
                "-e",
                sql,
            ]
        )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--work-dir", default=os.path.expanduser("~/sillage/ean-image-scrape"))
    ap.add_argument("--media", default=os.path.expanduser("~/ecom_sites/data/media"))
    ap.add_argument(
        "--overrides",
        default=os.path.expanduser("~/sillage/sillage-core/data/image_overrides.json"),
    )
    ap.add_argument("--rewrite", action="store_true", help="recreate core/cron and run rewrite-only")
    ap.add_argument(
        "--apply-to-shop",
        action="store_true",
        help="write CDN + overrides (off by default — inspect scraped/ first)",
    )
    args = ap.parse_args()

    work = Path(args.work_dir)
    scraped = work / "scraped"
    media = Path(args.media)
    overrides_path = Path(args.overrides)
    reports = work / "reports"
    reports.mkdir(exist_ok=True)

    files = {
        normalize_ean(p.stem): p
        for p in scraped.iterdir()
        if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    }
    files = {k: v for k, v in files.items() if k}

    zip_path = work / "scraped-ean-images.zip"
    if files:
        subprocess.check_call(["zip", "-qr", str(zip_path), "scraped"], cwd=str(work))

    if not args.apply_to_shop:
        print(
            json.dumps(
                {
                    "mode": "inspect-only",
                    "scraped_files": len(files),
                    "zip": str(zip_path),
                    "shop_updated": False,
                },
                indent=2,
            )
        )
        return 0

    media.mkdir(parents=True, exist_ok=True)

    products: list[dict[str, str]] = []
    with (work / "missing-products.csv").open(encoding="utf-8") as fh:
        products = list(csv.DictReader(fh))

    overrides = load_overrides(overrides_path)
    added = 0
    copied = 0
    dirty_eans: list[str] = []
    applied: list[dict[str, str]] = []

    for row in products:
        keys = product_eans(row)
        hit = next((files[k] for k in keys if k in files), None)
        if not hit:
            lookup = normalize_ean(row.get("lookup_ean"))
            hit = files.get(lookup) if lookup else None
        if not hit:
            continue
        dest = media / hit.name
        if not dest.exists() or dest.stat().st_size != hit.stat().st_size:
            shutil.copy2(hit, dest)
            copied += 1
        url = f"{CDN}/{hit.name}"
        changed = False
        for key in keys:
            if key not in overrides or not overrides[key]:
                overrides[key] = url
                added += 1
                changed = True
        if changed:
            dirty_eans.extend(keys)
            applied.append(
                {
                    "sku": row.get("sku", ""),
                    "lookup_ean": row.get("lookup_ean", ""),
                    "filename": hit.name,
                    "url": url,
                }
            )

    overrides_path.write_text(json.dumps(overrides, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (work / "reports").mkdir(exist_ok=True)
    (work / "reports" / "applied.json").write_text(json.dumps(applied, indent=2) + "\n")

    mark_dirty(sorted(set(dirty_eans)))

    if args.rewrite:
        subprocess.check_call(
            [
                "bash",
                "-lc",
                "cd ~/sillage && docker compose --env-file .env up -d --force-recreate sillage-core sillage-cron",
            ]
        )
        subprocess.check_call(
            [
                "docker",
                "exec",
                "sillage-core",
                "bun",
                "run",
                "sync",
                "--",
                "--mode=full",
                "--source=cache",
                "--rewrite-only",
            ]
        )

    zip_path = work / "scraped-ean-images.zip"
    if files:
        subprocess.check_call(["zip", "-qr", str(zip_path), "scraped"], cwd=str(work))

    summary = {
        "scraped_files": len(files),
        "copied_to_media": copied,
        "override_keys_added": added,
        "products_applied": len(applied),
        "zip": str(zip_path) if zip_path.exists() else None,
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
