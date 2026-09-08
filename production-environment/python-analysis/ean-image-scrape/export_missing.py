#!/usr/bin/env python3
"""Export shop products that have a barcode and no usable photo.

Never includes a row whose primary EAN / extra EANs are all empty or dummy.
Run on the VPS (uses docker exec ecom-db).
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from barcodes import is_real_barcode, normalize_ean  # noqa: E402

SQL = r"""
SELECT
  p.sku,
  o.name,
  COALESCE(o.brand, '') AS brand,
  v.slug AS vendor,
  o.vendor_product_id,
  COALESCE(o.primary_ean, '') AS primary_ean,
  o.eans,
  p.wp_post_id,
  COALESCE(p.slug, '') AS slug,
  o.stock,
  COALESCE(o.image_url, '') AS vendor_image_url,
  p.identity_key
FROM sillage.sil_products p
JOIN sillage.sil_offers o ON o.id = p.primary_offer_id
JOIN sillage.sil_vendors v ON v.id = o.vendor_id
LEFT JOIN earth.wp_postmeta m
  ON m.post_id = p.wp_post_id AND m.meta_key = '_external_thumbnail_url'
WHERE p.wp_post_id IS NOT NULL
  AND (m.meta_value IS NULL OR m.meta_value = ''
       OR m.meta_value IN ('None','null')
       OR m.meta_value NOT LIKE 'http%')
ORDER BY v.slug, o.brand, o.name
"""

FIELDS = [
    "sku",
    "name",
    "brand",
    "vendor",
    "vendor_product_id",
    "primary_ean",
    "extra_eans",
    "lookup_ean",
    "wp_post_id",
    "slug",
    "stock",
    "vendor_image_url",
    "identity_key",
]


def mysql_tsv(sql: str) -> str:
    pw = subprocess.check_output(
        ["bash", "-lc", "grep ^MYSQL_ROOT_PWD= ~/sillage/.env | cut -d= -f2-"],
        text=True,
    ).rstrip("\n")
    return subprocess.check_output(
        [
            "docker",
            "exec",
            "-e",
            f"MYSQL_PWD={pw}",
            "ecom-db",
            "mariadb",
            "-uroot",
            "-N",
            "--batch",
            "-e",
            sql,
        ],
        text=True,
    )


def extra_eans(raw: str, primary: str) -> list[str]:
    out: list[str] = []
    if not raw:
        return out
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = [part.strip() for part in raw.replace(";", ",").split(",")]
    if not isinstance(parsed, list):
        return out
    prim = normalize_ean(primary)
    for item in parsed:
        n = normalize_ean(item)
        if n and n != prim and n not in out:
            out.append(n)
    return out


def pick_lookup(primary: str, extras: list[str]) -> str | None:
    if is_real_barcode(primary):
        return digits_keep(primary)
    for ean in extras:
        if is_real_barcode(ean):
            return ean
    return None


def digits_keep(raw: str) -> str:
    return "".join(ch for ch in str(raw) if ch.isdigit())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out-dir", default=os.path.expanduser("~/sillage/ean-image-scrape"))
    args = ap.parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    rows_out: list[dict[str, str]] = []
    skipped_no_barcode = 0
    for line in mysql_tsv(SQL).splitlines():
        parts = line.split("\t")
        if len(parts) < 12:
            continue
        (
            sku,
            name,
            brand,
            vendor,
            vendor_product_id,
            primary_ean,
            eans_raw,
            wp_post_id,
            slug,
            stock,
            vendor_image_url,
            identity_key,
        ) = parts[:12]
        extras = extra_eans(eans_raw, primary_ean)
        lookup = pick_lookup(primary_ean, extras)
        if not lookup:
            skipped_no_barcode += 1
            continue
        rows_out.append(
            {
                "sku": sku,
                "name": name,
                "brand": brand,
                "vendor": vendor,
                "vendor_product_id": vendor_product_id,
                "primary_ean": primary_ean,
                "extra_eans": ";".join(extras),
                "lookup_ean": lookup,
                "wp_post_id": wp_post_id,
                "slug": slug,
                "stock": stock,
                "vendor_image_url": vendor_image_url,
                "identity_key": identity_key,
            }
        )

    csv_path = out_dir / "missing-products.csv"
    json_path = out_dir / "missing-products.json"
    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows_out)
    json_path.write_text(json.dumps(rows_out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    unique = {r["lookup_ean"] for r in rows_out}
    summary = {
        "missing_with_barcode": len(rows_out),
        "unique_lookup_eans": len(unique),
        "skipped_no_barcode": skipped_no_barcode,
        "csv": str(csv_path),
        "json": str(json_path),
    }
    (out_dir / "export-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
