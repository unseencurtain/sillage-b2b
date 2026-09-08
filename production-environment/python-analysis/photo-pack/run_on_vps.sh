#!/usr/bin/env bash
# Live photo inventory. Run on ovhe only. Does not change the shop.
set -euo pipefail
HOME_U="${HOME:-/home/ubuntu}"
OUT="${HOME_U}/photo-inventory"
IDX="${OUT}/indexes"
HERE="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$IDX" "$OUT/lists"
echo "== dump live shop =="
python3 "$HERE/dump_shop_visibility.py" "$IDX/shop-visibility.tsv"

echo "== index CDN + scrape + overrides =="
find "${HOME_U}/ecom_sites/data/media" -type f > "$IDX/cdn-files.txt"
find "${HOME_U}/sillage/ean-image-scrape/scraped" -type f > "$IDX/scraped-files.txt"
cp -a "${HOME_U}/sillage/sillage-core/data/image_overrides.json" "$IDX/image_overrides.json"

echo "== classify Brasty dump =="
python3 "$HERE/classify_brasty.py" "${HOME_U}/brasty" "$IDX"

echo "== build CAN/CANNOT lists =="
python3 "$HERE/build_inventory.py" \
  --tsv "$IDX/shop-visibility.tsv" \
  --inventory "$IDX" \
  --out "$OUT" \
  --snapshot "$HERE/snapshot"

echo "== zip lists (no JPEG bytes) =="
rm -f "${HOME_U}/photo-inventory.zip"
( cd "$HOME_U" && zip -qr photo-inventory.zip photo-inventory -x 'photo-inventory/indexes/*' )
ls -lh "${HOME_U}/photo-inventory.zip" "$OUT/COUNTS.json"
echo "done. lists are in $OUT — shop was not modified."
