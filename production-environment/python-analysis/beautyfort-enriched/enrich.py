#!/usr/bin/env python3
"""
Cross-vendor BeautyFort image enrichment.

Matches every barcode on a BeautyFort product against wholesale-perfumes.eu XML, oceanfragrances CSV,
Shopify, and BTS image indexes. When any EAN hits, all EANs on that product map to the
same URL so Bun's `data/image_overrides.json` lookup works regardless of which EAN is
primary on the offer.

Usage:
  python3 enrich.py
  python3 enrich.py --fetch-wholesale-perfumes --install-core
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import sys
ROOT = os.path.dirname(os.path.abspath(__file__))
PRODUCTS = os.path.join(ROOT, "products")
OVERRIDES_SEED = os.path.join(ROOT, "data", "image_overrides.json")
OUTPUT = os.path.join(ROOT, "output")
CORE_OVERRIDES = os.path.normpath(
    os.path.join(ROOT, "..", "..", "sillage-core", "data", "image_overrides.json")
)


def normalize_ean(raw):
    if raw is None:
        return None
    cleaned = str(raw).strip().lstrip("'")
    if not cleaned or cleaned == "0000000000000":
        return None
    if not cleaned.isdigit():
        return None
    return cleaned.lstrip("0") or None


def parse_bf_barcodes(barcode):
    if not barcode or not str(barcode).strip():
        return []
    eans = []
    for part in str(barcode).split(","):
        ean = normalize_ean(part)
        if ean:
            eans.append(ean)
    return eans


def fix_encoding(s):
    try:
        return s.encode("latin-1").decode("utf-8")
    except (UnicodeDecodeError, UnicodeEncodeError):
        return s


def is_placeholder_image(url):
    """Align with sillage-core/src/sync/images.ts isPlaceholderImage."""
    if not url:
        return True
    low = str(url).lower().strip()
    if not low:
        return True
    return (
        "no_image" in low
        or "woocommerce-placeholder" in low
        or "placeholder" in low
        or low.endswith("/images/")
        or ("/thumb/" in low and "noimage" in low)
    )


def escape_csv_field(value):
    v = str(value)
    if "," in v or '"' in v or "\n" in v:
        return '"' + v.replace('"', '""') + '"'
    return v


def csv_row(fields):
    return ",".join(escape_csv_field(f) for f in fields)


def resolve_image_for_eans(eans, sources):
    """
    Probe sources in order. Each source is a (name, dict[ean->url]) pair.
    Returns (url, source_name) or ("", "").
    """
    for name, index in sources:
        for ean in eans:
            hit = index.get(ean)
            if hit and not is_placeholder_image(hit):
                return hit, name
    return "", ""


def expand_overrides_for_product(eans, image_url, out_map):
    """Map every EAN on the product to the same image URL (multi-EAN fan-out)."""
    if is_placeholder_image(image_url):
        return 0
    for ean in eans:
        out_map[ean] = image_url
    return len(eans)


def load_seed_overrides(path):
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    out = {}
    for k, v in raw.items():
        ean = normalize_ean(k)
        if ean and not is_placeholder_image(v):
            out[ean] = v
    return out


def load_ocean_csv_index(path):
    """Legacy semicolon CSV (oceanfragrances.csv)."""
    index = {}
    with open(path, encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter=";")
        for row in reader:
            ean_raw = row.get("EAN", "")
            image = row.get("Image", "")
            if not ean_raw or is_placeholder_image(image):
                continue
            for part in ean_raw.replace(";", ",").replace("-", ",").split(","):
                ean = normalize_ean(part)
                if ean and ean not in index:
                    index[ean] = image
    return index


# Back-compat alias used by older tests / callers
load_ocean_index = load_ocean_csv_index


def load_wholesale_perfumes_xml_index(path):
    from fetch_wholesale_perfumes import parse_wholesale_perfumes_catalog

    return parse_wholesale_perfumes_catalog(path)

def load_shopify_index(path):
    index = {}
    with open(path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            barcode = row.get("Variant Barcode", "")
            image = row.get("Image Src", "")
            if not barcode or is_placeholder_image(image):
                continue
            ean = normalize_ean(barcode)
            if ean and ean not in index:
                index[ean] = image
    return index


def load_bts_index(path):
    with open(path, encoding="utf-8") as f:
        products = json.load(f)
    index = {}
    for p in products:
        ean = normalize_ean(p.get("ean", ""))
        if not ean:
            continue
        # BTS may carry multiple EANs in some exports; also try all_eans if present.
        extras = p.get("all_eans") or p.get("eans") or []
        eans = [ean]
        if isinstance(extras, list):
            for x in extras:
                n = normalize_ean(x)
                if n:
                    eans.append(n)
        elif isinstance(extras, str):
            eans.extend(parse_bf_barcodes(extras))

        img = p.get("image", "") or p.get("image_url", "")
        if is_placeholder_image(img):
            continue
        for e in eans:
            if e not in index:
                index[e] = img
    return index


def run(install_core=False, fetch_wholesale_perfumes=False, force_wholesale_perfumes=False):
    os.makedirs(OUTPUT, exist_ok=True)
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)

    bf_path = os.path.join(PRODUCTS, "beautyfort.json")
    ocean_csv_path = os.path.join(PRODUCTS, "oceanfragrances.csv")
    wholesale_perfumes_xml_path = os.path.join(PRODUCTS, "wholesale_perfumes_catalog.xml")
    shopify_path = os.path.join(PRODUCTS, "products_export_1.csv")
    bts_path = os.path.join(PRODUCTS, "bts_wholeseller.json")

    for required in (bf_path, ocean_csv_path, shopify_path, bts_path):
        if not os.path.isfile(required):
            print(f"missing input: {required}", file=sys.stderr)
            sys.exit(1)

    if fetch_wholesale_perfumes:
        from fetch_wholesale_perfumes import fetch_and_index

        print("[0/6] Fetching wholesale-perfumes catalog XML...")
        fetch_and_index(force=force_wholesale_perfumes)

    print("[1/6] Loading BeautyFort products...")
    with open(bf_path, encoding="utf-8") as f:
        beautyfort = json.load(f)
    print(f"  {len(beautyfort)} products")

    print("[2/6] Loading seed image overrides...")
    overrides = load_seed_overrides(OVERRIDES_SEED)
    print(f"  {len(overrides)} EAN -> image mappings")

    print("[3/6] Building wholesale-perfumes XML index...")
    wholesale_perfumes_xml_ean_to_image = {}
    if os.path.isfile(wholesale_perfumes_xml_path):
        wholesale_perfumes_xml_ean_to_image = load_wholesale_perfumes_xml_index(wholesale_perfumes_xml_path)
        print(f"  {len(wholesale_perfumes_xml_ean_to_image)} unique EANs from XML")
    else:
        print("  (no products/wholesale_perfumes_catalog.xml — skip; run with --fetch-wholesale-perfumes)")

    print("[4/6] Building oceanfragrances CSV EAN index...")
    ocean_csv_ean_to_image = load_ocean_csv_index(ocean_csv_path)
    print(f"  {len(ocean_csv_ean_to_image)} unique EANs")

    print("[5/6] Building shopify EAN index...")
    shopify_ean_to_image = load_shopify_index(shopify_path)
    print(f"  {len(shopify_ean_to_image)} unique EANs")

    print("[6/6] Building BTS EAN index...")
    bts_ean_to_image = load_bts_index(bts_path)
    print(f"  {len(bts_ean_to_image)} unique EANs")

    sources = [
        ("overrides", overrides),
        ("wholesale_perfumes_xml", wholesale_perfumes_xml_ean_to_image),
        ("oceanfragrances", ocean_csv_ean_to_image),
        ("shopify", shopify_ean_to_image),
        ("bts", bts_ean_to_image),
    ]

    print("\nEnriching BeautyFort products...")

    stats = {
        "total": len(beautyfort),
        "has_barcode": 0,
        "image_from_overrides": 0,
        "image_from_wholesale_perfumes_xml": 0,
        "image_from_oceanfragrances": 0,
        "image_from_shopify": 0,
        "image_from_bts": 0,
        "no_image": 0,
        "matched_bts_ean": 0,
        "output_rows": 0,
        "override_ean_keys": 0,
    }

    enriched_rows = []
    built_overrides = dict(overrides)  # start from seed; expand with multi-EAN fan-out

    for p in beautyfort:
        barcode = p.get("Barcode", "")
        eans = parse_bf_barcodes(barcode)
        if not eans:
            continue
        stats["has_barcode"] += 1

        for ean in eans:
            if ean in bts_ean_to_image:
                stats["matched_bts_ean"] += 1
                break

        image_url, image_source = resolve_image_for_eans(eans, sources)

        if is_placeholder_image(image_url):
            image_url = ""
            image_source = ""

        if image_url:
            expand_overrides_for_product(eans, image_url, built_overrides)

            if image_source == "overrides":
                stats["image_from_overrides"] += 1
            elif image_source == "wholesale_perfumes_xml":
                stats["image_from_wholesale_perfumes_xml"] += 1
            elif image_source == "oceanfragrances":
                stats["image_from_oceanfragrances"] += 1
            elif image_source == "shopify":
                stats["image_from_shopify"] += 1
            elif image_source == "bts":
                stats["image_from_bts"] += 1
            stats["output_rows"] += 1

            cat_raw = p.get("Category", "")
            cat = fix_encoding(cat_raw) if cat_raw else ""
            category_path = " > ".join(c.strip() for c in cat.split(" > ") if c.strip())

            enriched_rows.append({
                "ean": eans[0],
                "eans": eans,
                "vendor_sku": p.get("StockCode", ""),
                "name": fix_encoding(p.get("FullName", "")),
                "brand": fix_encoding(p.get("Brand", "")),
                "description": fix_encoding(p.get("Description", "")),
                "category_path": category_path,
                "price": p.get("Price", "0"),
                "stock": p.get("StockLevel", 0),
                "image_url": image_url,
            })
        else:
            stats["no_image"] += 1

    stats["override_ean_keys"] = len(built_overrides)

    # --- Write outputs ---
    headers_11 = [
        "ean", "vendor_id", "vendor_sku", "name", "brand", "description",
        "category_path", "price", "stock", "image_url", "currency",
    ]

    with open(os.path.join(OUTPUT, "beautyfort_normalized.csv"), "w", newline="", encoding="utf-8") as f:
        f.write(csv_row(headers_11) + "\n")
        for r in enriched_rows:
            f.write(csv_row([
                r["ean"], "beautyfort", r["vendor_sku"], r["name"], r["brand"],
                r["description"], r["category_path"], r["price"], str(r["stock"]),
                r["image_url"], "EUR",
            ]) + "\n")

    woo_headers = [
        "SKU", "Name", "Published", "Is featured?", "Visibility in catalog",
        "Tax status", "In stock?", "Stock", "Backorders allowed?", "Regular price",
        "Categories", "Images", "Short description", "Description",
    ]
    with open(os.path.join(OUTPUT, "beautyfort_woocommerce.csv"), "w", newline="", encoding="utf-8") as f:
        f.write(csv_row(woo_headers) + "\n")
        for r in enriched_rows:
            in_stock = "1" if int(str(r["stock"])) > 0 else "0"
            f.write(csv_row([
                r["vendor_sku"], r["name"], "1", "0", "visible", "taxable",
                in_stock, str(r["stock"]), "0", str(r["price"]),
                r["category_path"], r["image_url"], "", r["description"],
            ]) + "\n")

    overrides_out = os.path.join(OUTPUT, "image_overrides.json")
    with open(overrides_out, "w", encoding="utf-8") as f:
        json.dump(built_overrides, f, indent=2, sort_keys=True)
        f.write("\n")

    # Keep python-analysis/data seed in sync for the next run.
    with open(OVERRIDES_SEED, "w", encoding="utf-8") as f:
        json.dump(built_overrides, f, indent=2, sort_keys=True)
        f.write("\n")

    rate = f"{stats['output_rows'] / stats['total'] * 100:.1f}%" if stats["total"] else "0%"
    report = {
        "total_beautyfort_products": stats["total"],
        "products_with_barcode": stats["has_barcode"],
        "products_with_image": stats["output_rows"],
        "products_no_image": stats["no_image"],
        "image_match_rate": rate,
        "override_ean_keys": stats["override_ean_keys"],
        "image_sources": {
            "overrides_precomputed": stats["image_from_overrides"],
            "wholesale_perfumes_xml": stats["image_from_wholesale_perfumes_xml"],
            "oceanfragrances_csv": stats["image_from_oceanfragrances"],
            "shopify_direct": stats["image_from_shopify"],
            "bts_cross_vendor": stats["image_from_bts"],
        },
        "bts_ean_matches": stats["matched_bts_ean"],
        "bun_install_path": CORE_OVERRIDES,
        "note": "After --install-core, run a fast/rewrite sync so WooCommerce _external_thumbnail_url updates.",
    }
    with open(os.path.join(OUTPUT, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
        f.write("\n")

    if install_core:
        os.makedirs(os.path.dirname(CORE_OVERRIDES), exist_ok=True)
        shutil.copyfile(overrides_out, CORE_OVERRIDES)
        print(f"\nInstalled Bun overrides → {CORE_OVERRIDES} ({len(built_overrides)} EANs)")

    print(f"\n{'=' * 55}")
    print("  CROSS-VENDOR IMAGE ENRICHMENT REPORT")
    print(f"{'=' * 55}")
    print(f"  Total BeautyFort products:       {stats['total']}")
    print(f"  Products with barcode:           {stats['has_barcode']}")
    print(f"  Products WITH real image:        {stats['output_rows']}  ({rate})")
    print(f"  Products WITHOUT image:          {stats['no_image']}")
    print(f"  Override map EAN keys:           {stats['override_ean_keys']}")
    print()
    print("  Image sources:")
    print(f"    overrides (seed / prior):      {stats['image_from_overrides']}")
    print(f"    wholesale-perfumes XML:         {stats['image_from_wholesale_perfumes_xml']}")
    print(f"    oceanfragrances CSV:           {stats['image_from_oceanfragrances']}")
    print(f"    shopify (direct):              {stats['image_from_shopify']}")
    print(f"    bts (cross-vendor):            {stats['image_from_bts']}")
    print()
    print(f"  BTS EAN cross-matches:           {stats['matched_bts_ean']}")
    print()
    print("  Output:")
    print(f"    {os.path.join(OUTPUT, 'beautyfort_normalized.csv')}")
    print(f"    {os.path.join(OUTPUT, 'beautyfort_woocommerce.csv')}")
    print(f"    {overrides_out}")
    print(f"    {os.path.join(OUTPUT, 'report.json')}")
    print(f"{'=' * 55}")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description="BeautyFort cross-vendor image enrichment")
    parser.add_argument(
        "--install-core",
        action="store_true",
        help="Copy output/image_overrides.json into sillage-core/data/",
    )
    parser.add_argument(
        "--fetch-wholesale-perfumes",
        action="store_true",
        help="Download wholesale-perfumes.eu catalog XML before enriching",
    )
    parser.add_argument(
        "--force-wholesale-perfumes",
        action="store_true",
        help="Re-download wholesale-perfumes catalog even if cache is fresh",
    )
    args = parser.parse_args(argv)
    run(
        install_core=args.install_core,
        fetch_wholesale_perfumes=args.fetch_wholesale_perfumes,
        force_wholesale_perfumes=args.force_wholesale_perfumes,
    )

if __name__ == "__main__":
    main()
