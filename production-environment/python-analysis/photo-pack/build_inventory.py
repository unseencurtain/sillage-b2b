#!/usr/bin/env python3
"""Build the downloadable photo-inventory folder from a live TSV + local indexes.

Matches Overview cards:
  hidden no/weak image = catalog-hidden AND not outofstock  (~9,775)
  hidden stock         = catalog-hidden AND outofstock      (~18,753)
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "ean-image-scrape"))

from barcodes import is_real_barcode, normalize_ean  # noqa: E402
from image_rules import is_unusable_image, source_kind  # noqa: E402

FIELDS = [
    "sku",
    "name",
    "brand",
    "vendor",
    "ean",
    "all_eans",
    "stock",
    "in_stock",
    "shop_visibility",
    "catalog_hidden",
    "out_of_stock",
    "operator_hidden",
    "has_usable_shop_photo",
    "woo_thumb",
    "woo_kind",
    "vendor_image",
    "override_url",
    "override_kind",
    "cdn_file",
    "scraped_file",
    "brasty_file",
    "best_image_url",
    "best_image_origin",
    "fill_verdict",
    "we_have_a_file_or_url_unused",
    "wp_post_id",
    "slug",
    "identity_key",
]


def index_files(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        ean = normalize_ean(Path(line).stem)
        if ean:
            out.setdefault(ean, line)
    return out


def load_overrides(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, str] = {}
    if not isinstance(raw, dict):
        return out
    for k, v in raw.items():
        url = v if isinstance(v, str) else ""
        ean = normalize_ean(str(k))
        if ean and url and not is_unusable_image(url):
            out.setdefault(ean, url.strip())
    return out


def extra_eans(raw: str, primary: str) -> list[str]:
    out: list[str] = []
    prim = normalize_ean(primary)
    if not raw:
        return out
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = [part.strip() for part in raw.replace(";", ",").split(",")]
    if not isinstance(parsed, list):
        return out
    for item in parsed:
        n = normalize_ean(item)
        if n and n != prim and n not in out:
            out.append(n)
    return out


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tsv", required=True)
    ap.add_argument("--inventory", default="/workspace/tmp-image-inventory")
    ap.add_argument("--out", default="/workspace/photo-inventory")
    ap.add_argument("--snapshot", default=str(HERE / "snapshot"))
    args = ap.parse_args()

    inv = Path(args.inventory)
    overrides = load_overrides(inv / "image_overrides.json")
    cdn = index_files(inv / "cdn-files.txt")
    scraped = index_files(inv / "scraped-files.txt")
    brasty_all = index_files(inv / "brasty-files.txt")
    brasty = index_files(inv / "brasty-real.txt") if (inv / "brasty-real.txt").exists() else brasty_all
    brasty_fake = index_files(inv / "brasty-placeholders.txt")

    rows: list[dict[str, str]] = []
    with Path(args.tsv).open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 16:
                continue
            (
                wp_id,
                slug,
                sku,
                vendor,
                brand,
                name,
                ean_raw,
                eans_raw,
                stock,
                vendor_img,
                woo,
                operator_hidden,
                identity,
                catalog_hidden,
                out_of_stock,
                search_hidden,
            ) = parts[:16]
            extras = extra_eans(eans_raw, ean_raw)
            eans: list[str] = []
            n = normalize_ean(ean_raw)
            if n:
                eans.append(n)
            for e in extras:
                if e not in eans:
                    eans.append(e)
            lookup = next((e for e in eans if is_real_barcode(e)), eans[0] if eans else "")
            usable = not is_unusable_image(woo)
            have_cdn = any(e in cdn for e in eans)
            have_scraped = any(e in scraped for e in eans)
            have_brasty = any(e in brasty for e in eans)
            have_brasty_placeholder_only = (not have_brasty) and any(e in brasty_fake for e in eans)
            have_override = any(e in overrides for e in eans)
            override_url = next((overrides[e] for e in eans if e in overrides), "")
            cdn_file = next((Path(cdn[e]).name for e in eans if e in cdn), "")
            scraped_file = next((Path(scraped[e]).name for e in eans if e in scraped), "")
            brasty_file = next((brasty[e] for e in eans if e in brasty), "")

            if usable:
                best_url, best_origin = woo.strip(), "shop_woo_thumb"
            elif override_url:
                best_url, best_origin = override_url, "override_not_on_shop"
            elif have_cdn:
                best_url, best_origin = f"https://images.prinscosmetic.eu/{cdn_file}", "cdn_file_not_on_shop"
            elif have_scraped:
                best_url, best_origin = "", "scraped_unapplied"
            elif have_brasty:
                best_url, best_origin = "", "brasty_dump_unapplied"
            elif vendor_img and not is_unusable_image(vendor_img):
                best_url, best_origin = vendor_img.strip(), "vendor_feed_not_on_shop"
            elif have_brasty_placeholder_only:
                best_url, best_origin = "", "brasty_camera_placeholder_not_a_photo"
            else:
                best_url, best_origin = "", "none"

            cat = catalog_hidden == "1"
            oos = out_of_stock == "1"
            if operator_hidden == "1":
                vis = "hidden_operator"
            elif cat and not oos:
                vis = "hidden_no_image"  # Overview card
            elif cat and oos:
                vis = "hidden_stock"  # Overview card
            elif not cat:
                vis = "visible"
            else:
                vis = "hidden_other"

            unused = (not usable) and (
                have_override or have_cdn or have_scraped or have_brasty
                or (vendor_img and not is_unusable_image(vendor_img))
            )
            can_fill = "CAN" if unused else ("ALREADY_ON_SHOP" if usable else "CANNOT")
            try:
                stock_n = float(stock)
            except ValueError:
                stock_n = 0.0

            rows.append(
                {
                    "sku": sku,
                    "name": name,
                    "brand": brand,
                    "vendor": vendor,
                    "ean": lookup or ean_raw,
                    "all_eans": ";".join(eans),
                    "stock": stock,
                    "in_stock": "1" if stock_n > 0 and not oos else "0",
                    "shop_visibility": vis,
                    "catalog_hidden": catalog_hidden,
                    "out_of_stock": out_of_stock,
                    "operator_hidden": operator_hidden,
                    "has_usable_shop_photo": "1" if usable else "0",
                    "woo_thumb": woo,
                    "woo_kind": source_kind(woo) if woo else "none",
                    "vendor_image": vendor_img,
                    "override_url": override_url,
                    "override_kind": source_kind(override_url) if override_url else "",
                    "cdn_file": cdn_file,
                    "scraped_file": scraped_file,
                    "brasty_file": brasty_file,
                    "best_image_url": best_url,
                    "best_image_origin": best_origin,
                    "fill_verdict": can_fill,
                    "we_have_a_file_or_url_unused": "1" if unused else "0",
                    "wp_post_id": wp_id,
                    "slug": slug,
                    "identity_key": identity,
                }
            )

    hidden_no_image = [r for r in rows if r["shop_visibility"] == "hidden_no_image"]
    hidden_stock = [r for r in rows if r["shop_visibility"] == "hidden_stock"]
    visible = [r for r in rows if r["shop_visibility"] == "visible"]
    missing_any = [r for r in rows if r["has_usable_shop_photo"] == "0"]
    missing_in_stock = [r for r in missing_any if r["out_of_stock"] == "0"]
    missing_oos = [r for r in missing_any if r["out_of_stock"] == "1"]
    oos_with_photo = [r for r in hidden_stock if r["has_usable_shop_photo"] == "1"]
    oos_no_photo = [r for r in hidden_stock if r["has_usable_shop_photo"] == "0"]
    unused_ready = [r for r in hidden_no_image if r["fill_verdict"] == "CAN"]
    no_bytes = [r for r in hidden_no_image if r["fill_verdict"] == "CANNOT"]
    can_all_missing = [r for r in missing_any if r["fill_verdict"] == "CAN"]
    cannot_all_missing = [r for r in missing_any if r["fill_verdict"] == "CANNOT"]

    out = Path(args.out)
    lists = out / "lists"
    write_csv(lists / "all-products.csv", rows)
    write_csv(lists / "01-hidden-no-or-weak-image-IN-STOCK.csv", hidden_no_image)
    write_csv(lists / "02-missing-photo-OUT-OF-STOCK.csv", missing_oos)
    write_csv(lists / "03-missing-photo-ALL.csv", missing_any)
    write_csv(lists / "04-out-of-stock-WITH-photo.csv", oos_with_photo)
    write_csv(lists / "05-out-of-stock-NO-photo.csv", oos_no_photo)
    write_csv(lists / "06-hidden-no-image-we-already-have-a-file.csv", unused_ready)
    write_csv(lists / "07-hidden-no-image-no-file-anywhere.csv", no_bytes)
    write_csv(lists / "08-visible-in-shop.csv", visible)
    write_csv(lists / "CAN-FILL.csv", can_all_missing)
    write_csv(lists / "CANNOT-FILL.csv", cannot_all_missing)
    write_csv(lists / "CAN-FILL-in-stock-hidden-no-image.csv", unused_ready)
    write_csv(lists / "CANNOT-FILL-in-stock-hidden-no-image.csv", no_bytes)

    origin = Counter(r["best_image_origin"] for r in rows)
    woo_kind = Counter(r["woo_kind"] for r in rows)
    captured = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    counts = {
        "captured_at": captured,
        "matches_overview": {
            "visible_in_shop": len(visible),
            "published": len(rows),
            "hidden_from_catalog": len(hidden_no_image) + len(hidden_stock)
            + len([r for r in rows if r["shop_visibility"] in {"hidden_operator", "hidden_other"} and r["catalog_hidden"] == "1"]),
            "hidden_no_or_weak_image_in_stock": len(hidden_no_image),
            "hidden_stock_threshold": len(hidden_stock),
        },
        "usable_shop_photo": {
            "yes": sum(1 for r in rows if r["has_usable_shop_photo"] == "1"),
            "no": len(missing_any),
            "no_and_in_stock": len(missing_in_stock),
            "no_and_out_of_stock": len(missing_oos),
        },
        "of_the_9775_style_card": {
            "total": len(hidden_no_image),
            "we_already_have_unused_file_or_url": len(unused_ready),
            "no_file_anywhere": len(no_bytes),
        },
        "out_of_stock_hidden": {
            "total": len(hidden_stock),
            "already_have_shop_photo": len(oos_with_photo),
            "no_usable_shop_photo": len(oos_no_photo),
        },
        "can_vs_cannot": {
            "CAN_fill_any_missing_sku": len(can_all_missing),
            "CANNOT_fill_any_missing_sku": len(cannot_all_missing),
            "CAN_fill_overview_no_image_in_stock": len(unused_ready),
            "CANNOT_fill_overview_no_image_in_stock": len(no_bytes),
            "sources": [
                "our CDN ~/ecom_sites/data/media",
                "image_overrides.json (Shopify / BTS / ocean / our CDN URLs)",
                "ean-image-scrape/scraped (UNREVIEWED)",
                "brasty dump real photos only (camera placeholders excluded: 1269 files)",
            ],
            "not_a_source": "wholesale export.csv (EANs only, no image URLs). BeautyFort /pic/ thumbs are weak, not photos.",
        },
        "woo_thumb_kind": dict(woo_kind),
        "note": (
            "Overview 'Hidden · no/weak image' = exclude-from-catalog AND NOT outofstock. "
            "Overview 'Hidden · stock' = exclude-from-catalog AND outofstock. "
            "A product with no photo AND stock 0 is counted on the stock card, not the image card. "
            "That is why file 02 exists."
        ),
    }
    (out / "COUNTS.json").write_text(json.dumps(counts, indent=2) + "\n", encoding="utf-8")

    readme = f"""# Photo inventory — {captured}

