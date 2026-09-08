"""
Tests for beautyfort-enriched cross-vendor image enrichment.
Run: python3 test.py
"""
import csv
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))

passed = 0
failed = 0
errors = []


def ok(label):
    global passed
    passed += 1
    print(f"  \u2713 {label}")


def fail(label, msg=""):
    global failed
    failed += 1
    errors.append(f"{label}: {msg}")
    print(f"  \u2717 {label} -- {msg}")


def eq(actual, expected, label):
    if actual == expected:
        ok(label)
    else:
        fail(label, f"expected {repr(expected)}, got {repr(actual)}")


def neq(actual, not_expected, label):
    if actual != not_expected:
        ok(label)
    else:
        fail(label, f"should not be {repr(not_expected)}")


# Import the functions we test
sys.path.insert(0, ROOT)
from brasty_placeholders import BRASTY_NO_PHOTO_MD5, file_is_brasty_placeholder
from enrich import (
    normalize_ean,
    parse_bf_barcodes,
    fix_encoding,
    escape_csv_field,
    csv_row,
    is_placeholder_image,
    resolve_image_for_eans,
    expand_overrides_for_product,
)
from fetch_wholesale_perfumes import parse_wholesale_perfumes_catalog, collect_eans, pick_image
import xml.etree.ElementTree as ET


# ============================================================
print("\n--- normalize_ean ---")
# ============================================================

eq(normalize_ean("3760263370339"), "3760263370339", "plain EAN passes through")
eq(normalize_ean("003760263370339"), "3760263370339", "leading zeros stripped")
eq(normalize_ean("'3337871323622"), "3337871323622", "leading apostrophe stripped")
eq(normalize_ean("  3760263370339  "), "3760263370339", "whitespace trimmed")
eq(normalize_ean("0000000000000"), None, "all-zeros rejected")
eq(normalize_ean(""), None, "empty string rejected")
eq(normalize_ean("  "), None, "whitespace-only rejected")
eq(normalize_ean("abc123"), None, "alphanumeric rejected")
eq(normalize_ean("85715163189"), "85715163189", "11-digit EAN ok")
eq(normalize_ean("4973167323359"), "4973167323359", "13-digit EAN ok")

# ============================================================
print("\n--- parse_bf_barcodes ---")
# ============================================================

eq(parse_bf_barcodes("3760263370339"), ["3760263370339"], "single barcode")
eq(parse_bf_barcodes("3760263370339, 3760263373507"), ["3760263370339", "3760263373507"], "multi barcode")
eq(parse_bf_barcodes("003760263370339, 0000000000000, 85715163189"), ["3760263370339", "85715163189"], "mixed valid/invalid filters zeros")
eq(parse_bf_barcodes(""), [], "empty string")
eq(parse_bf_barcodes("   "), [], "whitespace only")
eq(parse_bf_barcodes(" 3760263370339 , 3760263373507 "), ["3760263370339", "3760263373507"], "spaces around commas")
eq(len(parse_bf_barcodes("3760263370339, 3760263373507, 85715163189, 4973167323359, 003337871323622")), 5, "5 barcodes parsed")

# ============================================================
print("\n--- fix_encoding ---")
# ============================================================

eq(fix_encoding("Düft"), "Düft", "German umlaut fixed")
eq(fix_encoding("hello"), "hello", "plain ASCII unchanged")
eq(fix_encoding(""), "", "empty string")
eq(fix_encoding("Körperflege"), "Körperflege", "ö umlaut fixed")

# ============================================================
print("\n--- escape_csv_field ---")
# ============================================================

eq(escape_csv_field("hello"), "hello", "plain field no escape")
eq(escape_csv_field("has,comma"), '"has,comma"', "comma field quoted")
eq(escape_csv_field('has"quote'), '"has""quote"', "quote escaped doubled")
eq(escape_csv_field("has\nnewline"), '"has\nnewline"', "newline field quoted")
eq(escape_csv_field(42), "42", "number converted to string")

# ============================================================
print("\n--- csv_row ---")
# ============================================================

eq(csv_row(["a", "b", "c"]), "a,b,c", "simple row")
eq(csv_row(["a", "has,comma", "c"]), 'a,"has,comma",c', "row with escaped field")
eq(csv_row([""]), "", "single empty field")

# ============================================================
print("\n--- EAN matching logic (simulated) ---")
# ============================================================

# Simulate image_overrides
overrides = {
    "3760263370339": "https://cdn.shopify.com/img1.jpg",
    "85715163189": "https://oceanfragrances.com/img2.jpg",
}

# Multi-barcode: first match wins
barcodes = ["9999999999999", "3760263370339"]
found = ""
for b in barcodes:
    ean = normalize_ean(b)
    if ean and ean in overrides:
        found = overrides[ean]
        break
