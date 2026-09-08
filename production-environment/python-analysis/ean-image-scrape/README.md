# EAN image scrape

Fill shop products that have **no photo**. Every row must have an **EAN**.
Lookups try EAN first, then **EAN + brand + name** (Bing / Open Facts search).
A photo is always saved as `{ean}.jpg`. Rows with no EAN are skipped.

## VPS folder

```
~/sillage/ean-image-scrape/
  missing-products.csv     EAN + name + brand (rows without an EAN are omitted)
  scraped/                 photos named {ean}.jpg
  scraped-ean-images.zip   downloadable archive of scraped/
  reports/
```

## Run on `ovhe`

```bash
DIR=~/sillage/ean-image-scrape
mkdir -p "$DIR"
cp -a production-environment/python-analysis/ean-image-scrape/. "$DIR/bin/"

python3 "$DIR/bin/export_missing.py" --out-dir "$DIR"
python3 "$DIR/bin/scrape_ean_images.py" --work-dir "$DIR" --workers 3
python3 "$DIR/bin/apply_scraped.py" --work-dir "$DIR"   # zip only; inspect scraped/
# only after inspection:
# python3 "$DIR/bin/apply_scraped.py" --work-dir "$DIR" --apply-to-shop --rewrite
```

`--rewrite` copies files into `~/ecom_sites/data/media/`, merges
`image_overrides.json` keyed by EAN, recreates core/cron, then content-rewrites
only the dirty rows.
