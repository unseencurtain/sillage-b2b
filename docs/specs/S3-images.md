# S3 — product image playbook (wholesale-perfumes)

Retail BeautyFort `/pic/` thumbs and BTS `no_image.webp` pipelines live in
[unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).

This shop has one vendor. Storefront images come from:

1. Catalog XML image URL (if usable)
2. `sillage-core/data/image_overrides.json` (EAN → URL)
3. Else empty → hide when **Hide products without image** is on

`isPlaceholderImage` treats empty, `placeholder`, and `no_image` URLs as unusable. There is no
BeautyFort `/pic/` special case here.

JPEG bytes are gitignored. Git carries the override map. Restore media from the wholesale CDN
volume or rsync — do not run deleted `beautyfort-enriched` scripts.