Home folder on the VPS is **`brasty/`** (not `resty`). 36,044 files; **1,269** are the grey camera placeholder (not a product photo) and are excluded.

The wholesale `export.csv` has **11,013 EANs and no image URLs**. It does not add photos.

## One last list: can we put a photo on it?

| Verdict | All SKUs missing a shop photo | Of those, the Overview **no/weak image in-stock** card |
|---|---|---|
| **CAN fill** (we already have a real file or URL, not applied) | **{len(can_all_missing):,}** | **{len(unused_ready):,}** |
| **CANNOT fill** (no CDN, override, scrape, or real Brasty file) | **{len(cannot_all_missing):,}** | **{len(no_bytes):,}** |

Open these first:

- `lists/CAN-FILL.csv` — we can attach a photo (inspect scrape/Brasty first)
- `lists/CANNOT-FILL.csv` — no photo exists in any source we have
- `lists/CAN-FILL-in-stock-hidden-no-image.csv` — the Overview **9,775-style** card that we **can** fill
- `lists/CANNOT-FILL-in-stock-hidden-no-image.csv` — same card, nothing to attach

`fill_verdict` is `CAN` / `CANNOT` / `ALREADY_ON_SHOP`. `best_image_origin` says where the file would come from.

## Overview cards (same SQL as the dashboard)