eq(found, "https://cdn.shopify.com/img1.jpg", "multi-barcode override match: first match wins")

# No match
barcodes2 = ["9999999999999", "8888888888888"]
found2 = ""
for b in barcodes2:
    ean = normalize_ean(b)
    if ean and ean in overrides:
        found2 = overrides[ean]
        break
eq(found2, "", "no override match returns empty")

# ============================================================
print("\n--- is_placeholder_image ---")
# ============================================================

eq(is_placeholder_image(""), True, "empty is placeholder")
eq(is_placeholder_image(None), True, "None is placeholder")
eq(is_placeholder_image("https://cdn.example/no_image.jpg"), True, "no_image flagged")
eq(is_placeholder_image("https://x/woocommerce-placeholder.png"), True, "wc placeholder flagged")
eq(is_placeholder_image("https://cdn.shopify.com/files/H249874.jpg"), False, "real shopify URL ok")

# ============================================================
print("\n--- resolve + multi-EAN fan-out ---")
# ============================================================

sources = [
    ("overrides", {}),
    ("oceanfragrances", {}),
    ("shopify", {}),
    ("bts", {"111": "https://bts.example/a.jpg", "222": "https://bts.example/ignored.jpg"}),
]
url, src = resolve_image_for_eans(["999", "111", "333"], sources)
eq(url, "https://bts.example/a.jpg", "resolve hits second EAN on BTS")
eq(src, "bts", "resolve reports bts source")

fan = {}
expand_overrides_for_product(["111", "333", "444"], url, fan)
eq(fan.get("111"), url, "fan-out maps hit EAN")
eq(fan.get("333"), url, "fan-out maps sibling EAN without source hit")
eq(fan.get("444"), url, "fan-out maps all product EANs")
eq(len(fan), 3, "fan-out wrote three keys")

# ============================================================
print("\n--- wholesale-perfumes XML multi-EAN parsing ---")
# ============================================================

fixture = os.path.join(ROOT, "fixtures", "wholesale_perfumes_catalog_sample.xml")
wpf_map = parse_wholesale_perfumes_catalog(fixture)
eq(
    wpf_map.get("1231231231234"),
    "https://images.elsvc.net/xml/HQlgckCAqXUZdlXzHgtlzQ.jpg",
    "primary EAN maps to flask_front",
)
eq(
    wpf_map.get("4564564564567"),
    "https://images.elsvc.net/xml/HQlgckCAqXUZdlXzHgtlzQ.jpg",
    "sibling all_eans EAN maps to same image",
)
eq(
    wpf_map.get("7897897897891"),
    "https://images.elsvc.net/xml/HQlgckCAqXUZdlXzHgtlzQ.jpg",
    "third all_eans EAN maps to same image",
)
eq("9999999999999" in wpf_map, False, "placeholder flask_front skipped")
eq(
    wpf_map.get("1111111111111"),
    "https://images.elsvc.net/xml/fallback-only.jpg",
    "fallback picture used when no flask_front",
)

tree = ET.parse(fixture)
products = [el for el in tree.getroot() if el.tag.endswith("product") or el.tag == "product"]
eq(len(collect_eans(products[0])), 3, "collect_eans returns three unique EANs")
eq(
    pick_image(products[0]).endswith("HgtlzQ.jpg") or "HQlgck" in pick_image(products[0]),
    True,
    "pick_image prefers flask_front",
)

# ============================================================
print("\n--- CSV output file validation ---")
# ============================================================

# Write a test CSV and read it back
tmpdir = tempfile.mkdtemp()
test_csv = os.path.join(tmpdir, "test.csv")

with open(test_csv, "w", newline="", encoding="utf-8") as f:
    f.write(csv_row(["ean", "name", "price"]) + "\n")
    f.write(csv_row(["3760263370339", "Product, with comma", "29.99"]) + "\n")
    f.write(csv_row(["85715163189", 'Product with "quotes"', "15.50"]) + "\n")

with open(test_csv, encoding="utf-8") as f:
    reader = csv.reader(f)
    rows = list(reader)

eq(len(rows), 3, "CSV: 3 rows (header + 2 data)")
eq(rows[0], ["ean", "name", "price"], "CSV: header correct")
eq(rows[1][0], "3760263370339", "CSV: EAN correct")
eq(rows[1][1], "Product, with comma", "CSV: comma field round-trips")
eq(rows[2][1], 'Product with "quotes"', "CSV: quote field round-trips")

os.unlink(test_csv)
os.rmdir(tmpdir)

# ============================================================
print("\n--- WooCommerce CSV format validation ---")
# ============================================================

woo_headers = [
    "SKU", "Name", "Published", "Is featured?", "Visibility in catalog",
    "Tax status", "In stock?", "Stock", "Backorders allowed?", "Regular price",
    "Categories", "Images", "Short description", "Description",
]

