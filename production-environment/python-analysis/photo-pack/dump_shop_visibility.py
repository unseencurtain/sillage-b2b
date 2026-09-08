#!/usr/bin/env python3
"""Dump published Woo products + visibility + thumbs from the LIVE MariaDB.

Must run on ovhe (uses docker exec ecom-db). Output is tab-separated, 16 columns,
consumed by build_inventory.py.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SQL = r"""
SELECT
  p.wp_post_id,
  COALESCE(p.slug, ''),
  p.sku,
  v.slug,
  COALESCE(o.brand, ''),
  REPLACE(REPLACE(REPLACE(COALESCE(o.name, ''), '\t', ' '), '\n', ' '), '\r', ' '),
  COALESCE(o.primary_ean, ''),
  COALESCE(o.eans, ''),
  o.stock,
  COALESCE(o.image_url, ''),
  COALESCE(thumb.meta_value, ''),
  COALESCE(p.operator_hidden, 0),
  COALESCE(p.identity_key, ''),
  IF(cat.object_id IS NULL, 0, 1),
  IF(oos.object_id IS NULL, 0, 1),
  IF(srch.object_id IS NULL, 0, 1)
FROM sillage.sil_products p
JOIN sillage.sil_offers o ON o.id = p.primary_offer_id
JOIN sillage.sil_vendors v ON v.id = o.vendor_id
JOIN earth.wp_posts wp
  ON wp.ID = p.wp_post_id AND wp.post_type = 'product' AND wp.post_status = 'publish'
LEFT JOIN earth.wp_postmeta thumb
  ON thumb.post_id = p.wp_post_id AND thumb.meta_key = '_external_thumbnail_url'
LEFT JOIN (
  SELECT tr.object_id
    FROM earth.wp_term_relationships tr
    JOIN earth.wp_term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
    JOIN earth.wp_terms t ON t.term_id = tt.term_id
   WHERE tt.taxonomy = 'product_visibility' AND t.slug = 'exclude-from-catalog'
) cat ON cat.object_id = p.wp_post_id
LEFT JOIN (
  SELECT tr.object_id
    FROM earth.wp_term_relationships tr
    JOIN earth.wp_term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
    JOIN earth.wp_terms t ON t.term_id = tt.term_id
   WHERE tt.taxonomy = 'product_visibility' AND t.slug = 'outofstock'
) oos ON oos.object_id = p.wp_post_id
LEFT JOIN (
  SELECT tr.object_id
    FROM earth.wp_term_relationships tr
    JOIN earth.wp_term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
    JOIN earth.wp_terms t ON t.term_id = tt.term_id
   WHERE tt.taxonomy = 'product_visibility' AND t.slug = 'exclude-from-search'
) srch ON srch.object_id = p.wp_post_id
"""


def mysql_root_pwd() -> str:
    return subprocess.check_output(
        ["bash", "-lc", "grep ^MYSQL_ROOT_PWD= ~/sillage/.env | cut -d= -f2-"],
        text=True,
    ).rstrip("\n")


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "/home/ubuntu/photo-inventory/indexes/shop-visibility.tsv")
    out.parent.mkdir(parents=True, exist_ok=True)
    pw = mysql_root_pwd()
    data = subprocess.check_output(
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
            SQL,
        ]
    )
    out.write_bytes(data)
    lines = data.count(b"\n")
    print(f"wrote {out} ({lines} rows)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
