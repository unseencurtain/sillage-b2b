#!/usr/bin/env python3
"""
Fill shop products that still have no usable photo.

Sources (later ones do not clobber earlier hits, and nothing overwrites an
existing image_overrides.json key):

  1. Existing overrides
  2. Brasty folder on the VPS (filename stem = EAN → https://images.prinscosmetic.eu/<EAN>.jpg
     after the file is copied into lps-media). Skip camera 'no photo' placeholders
     (brasty_placeholders.py).
  3. oceanfragrances.csv (EAN column, Image URL)
  4. Shopify products_export_1.csv (Variant Barcode, Image Src)

"Usable" matches sillage-core imageRules: not empty, not placeholder, not BeautyFort /pic/.

Usage (from this directory):

  python3 fill_missing_shop_images.py \\
    --products-json /tmp/shop_products.json \\
    --overrides ../../sillage-core/data/image_overrides.json \\
    --ocean /path/oceanfragrances.csv \\
    --shopify /path/products_export_1.csv \\
    --brasty-eans /tmp/brasty_eans.txt \\
    --out-delta /tmp/image_overrides.delta.json \\
    --out-merged ../../sillage-core/data/image_overrides.json \\
    --brasty-copy-list /tmp/brasty_copy.tsv

Then on the VPS: copy listed Brasty files into ~/ecom_sites/data/media/, rsync
overrides into sillage-core data, recreate sillage-core/sillage-cron, then
`docker exec sillage-core bun run sync -- --mode=full --source=cache --rewrite-only`.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import Counter

# Allow running as a sibling of enrich.py
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from brasty_placeholders import file_is_brasty_placeholder  # noqa: E402
from enrich import (  # noqa: E402
    is_placeholder_image,
    load_ocean_csv_index,
    load_shopify_index,
    normalize_ean,
)


def is_weak_beautyfort_thumb(url: str | None) -> bool:
    if not url:
        return True
    low = str(url).lower()
    return "beautyfort.com/pic/" in low or bool(__import__("re").search(r"beautyfort\.com/pic\b", low))


def is_unusable(url: str | None) -> bool:
    return is_placeholder_image(url) or is_weak_beautyfort_thumb(url)


def parse_eans(primary: str | None, raw_eans) -> list[str]:
    collected: list[str] = []
    if isinstance(raw_eans, list):
        for v in raw_eans:
            n = normalize_ean(v)
            if n:
                collected.append(n)
    elif isinstance(raw_eans, str) and raw_eans.strip():
        try:
            parsed = json.loads(raw_eans)
            if isinstance(parsed, list):
                for v in parsed:
                    n = normalize_ean(v)
                    if n:
                        collected.append(n)
        except json.JSONDecodeError:
            for part in raw_eans.replace(";", ",").replace("-", ",").split(","):
                n = normalize_ean(part)
                if n:
                    collected.append(n)
    n = normalize_ean(primary)
    if n:
        collected.append(n)
    # preserve order, unique
    seen: set[str] = set()
    out: list[str] = []
    for e in collected:
        if e not in seen:
            seen.add(e)
            out.append(e)
    return out


def load_brasty_index(path: str, public_base: str, brasty_root: str = "") -> dict[str, str]:
    """Map normalized EAN → public CDN URL. Filename stem may include leading zeros.

    If ``brasty_root`` is set, walk that tree and skip Brasty's camera 'no photo'
    graphic (see brasty_placeholders.py). ``path`` is then only a fallback name list.
    """
    index: dict[str, str] = {}
    base = public_base.rstrip("/")
    skipped_placeholder = 0

    def add_stem(stem: str) -> None:
        ean = normalize_ean(stem)
        if not ean or ean in index:
            return
        index[ean] = f"{base}/{stem}.jpg"

    if brasty_root and os.path.isdir(brasty_root):
        for dirpath, _, files in os.walk(brasty_root):
            for fn in files:
                disk = os.path.join(dirpath, fn)
                stem, _ext = os.path.splitext(fn)
                if file_is_brasty_placeholder(disk):
                    skipped_placeholder += 1
                    continue
                add_stem(stem)
        if skipped_placeholder:
            print(f"skipped {skipped_placeholder} Brasty camera placeholders", file=sys.stderr)
        return index

    with open(path, encoding="utf-8") as f:
        for line in f:
            raw = line.strip()
            if not raw:
                continue
            stem = os.path.basename(raw)
            if "." in stem:
                stem = stem.rsplit(".", 1)[0]
            add_stem(stem)
    return index


def load_overrides(path: str) -> dict[str, str]:
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    out: dict[str, str] = {}
    for k, v in raw.items():
        ean = normalize_ean(k)
        if ean and not is_unusable(v):
            out[ean] = v
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Match missing shop product images by EAN.")
    ap.add_argument("--products-json", required=True, help="Array of {sku, primary_ean, eans, image_url}")
    ap.add_argument("--overrides", required=True)
    ap.add_argument("--ocean", required=True)
    ap.add_argument("--shopify", required=True)
    ap.add_argument("--brasty-eans", help="One EAN/filename per line from the VPS Brasty dump")
    ap.add_argument(
        "--brasty-root",
        default="",
        help="Walk this tree to skip Brasty camera 'no photo' placeholders by MD5",
    )
    ap.add_argument("--public-base", default="https://images.prinscosmetic.eu")
    ap.add_argument("--out-delta", required=True)
    ap.add_argument("--out-merged")
    ap.add_argument("--out-report", default="")
    ap.add_argument("--brasty-copy-list", default="", help="TSV: ean<TAB>cdn_url for files to copy into media/")
    args = ap.parse_args()

    with open(args.products_json, encoding="utf-8") as f:
        products = json.load(f)

    overrides = load_overrides(args.overrides)
    ocean = load_ocean_csv_index(args.ocean)
    shopify = load_shopify_index(args.shopify)
    brasty = (
        load_brasty_index(args.brasty_eans, args.public_base, args.brasty_root)
        if args.brasty_eans
        else {}
    )

    sources = [
        ("overrides", overrides),
        ("brasty", brasty),
        ("oceanfragrances", ocean),
        ("shopify", shopify),
    ]

    stats = Counter()
    delta: dict[str, str] = {}
    brasty_hits: list[tuple[str, str]] = []
    still_missing: list[dict] = []

    for row in products:
        eans = parse_eans(row.get("primary_ean") or row.get("primaryEan"), row.get("eans"))
        stats["products"] += 1
        if not eans:
            stats["no_ean"] += 1
            continue

        current = row.get("image_url") or row.get("imageUrl")
        # Already has a usable resolved image from overrides or a real vendor URL.
        already = None
        for ean in eans:
            if ean in overrides:
                already = overrides[ean]
                break
        if already:
            stats["already_overridden"] += 1
            continue
        if not is_unusable(current):
            stats["already_usable_feed"] += 1
            continue

        stats["missing"] += 1
        vendor = str(row.get("vendor") or "")
        if str(row.get("sku") or "").startswith("BF-"):
            vendor = vendor or "beautyfort"
            stats["missing_beautyfort"] += 1
        elif str(row.get("sku") or "").startswith("BTS-"):
            vendor = vendor or "bts"
            stats["missing_bts"] += 1
        hit_url = None
        hit_src = None
        for name, index in sources:
            if name == "overrides":
                continue
            for ean in eans:
                url = index.get(ean)
                if url and not is_unusable(url):
                    hit_url, hit_src = url, name
                    break
            if hit_url:
                break

        if not hit_url:
            still_missing.append(
                {
                    "sku": row.get("sku"),
                    "vendor": vendor,
                    "eans": eans,
                    "name": row.get("name"),
                    "image_url": current,
                }
            )
            stats["unresolved"] += 1
            continue

        stats[f"filled_{hit_src}"] += 1
        if vendor:
            stats[f"filled_{vendor}_{hit_src}"] += 1
        for ean in eans:
            if ean not in overrides and ean not in delta:
                delta[ean] = hit_url
        if hit_src == "brasty":
            brasty_hits.append((eans[0], hit_url))

    merged = dict(overrides)
    merged.update(delta)

    os.makedirs(os.path.dirname(os.path.abspath(args.out_delta)) or ".", exist_ok=True)
    with open(args.out_delta, "w", encoding="utf-8") as f:
        json.dump(delta, f, indent=2, sort_keys=True)
        f.write("\n")

    if args.out_merged:
        os.makedirs(os.path.dirname(os.path.abspath(args.out_merged)) or ".", exist_ok=True)
        with open(args.out_merged, "w", encoding="utf-8") as f:
            json.dump(merged, f, indent=2, sort_keys=True)
            f.write("\n")

    if args.brasty_copy_list:
        with open(args.brasty_copy_list, "w", encoding="utf-8") as f:
            for ean, url in brasty_hits:
                f.write(f"{ean}\t{url}\n")

    report = {
        "stats": dict(stats),
        "delta_keys": len(delta),
        "merged_keys": len(merged),
        "brasty_index": len(brasty),
        "ocean_index": len(ocean),
        "shopify_index": len(shopify),
        "still_missing_sample": still_missing[:25],
        "still_missing_count": len(still_missing),
    }
    report_path = args.out_report or os.path.splitext(args.out_delta)[0] + ".report.json"
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
        f.write("\n")

    print(json.dumps(report["stats"], indent=2))
    print(f"delta {len(delta)} new EAN keys → {args.out_delta}")
    print(f"still missing {len(still_missing)} products (see {report_path})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
