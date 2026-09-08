#!/usr/bin/env python3
"""Export the products the shop hides because it has no photo to print.

Run on the VPS, from anywhere. It reads the stack it lives in, so the path you invoke picks the
shop — no database names to remember, and no way to point retail's script at wholesale's data:

    python3 ~/sillage/scripts/export-missing-images.py             # → ~/missing-images-retail.csv
    python3 ~/sillage-wholesale/scripts/export-missing-images.py   # → ~/missing-images-wholesale.csv
    OUT=/tmp/x.csv python3 ~/sillage/scripts/export-missing-images.py

These are the products worth hunting an image for: each one is already priced and structured, and
the only thing keeping it out of the catalogue is the picture. Find a photo, add it to
`image_overrides.json` keyed by EAN, and the next sync publishes the product.

Selection is `_external_thumbnail_url` being empty, which is the writer's own verdict rather than a
guess: a vendor's raw `image_url` is frequently a placeholder or a weak BeautyFort `/pic/` thumb,
and the writer clears the meta when the image it resolved is unusable. So this matches the
`hiddenNoImage` figure a sync run reports, exactly.

Sorted by stock, descending, because that is the order of payoff. A product with stock is hidden
*only* for the photo, so an image publishes it immediately. A product at zero stock stays hidden on
the stock rule even with a perfect photo, so those rows sit at the bottom — still worth collecting,
just not worth doing first.
"""
from __future__ import annotations

import csv
import json
import os
import subprocess
import sys
from pathlib import Path

# The stack directory is the script's own parent, so `~/sillage-wholesale/scripts/…` reads the
# wholesale .env and nothing else needs saying on the command line.
STACK_DIR = Path(os.environ.get("STACK_DIR", Path(__file__).resolve().parent.parent))
LABEL = os.environ.get("LABEL") or ("retail" if STACK_DIR.name == "sillage" else "wholesale")
OUT = Path(os.environ.get("OUT", os.path.expanduser(f"~/missing-images-{LABEL}.csv")))


def env() -> dict[str, str]:
    """Read the stack's .env. These names differ per shop (earth/sillage vs earth_wpf/sillage_wpf)."""
    path = STACK_DIR / ".env"
    if not path.is_file():
        sys.exit(f"no .env in {STACK_DIR} — run the copy of this script inside a stack directory")
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip("'\"")
    missing = [k for k in ("MYSQL_ROOT_PWD", "WORDPRESS_DB", "SILLAGE_DB", "DB_HOST") if not values.get(k)]
    if missing:
        sys.exit(f"{path} is missing {', '.join(missing)}")
    return values


# One JSON object per row, not tab-separated columns.
#
# `mariadb --batch` escapes tabs and newlines in values but *not* carriage returns, and two product
# titles on the live shop contain one. Those rows split across two lines and were silently dropped,
# so the export quietly held 12,001 of 12,003 products. Splitting on a delimiter that can appear in
# the data is the bug; JSON_OBJECT escapes every control character, so a row is always exactly one
# line. `--raw` then stops the client adding a second layer of escaping over the JSON's own.
#
# `sil_offers.primary_ean` is the identity we key overrides on. `eans` is a JSON array holding the
# rest, which is the fallback when a vendor sends the barcode only in the list.
def sql(wpdb: str, sildb: str) -> str:
    return f"""
SELECT JSON_OBJECT(
  'ean',       IFNULL(NULLIF(o.primary_ean, ''), ''),
  'eans_json', o.eans,
  'name',      p.post_title,
  'brand',     IFNULL(o.brand, ''),
  'price',     IFNULL(price.meta_value, o.vendor_price),
  'stock',     IFNULL(stock.meta_value, o.stock),
  'vendor',    v.slug,
  'sku',       IFNULL(o.sku, '')
)
FROM {wpdb}.wp_posts p
JOIN {sildb}.sil_products sp ON sp.wp_post_id = p.ID
JOIN {sildb}.sil_offers  o  ON o.id = sp.primary_offer_id
JOIN {sildb}.sil_vendors v  ON v.id = o.vendor_id
LEFT JOIN {wpdb}.wp_postmeta thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_external_thumbnail_url'
LEFT JOIN {wpdb}.wp_postmeta price ON price.post_id = p.ID AND price.meta_key = '_price'
LEFT JOIN {wpdb}.wp_postmeta stock ON stock.post_id = p.ID AND stock.meta_key = '_stock'
WHERE p.post_type = 'product'
  AND p.post_status = 'publish'
  AND IFNULL(sp.operator_hidden, 0) = 0
  AND (thumb.meta_value IS NULL OR TRIM(thumb.meta_value) = '')
ORDER BY CAST(IFNULL(stock.meta_value, o.stock) AS SIGNED) DESC, p.post_title
"""


def rows() -> list[dict]:
    conf = env()
    out = subprocess.check_output(
        ["docker", "exec", "-e", f"MYSQL_PWD={conf['MYSQL_ROOT_PWD']}", conf["DB_HOST"],
         "mariadb", "-uroot", "-N", "--batch", "--raw",
         "-e", sql(conf["WORDPRESS_DB"], conf["SILLAGE_DB"])],
        text=True,
    )
    parsed = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        # Never skip quietly: a row we cannot read is a product that silently stays hidden.
        try:
            parsed.append(json.loads(line))
        except ValueError:
            print(f"unparseable row, aborting rather than exporting a short file: {line[:160]}",
                  file=sys.stderr)
            raise
    return parsed


def clean(value) -> str:
    """Flatten to a single-line cell. NULL and JSON null both become empty."""
    if value is None:
        return ""
    return " ".join(str(value).split())


def pick_ean(row: dict) -> str:
    direct = clean(row.get("ean"))
    if direct:
        return direct
    try:
        listed = json.loads(row.get("eans_json") or "[]")
    except (ValueError, TypeError):
        return ""
    for candidate in listed if isinstance(listed, list) else []:
        text = str(candidate).strip().lstrip("'")
        if text.isdigit() and text.strip("0"):
            return text
    return ""


def as_int(value) -> int:
    try:
        return int(float(clean(value) or 0))
    except ValueError:
        return 0


def main() -> int:
    data = rows()
    expected = int(os.environ.get("EXPECT_ROWS", "0"))
    if expected and len(data) != expected:
        print(f"expected {expected} rows, read {len(data)}", file=sys.stderr)
        return 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["ean", "name", "brand", "price", "stock", "vendor", "sku"])
        for row in data:
            writer.writerow([
                pick_ean(row),
                clean(row.get("name")),
                clean(row.get("brand")),
                clean(row.get("price")),
                as_int(row.get("stock")),
                clean(row.get("vendor")),
                clean(row.get("sku")),
            ])

    in_stock = sum(1 for r in data if as_int(r.get("stock")) > 0)
    no_ean = sum(1 for r in data if not pick_ean(r))
    print(f"wrote {len(data)} products with no shop photo → {OUT}")
    print(f"  {in_stock} are in stock — an image publishes these immediately")
    print(f"  {len(data) - in_stock} are also out of stock — an image alone will not unhide them")
    if no_ean:
        print(f"  {no_ean} have no EAN — these cannot be keyed in image_overrides.json by barcode")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
