# AGENTS.md

## What This Is

Cross-vendor image enrichment tool. Matches **BeautyFort and BTS** products that still have no
usable photo against Brasty (EAN `.jpg` dump), oceanfragrances CSV, and Shopify exports, then
writes Bun-ready `image_overrides.json`.

BeautyFort `/pic/` thumbs and BTS `no_image.webp` are unusable — hide-without-image keeps those
SKUs out of the shop until an override exists.

This pipeline stays outside the Bun app.

## Commands

```bash
cd production-environment/python-analysis

# Match shop products missing a usable photo (BeautyFort + BTS) by EAN
python3 beautyfort-enriched/fill_missing_shop_images.py \
  --products-json /tmp/shop_products.json \
  --overrides ../sillage-core/data/image_overrides.json \
  --ocean /path/oceanfragrances.csv \
  --shopify /path/products_export_1.csv \
  --brasty-eans /tmp/brasty_eans.txt \
  --out-delta /tmp/image_overrides.delta.json \
  --out-merged ../sillage-core/data/image_overrides.json

# Restore CDN-hosted files onto a new VPS (map is in git; JPEGs are not)
python3 beautyfort-enriched/restore_found_images.py \
  --overrides ../sillage-core/data/image_overrides.json \
  --dest ~/ecom_sites/data/media \
  --brasty-root /home/ubuntu/brasty \
  --from-cdn \
  --write-manifest ../sillage-core/data/found-images-manifest.json
# see docs/VPS-MIGRATE.md

# optional: copy .env.example → .env and set WHOLESALE_PERFUMES_USER / WHOLESALE_PERFUMES_TOKEN
python3 beautyfort-enriched/test.py
python3 beautyfort-enriched/fetch_wholesale_perfumes.py
python3 beautyfort-enriched/enrich.py --fetch-wholesale-perfumes --install-core

# Host flask_front (elsvc) override URLs on the images CDN (binaries gitignored)
python3 beautyfort-enriched/host_override_images.py --dry-run
LPS_MEDIA_BASE_URL=https://images.prinscosmetic.eu \
  python3 beautyfort-enriched/host_override_images.py --host images.elsvc.net
# optional next: --host www.oceanfragrances.com
```

After merging overrides, on `ovhe`: copy Brasty jpgs into `~/ecom_sites/data/media/`, rsync
`image_overrides.json` to `~/sillage/sillage-core/data/`, **recreate** `sillage-core` /
`sillage-cron`, then:

```bash
docker exec sillage-core bun run sync -- --mode=full --source=cache --rewrite-only
```

(`--mode=fast --rewrite-only` does not write image-only dirty flags.)

wholesale-perfumes catalog etiquette: download at most once per day (script caches ~20h).

## Structure

```
beautyfort-enriched/
  enrich.py
  fill_missing_shop_images.py  — EAN match for BF+BTS rows still missing a usable photo
  restore_found_images.py      — copy/download CDN files listed in image_overrides.json
  brasty_placeholders.py       — MD5 skip-list for Brasty camera graphics
  fetch_wholesale_perfumes.py  — wholesale-perfumes.eu catalog download + parse
  host_override_images.py      — download remote override URLs → ecom_sites/data/media (images CDN)
  test.py
  fixtures/
    wholesale_perfumes_catalog_sample.xml  — tiny fixture for tests
  data/
    image_overrides.json
  products/                    — gitignored dumps (beautyfort.json, wholesale_perfumes_catalog.xml, …)
  output/
```

## Source priority

1. existing `sillage-core/data/image_overrides.json`
2. **Brasty** VPS dump (`/home/ubuntu/brasty/*`, filename stem = EAN). Skip camera
   placeholders (`brasty_placeholders.py`) — they are not product photos.
3. oceanfragrances.csv (image source only — not a vendor)
4. Shopify CSV (`Variant Barcode` / `Image Src`)
5. wholesale-perfumes XML (`pictures/flask_front`) when enriching WPF / historic BF rows
6. BTS JSON (cross-vendor fill also runs automatically at sync)

Multi-EAN fan-out: any hit maps **all** barcodes on that product to the same URL.

## Bun consumption

`sillage-core/src/sync/images.ts` loads `sillage-core/data/image_overrides.json` at sync time.

## Watch Out For

- `WHOLESALE_PERFUMES_TOKEN` is the API token from wholesale-perfumes **user settings**, not necessarily the shop password.
- "Ocean" in this folder means **oceanfragrances.csv** (image CSV), never the wholesaler.
- Large fixtures under `products/` are not committed.
- Next vendor image work: Brasty Playwright scraper for EANs **not** already in `/home/ubuntu/brasty/`.
- Victoria’s Secret EAN `0197575132998` (SKU `BF-F558351`) was not in Brasty / ocean / Shopify —
  still needs a manual photo. Do not disable hide-without-image shop-wide for one SKU.
