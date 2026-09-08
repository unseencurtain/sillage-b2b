# Missing-image products — fill by EAN

Shop products hidden by **Hide products without image** are exported, then
photos are fetched with a mix of tricks. “Barcode” here means the product
**EAN** (EAN-13 / UPC / GTIN). Rows with no EAN are skipped.

Order: Open Facts / Go-UPC **by EAN** → Open Facts search by **brand + name**
(keep only if the result EAN matches) → Bing Images for
`EAN + brand + name`. Files are always `{ean}.jpg`.

## Live VPS work dir

`~/sillage/ean-image-scrape/` on `ovhe`.

`scraped/{ean}.jpg` is **not** a quality guarantee. A live size pass (2026-09-03):
**13,204** files, **~1,943 under 8 KB** (likely icons / generic marks / empty).
“CAN fill 9,621” on the in-stock no-image card mostly means “a scrape file exists”,
not “a bottle photo is ready for the shop.” Inspect before `--apply-to-shop`.

| File | What |
|---|---|
| `missing-products.csv` | sku, name, brand, vendor, **EAN**, extras, slug |
| `scraped/{ean}.jpg` | Unreviewed lookup result named by EAN |
| `reports/progress.jsonl` | resume log |

Do not keep a second zip of `scraped/` on the VPS; the folder is enough.

Rows with no real EAN are skipped (`skipped_no_barcode` in `export-summary.json`).

## Scripts (in git)

`production-environment/python-analysis/ean-image-scrape/`

1. `export_missing.py` — MariaDB: empty Woo `_external_thumbnail_url` **and** a real EAN
2. `scrape_ean_images.py` — Open Beauty/Products/Food Facts, then Go-UPC, query by EAN
3. `apply_scraped.py` — **zip only** by default. Does **not** write the shop.
   Use `--apply-to-shop` only after the files in `scraped/` have been inspected.

Hide-without-image stays **on**. Do not push unreviewed photos onto the CDN.
