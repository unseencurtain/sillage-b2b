# Photo pack — snapshot 2026-09-03T19:57:42Z

Live shop `https://prinscosmetic.eu` · CDN `https://images.prinscosmetic.eu` · host `ovhe (ovh-experi / 139.99.61.71)`

## How many photos are still missing?

| What | Count |
|---|---|
| WooCommerce products | 54,505 |
| **On the shop with a usable photo** | **41,147** |
| **On the shop with no usable photo** (hidden while hide-without-image is on) | **13,358** |
| Of those, we already have bytes or a real URL (CDN / override / scrape / Brasty) — **not applied** | 13,191 |
| **Truly no photo anywhere** (no CDN file, no override URL, no scrape file, no Brasty dump file) | **167** |
| Shop-missing EANs that also appear in the wholesale export.csv | 519 |
| …and still no bytes anywhere | 3 |

The wholesale file has **11,013** rows and **11,013** barcodes. It has **no image URL column**. Matching it does not add photos by itself; it only tells us which missing shop EANs exist in that catalogue.

### Wholesale export.csv coverage (by EAN)

| Coverage | Rows |
|---|---|
| Already on our CDN | 1,250 |
| Override URL (Shopify / BTS / ocean / …) | 1,298 |
| Unreviewed EAN scrape (`scraped/`) | 490 |
| In the Brasty dump on the VPS | 3,360 |
| **No image anywhere** | **4,615** |
| No usable EAN | 0 |

## What we already have (bytes + URLs)

| Source | Count | In this pack |
|---|---|---|
| Live CDN `~/ecom_sites/data/media/` | 4,198 | `files/cdn/` |
| EAN scrape, **not** on the shop | 13,204 | `files/scraped/` |
| Brasty dump (EAN.jpg, skip camera placeholders when restoring) | 35,567 | `files/brasty/` |
| `image_overrides.json` usable keys | 10,955 | `maps/image_overrides.json` |
| Third-party hotlinks to download | 4,652 | `files/remote/` + `lists/third-party-urls.csv` |

Third-party hosts: {'cdn.shopify.com': 3822, 'images.btswholesaler.com': 757, 'www.oceanfragrances.com': 73}

## Do not

- Do not copy `files/scraped/` onto the live CDN until a human has inspected the JPEGs.
- Do not turn hide-without-image off to “fix” the missing count.
- Do not serve this pack with `python3 -m http.server` on `0.0.0.0`. Use `scripts/start-serve.sh` (localhost) and `scripts/stop-serve.sh`.
