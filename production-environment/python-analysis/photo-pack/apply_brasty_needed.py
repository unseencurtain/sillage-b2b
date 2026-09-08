#!/usr/bin/env python3
"""Copy Brasty files needed for missing shop photos into the CDN, then we delete ~/brasty.

Does not touch products that already have a usable Woo thumb.
Does not apply the EAN scrape (unreviewed). Skips camera placeholders.
Must run on ovhe.
"""
from __future__ import annotations

import csv
import json
import shutil
import subprocess
import sys
from pathlib import Path

MEDIA = Path("/home/ubuntu/ecom_sites/data/media")
OVERRIDES = Path("/home/ubuntu/sillage/sillage-core/data/image_overrides.json")
LISTS = Path("/home/ubuntu/photo-inventory/lists/03-missing-photo-ALL.csv")
PUBLIC = "https://images.prinscosmetic.eu"
REPORT = Path("/home/ubuntu/photo-inventory/brasty-applied.json")


def mysql_root_pwd() -> str:
    return subprocess.check_output(
        ["bash", "-lc", "grep ^MYSQL_ROOT_PWD= ~/sillage/.env | cut -d= -f2-"],
        text=True,
    ).rstrip("\n")


def main() -> int:
    if not LISTS.is_file():
        raise SystemExit(f"missing {LISTS} — run run_on_vps.sh first")
    MEDIA.mkdir(parents=True, exist_ok=True)
    raw = json.loads(OVERRIDES.read_text(encoding="utf-8"))
    overrides = dict(raw) if isinstance(raw, dict) else {}
    bak = OVERRIDES.with_suffix(".json.bak-brasty-apply")
    if not bak.exists():
        shutil.copy2(OVERRIDES, bak)

    copied = 0
    skipped_exists = 0
    new_keys = 0
    post_ids: list[int] = []
    rows_out: list[dict[str, str]] = []

    with LISTS.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            src = (row.get("brasty_file") or "").strip()
            if not src:
                continue
            if (row.get("best_image_origin") or "") == "brasty_camera_placeholder_not_a_photo":
                continue
            path = Path(src)
            if not path.is_file():
                print(f"missing on disk: {src}", file=sys.stderr)
                continue
            dest_name = path.name
            dest = MEDIA / dest_name
            if dest.exists():
                skipped_exists += 1
            else:
                shutil.copy2(path, dest)
                dest.chmod(dest.stat().st_mode | 0o044)
                copied += 1
            url = f"{PUBLIC}/{dest_name}"
            ean = (row.get("ean") or "").strip()
            if ean and ean not in overrides:
                overrides[ean] = url
                new_keys += 1
            try:
                post_ids.append(int(row["wp_post_id"]))
            except (KeyError, ValueError, TypeError):
                pass
            rows_out.append(
                {
                    "sku": row.get("sku") or "",
                    "ean": ean,
                    "in_stock": row.get("in_stock") or "",
                    "cdn_file": dest_name,
                    "url": url,
                }
            )

    OVERRIDES.write_text(json.dumps(overrides, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if post_ids:
        ids = ",".join(str(i) for i in sorted(set(post_ids)))
        pw = mysql_root_pwd()
        sql = (
            "UPDATE sillage.sil_products "
            "SET needs_content_write = 1, needs_price_write = 1, last_error = NULL "
            f"WHERE wp_post_id IN ({ids})"
        )
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

    report = {
        "copied_to_media": copied,
        "already_in_media": skipped_exists,
        "new_override_keys": new_keys,
        "products_marked_dirty": len(set(post_ids)),
        "products": rows_out,
        "note": (
            "Brasty overlapped almost none of the missing-shop-photo SKUs. "
            "The rest of the gaps are in ~/sillage/ean-image-scrape/scraped (not applied)."
        ),
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: report[k] for k in report if k != "products"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
