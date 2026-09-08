# S3 — product image playbook

Ordered guide for filling missing product photos. Read `../CONTEXT.md` §6 ("Vendors versus image
sources") and `S3-remaining-work.md` §0 (naming + VPS rules) first.

**Vendors vs image sources.** Only three vendors exist (`bts`, `beautyfort`, `wholesale-perfumes`).
Everything else in this document is an *image source*: EAN → URL, no stock, no prices, no orders.
**"Ocean" means `oceanfragrances.csv` only** — never wholesale-perfumes.eu.

**VPS hosts.**

| SSH host | Role | What you may do |
|---|---|---|
| `ovhe` (`ovh-experi`) | **Live** retail shop | Deploy, migrate, sync, run image tools. Caddy owns `:80`; ecom is `127.0.0.1:104→80` |
| `ovh` | Unused (empty) | Do not deploy unless repurposed |

---

## Restore on a new VPS (photos)

JPEG/WebP bytes are **gitignored** (`ecom_sites/data/media/**`). Git carries:

- `sillage-core/data/image_overrides.json` (EAN → URL)
- `sillage-core/data/found-images-manifest.json` (CDN filenames that must exist on disk)
- `python-analysis/beautyfort-enriched/restore_found_images.py`

Full migrate (rsync vs rebuild): [`../VPS-MIGRATE.md`](../VPS-MIGRATE.md). Agent loop:
[`../AGENTS-RUNBOOK.md`](../AGENTS-RUNBOOK.md).

```bash
python3 production-environment/python-analysis/beautyfort-enriched/restore_found_images.py \
  --overrides production-environment/sillage-core/data/image_overrides.json \
  --dest ~/ecom_sites/data/media \
  --media-src /path/from/old-vps/media \   # optional
  --brasty-root /home/ubuntu/brasty \      # optional
  --from-cdn                               # while images.prinscosmetic.eu still serves
```

Only `images.prinscosmetic.eu` URLs need files on disk. Shopify / BTS / ocean URLs are hotlinks.

---

## Resolution order (how the shop picks a photo)

At sync time, `sillage-core/src/sync/images.ts` resolves each product's image URL in this order:

| Priority | Source | Where it lives |
|---|---|---|
| 1 | **Curated overrides** | `production-environment/sillage-core/data/image_overrides.json` |
| 2 | **Cross-vendor EAN fill** | Another vendor's offer image for the same EAN in `sil_offers` |

The override file is built *offline* by the steps below. Populate it in source priority order so
earlier, higher-quality sources win when keys collide (merge scripts never clobber existing keys).

**After any merge:** copy `image_overrides.json` onto the VPS bind-mount
(`~/sillage/sillage-core/data/image_overrides.json`), **recreate** `sillage-core` / `sillage-cron`
(the override map is cached in-process), mark affected products dirty, then:

```bash
# Content path — required when only the override URL changed (hashes include imageUrl).
docker exec sillage-core bun run sync -- --mode=full --source=cache --rewrite-only
```

`--mode=fast --rewrite-only` only selects `needs_price_write` and will skip an image-only dirty
mark. Fast still writes `_external_thumbnail_url` when a **price/visibility** hash changes (for
example un-hiding after a photo appears) — mark `needs_price_write=1` if you take that path.

---

## Step 1 — wholesale-perfumes.eu catalog XML (`flask_front`)

The wholesaler is vendor `wholesale-perfumes` (SKU prefix `WPF`). Its catalog XML includes
`pictures/flask_front` URLs — use these as the first-choice image source for WPF products and for
any EAN that appears in the feed.

1. Fetch or replay the catalog (live token auth or local fixture — see vendor connector / `fetch_wholesale_perfumes.py`).
2. Extract EAN → `flask_front` URL pairs (`enrich.py --fetch-wholesale-perfumes`).
3. **Host on the images CDN** — `host_override_images.py --host images.elsvc.net` downloads override CDN URLs into `ecom_sites/data/media/` and rewrites keys to `LPS_MEDIA_BASE_URL` / `PUBLIC_URL_BASE` (see [Hosting](#hosting-lps-media--images-cdn)).
4. Merge EAN → public URL into `image_overrides.json` (do not overwrite existing keys).

The Python enricher under `production-environment/python-analysis/` already owns much of this path
for BeautyFort rows; follow the same merge → sync loop.

---

## Step 2 — oceanfragrances CSV

**"Ocean" = this CSV only:** `python-analysis/.../products/oceanfragrances.csv`.

Image-only index: EAN → external image URL. Not a vendor, not wholesale-perfumes.eu.

1. Read the CSV (EAN + image URL columns).
2. Download or link URLs as needed; prefer hosting copies on the images CDN when URLs are fragile.
3. Merge into `image_overrides.json` (skip keys already set by step 1).

---

## Step 3 — Brasty photos already on the VPS (preferred when files exist)

Brasty is an **image source only** — no vendor row, no catalogue sync, no orders. Photos match
products by **EAN alone**.

Live dump on `ovhe`:

| Path | Contents |
|---|---|
| `/home/ubuntu/brasty/in_stock` (and `out_of_stock`, `sale`, `new`, `back_in_stock`, `hot_deals`) | Zero-padded EAN `.jpg` filenames |

Matcher: `production-environment/python-analysis/beautyfort-enriched/fill_missing_shop_images.py`.

It walks BeautyFort **and** BTS shop rows whose resolved URL is empty / placeholder / BeautyFort
`/pic/` / BTS `no_image.webp`, then fills in this order (never clobbering an existing override
key): existing `image_overrides.json` → Brasty EAN file → `oceanfragrances.csv` → Shopify
`products_export_1.csv`.

**Brasty camera placeholders are not photos.** About 1,200 files in the dump are the same
graphic (grey camera, “BRASTY / BRANDED STYLE”, green bar) saved as `EAN.jpg` (often WebP
bytes). Example: `https://images.prinscosmetic.eu/8809598454323.jpg`. Matcher skips them by
MD5 (`brasty_placeholders.py`). Never copy those onto the CDN. If one is already in
`image_overrides.json` / `~/ecom_sites/data/media/`, delete the file, drop the override
keys, recreate core/cron, and **full** rewrite-only so hide-without-image applies again.

1. Export products that still lack a usable photo (dashboard Products JSON or SQL dump).
2. Run the matcher; copy Brasty hits into `~/ecom_sites/data/media/` (CDN
   `https://images.prinscosmetic.eu/<original-stem>.jpg`).
3. Merge the delta into `sillage-core/data/image_overrides.json` on the VPS **and** in git.
4. Recreate core/cron, then **full** rewrite-only (see [After overrides change](#after-overrides-change)).

---

## Step 3b — Brasty (Playwright scrape)

Use this when the VPS dump does not contain the EAN. Tool location:
**`tools/images/brasty/`** (standalone Node + Playwright; not a `sillage-core` dependency).

### Site constraints

- **No product detail pages.** Products exist only in a searchable logged-in list.
- **Hover for the large image**, not the row thumbnail. The preview mechanism must be verified —
  do not guess selectors.
- Always download the **original largest file** from its URL (HTTP GET). Never screenshot or crop
  the preview element.

### Operator flow

```bash
cd tools/images/brasty
cp .env.example .env          # BRASTY_EMAIL, BRASTY_PASSWORD, paths — never commit
npm install
npx playwright install --with-deps chromium   # once per host

npm run login                 # headless → storageState.json (gitignored)
npm run investigate           # evidence gate — see findings/
# implement ExtractionStrategy in src/imageExtractor.ts from findings
npm run download              # CSV / targeted EANs
npm run crawl-catalog         # full IN STOCK list (~14k); resume-safe; prefer laptop
npm run watermark             # optional LPS logo → watermarked/
npm run build-overrides       # merge into sillage-core/data/image_overrides.json
```

### Brasty rules (non-negotiable)

| Rule | Detail |
|---|---|
| Login | `BRASTY_EMAIL` / `BRASTY_PASSWORD` in gitignored `.env` |
| Session | `npm run login` writes `storageState.json`; `ensureSession()` re-logins headlessly on expiry |
| Scope | **List rows only** — search by EAN, match exactly one row, verify row EAN before save |
| Extraction | **Hover → large preview URL** — not the thumbnail; strategy must come from `investigate` findings |
| Rate limits | Default `CONCURRENCY=1`, `POLITENESS_DELAY_MS=1500`; do not raise on VPS — blocked account > slow crawl |
| Resume | Append-only `logs/manifest.jsonl`; safe to restart |
| Output | `output/EAN.jpg` → optional watermark → **`build-overrides` → `image_overrides.json`** |
| Cookie banner | Dismiss before clicking "Log in" — banner intercepts clicks if ignored |

Full script reference: `tools/images/brasty/README.md`. Deep implementation task:
`S3-remaining-work.md` §3 Task 1.

---

## Step 4 — cross-vendor EAN fill (automatic at sync)

No manual step. During every full and fast sync, `buildImageLookup()` in
`sillage-core/src/sync/images.ts` fills a missing, placeholder, or weak vendor thumb from **another
vendor's offer** with the same EAN in `sil_offers`.

This runs after overrides are loaded. It cannot beat a curated override URL but covers gaps when
only one vendor ships a real photo.

---

## Hosting (`lps-media` / images CDN)

Product images are **external URLs** — WordPress never creates attachments. Host scraped or
watermarked files outside `data/wp/`:

1. **Host directory** (bind-mount, not a Docker named volume):
   `production-environment/ecom_sites/data/media/`
2. Dedicated **`lps-media`** container (`nginx:alpine`) mounts that path read-only as its
   document root (`/usr/share/nginx/html`). No PHP, no DB, no WooCommerce.
3. **Preferred public URLs:** `https://images.<domain>/<file>` (root of the media container).
   - VPS: host Caddy site `images.prinscosmetic.eu` → `127.0.0.1:105` (`lps-media`)
   - Deploy with `--images images.example.com` (optional Porkbun A via `--dns`)
4. **Fallback path** (unchanged): `https://<shop>/lps-media/<file>`
   - Local compose: `shop-gateway` (Caddy) `handle_path /lps-media/*` → `lps-media`
   - VPS: shop site still has `handle_path /lps-media/*` → `:105`
5. `ecom` does **not** mount or Alias media — Apache never serves product images.
6. **Configurable base URL** (no code change to flip hosts later):
   - Dashboard / `sil_settings.image_cdn_base_url` (default `https://images.prinscosmetic.eu`)
   - Tool env (first match): `LPS_MEDIA_BASE_URL` → `IMAGE_HOST_BASE_URL` → `PUBLIC_URL_BASE`
   - Host scripts (`host_override_images.py`, Brasty `build-overrides`) write absolute URLs like
     `https://images.prinscosmetic.eu/<EAN>.jpg`
   - Changing the base does **not** rewrite WooCommerce rows by itself: update
     `image_overrides.json` (re-run host tools or a bulk replace), set the setting/env, then
     `bun run sync -- --rewrite-all`

Drop new files onto the host `data/media/` path; nginx serves them immediately (read-only mount).

Brasty watermark asset: `tools/images/brasty/assets/lps-logo.png`.

---

## After overrides change

1. Copy/host any new files under `data/media/` if using self-hosted URLs.
2. Recreate `sillage-core` and `sillage-cron` so `loadImageOverrides()` re-reads the JSON
   (in-process cache; `compose up -d` on already-running containers is not enough).
3. Mark the filled EANs dirty (`needs_content_write=1` on `sil_products` via `sil_offers.primary_ean`
   / `eans`), then **`bun run sync -- --mode=full --source=cache --rewrite-only`**.
   `--rewrite-all` also works but rewrites the whole catalogue.
   Fast rewrite-only ignores `needs_content_write`.
4. Check sync summary `hiddenNoImage` if `hide_products_without_image` is on (default).
   Products still without a usable photo stay **Hidden · no image** on the dashboard Products
   table and `exclude-from-catalog` on the shop. Do not turn hide-without-image off shop-wide
   to unhide one SKU.

---

## Tool layout (`tools/images/`)

| Path | Purpose |
|---|---|
| `tools/images/brasty/` | Brasty Playwright scrape (this playbook §3) |
| `production-environment/python-analysis/` | Bulk EAN match: Brasty VPS dump, oceanfragrances, Shopify, enricher sandbox |
| `production-environment/sillage-core/data/image_overrides.json` | Canonical EAN → URL map consumed at sync |
| `production-environment/sillage-core/src/sync/images.ts` | Override load + cross-vendor fill |

Do **not** move or duplicate sync-time image logic out of `sillage-core`; tools only feed
`image_overrides.json`.

---

## Verification

```bash
cd production-environment/sillage-core
bun run typecheck
bun test

cd ../../tools/images/brasty
npm run typecheck
```

For Brasty work: trial-run 10–20 EANs, inspect output URLs, then scale on **`ovhe`** — not
production **`ovh`** unless read-only inspection.