tmpdir2 = tempfile.mkdtemp()
woo_csv = os.path.join(tmpdir2, "woo.csv")

with open(woo_csv, "w", newline="", encoding="utf-8") as f:
    f.write(csv_row(woo_headers) + "\n")
    f.write(csv_row([
        "BF001", "Test Product", "1", "0", "visible", "taxable",
        "1", "10", "0", "29.99",
        "Duft > Damen", "https://img.com/img.jpg", "", "A test product",
    ]) + "\n")

with open(woo_csv, encoding="utf-8") as f:
    reader = csv.DictReader(f)
    row = next(reader)

eq(row["SKU"], "BF001", "Woo: SKU present")
eq(row["Published"], "1", "Woo: Published=1")
eq(row["Visibility in catalog"], "visible", "Woo: visible")
eq(row["Tax status"], "taxable", "Woo: taxable")
eq(row["In stock?"], "1", "Woo: in stock")
eq(row["Regular price"], "29.99", "Woo: price")
eq(row["Categories"], "Duft > Damen", "Woo: categories joined")
eq(row["Images"], "https://img.com/img.jpg", "Woo: image URL")

os.unlink(woo_csv)
os.rmdir(tmpdir2)

# ============================================================
# Integration test: run enrich.py and validate output
# ============================================================
print("\n--- Integration: run enrich.py ---")

enrich_script = os.path.join(ROOT, "enrich.py")
exit_code = os.system(f'python3 "{enrich_script}" > /dev/null 2>&1')
eq(exit_code, 0, "enrich.py exits with code 0")

output_dir = os.path.join(ROOT, "output")

# Check all output files exist
eq(os.path.exists(os.path.join(output_dir, "beautyfort_normalized.csv")), True, "beautyfort_normalized.csv exists")
eq(os.path.exists(os.path.join(output_dir, "beautyfort_woocommerce.csv")), True, "beautyfort_woocommerce.csv exists")
eq(os.path.exists(os.path.join(output_dir, "report.json")), True, "report.json exists")
eq(os.path.exists(os.path.join(output_dir, "image_overrides.json")), True, "image_overrides.json exists")

with open(os.path.join(output_dir, "image_overrides.json"), encoding="utf-8") as f:
    built = json.load(f)
assert isinstance(built, dict) and len(built) > 0, "overrides map non-empty"
print(f"  (override EAN keys: {len(built)})")
# No placeholders in the Bun-facing map
bad = [k for k, v in built.items() if is_placeholder_image(v)]
eq(bad, [], "overrides contain no placeholder URLs")

# Validate normalized CSV
with open(os.path.join(output_dir, "beautyfort_normalized.csv"), encoding="utf-8") as f:
    reader = csv.DictReader(f)
    enriched = list(reader)

print(f"  (enriched rows: {len(enriched)})")
assert len(enriched) > 0, "enriched CSV has rows"
eq(enriched[0].get("image_url", "") != "", True, "first enriched row has image_url")

# Validate WooCommerce CSV
with open(os.path.join(output_dir, "beautyfort_woocommerce.csv"), encoding="utf-8") as f:
    reader = csv.DictReader(f)
    woo_rows = list(reader)

print(f"  (woo rows: {len(woo_rows)})")
eq(len(woo_rows), len(enriched), "WooCommerce CSV has same row count as enriched")
eq(woo_rows[0].get("Images", "") != "", True, "first woo row has Images field")

# Validate report
with open(os.path.join(output_dir, "report.json"), encoding="utf-8") as f:
    report = json.load(f)

assert "total_beautyfort_products" in report, "report has total_beautyfort_products"
assert "products_with_image" in report, "report has products_with_image"
assert "image_match_rate" in report, "report has image_match_rate"
print(f"  (report: {report['products_with_image']}/{report['total_beautyfort_products']} with image = {report['image_match_rate']})")

# Validate no thumbnails leaked in (thumbnails are ~50px, don't count)
for r in enriched:
    img = r.get("image_url") or ""
    assert "Thumbnail" not in img, f"thumbnail found in output: {img}"

# ============================================================
print("\n--- Brasty camera placeholders ---")
# ============================================================

eq(len(BRASTY_NO_PHOTO_MD5), 3, "three known encodings of the camera graphic")
eq(
    "3c9965d4926d04529b513909a41373dc" in BRASTY_NO_PHOTO_MD5,
    True,
    "8542-byte 8809598454323.jpg encoding is blocked",
)

# ============================================================
# Summary
# ============================================================

print(f"\n{'=' * 50}")
print(f"  RESULTS: {passed} passed, {failed} failed")
if errors:
    print(f"\n  FAILURES:")
    for e in errors:
        print(f"    - {e}")
print(f"{'=' * 50}")

sys.exit(1 if failed > 0 else 0)