| Card | Count |
|---|---|
| Visible in shop | {len(visible):,} |
| Published in WP | {len(rows):,} |
| **Hidden · no/weak image** (in stock) | **{len(hidden_no_image):,}** |
| Hidden · stock threshold | {len(hidden_stock):,} |

Out of stock is a **separate** list (`02` / `04` / `05`). A SKU with no photo **and** stock 0 is on the stock card in Overview, not the image card.

## Other files

| File | What |
|---|---|
| `01-hidden-no-or-weak-image-IN-STOCK.csv` | Overview image card (in stock, catalog-hidden) |
| `02-missing-photo-OUT-OF-STOCK.csv` | No usable photo, out of stock |
| `03-missing-photo-ALL.csv` | Every published SKU with no usable shop photo |
| `04-out-of-stock-WITH-photo.csv` | Hidden for stock, already has a photo |
| `05-out-of-stock-NO-photo.csv` | Hidden for stock, no photo |
| `all-products.csv` | Every published product: name, EAN, stock, every image source |

Do **not** apply `scraped/` or Brasty to the shop until inspected. Hide-without-image stays on.
"""
    (out / "README.md").write_text(readme, encoding="utf-8")

    snap = Path(args.snapshot)
    snap.mkdir(parents=True, exist_ok=True)
    (snap / "COUNTS.json").write_text(json.dumps(counts, indent=2) + "\n", encoding="utf-8")
    (snap / "README.md").write_text(readme, encoding="utf-8")
    write_csv(snap / "01-hidden-no-or-weak-image-IN-STOCK.csv", hidden_no_image)
    write_csv(snap / "02-missing-photo-OUT-OF-STOCK.csv", missing_oos)
    write_csv(snap / "CAN-FILL.csv", can_all_missing)
    write_csv(snap / "CANNOT-FILL.csv", cannot_all_missing)
    write_csv(snap / "CAN-FILL-in-stock-hidden-no-image.csv", unused_ready)
    write_csv(snap / "CANNOT-FILL-in-stock-hidden-no-image.csv", no_bytes)

    print(json.dumps(counts["matches_overview"], indent=2))
    print("missing", {"in_stock": len(missing_in_stock), "oos": len(missing_oos), "all": len(missing_any)})
    print("wrote", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
