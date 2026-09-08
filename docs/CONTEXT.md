# CONTEXT — canonical facts

Everything here was verified against the live stack. Trust this file over your assumptions about
how WordPress and WooCommerce normally behave; several things in this install are not the default.

---

## 1. Running infrastructure

One Docker Compose project: `production-environment/compose.yaml` + one `.env`.

| Container | Image | Role | Ports |
|---|---|---|---|
| `shop-gateway` | `caddy:2-alpine` | Local edge only (`--profile local`). VPS uses host Caddy. | `80:80` (local) |
| `ecom` | `unseencurtain/sillage-wordpress:<tag>` | Retail storefront | `127.0.0.1:104→80` |
| `wholesale-ecom` | same WordPress image | Wholesale storefront (`--profile wholesale`) | `127.0.0.1:106→80` |
| `lps-media` | `nginx:alpine` | Static product images only | `127.0.0.1:105→80` |
| `ecom-db` | `mariadb:latest` (**MariaDB 12.3.2**) | **Retail** MariaDB only (`earth`, `sillage`) | `127.0.0.1:3307:3306` |
| `wholesale-db` | same MariaDB image | **Wholesale** MariaDB (`earth_wpf`, `sillage_wpf`) | `127.0.0.1:3308:3306` |
| `valkey` | `valkey/valkey:8-alpine` | Object cache. Shared on ovhe only (retail db 0, wholesale prefix `wholesale:` / db 1) | internal only |
| `sillage-core` | `unseencurtain/sillage-core:<tag>` | Retail API + dashboard | `127.0.0.1:4000→4000` |
| `sillage-cron` | same image as sillage-core | Retail sync scheduler | internal only |
| `wholesale-core` | same image as sillage-core | Wholesale API + dashboard (`SILLAGE_PROFILE=wholesale`) | `127.0.0.1:4001→4000` |
| `wholesale-cron` | same image | Wholesale sync scheduler | internal only |

Networks are **external** and must exist before `docker compose up`:
`ecom_network` (ecom ↔ ecom-db ↔ sillage-core ↔ lps-media ↔ shop-gateway) and
`redis_network` (ecom ↔ valkey ↔ sillage-core).

**Product images (CDN / `lps-media`).** Host directory `production-environment/ecom_sites/data/media/`
(on VPS: `~/ecom_sites/data/media`) is bind-mounted read-only into `lps-media` at
`/usr/share/nginx/html` (never a named/anonymous Docker volume). Preferred public URLs are
`https://images.<domain>/<file>` (Caddy site → `lps-media` document root). The CDN
does not list files, does not advertise nginx’s version on 404s, and only serves
image extensions. Shop path
`https://<shop>/lps-media/<file>` remains a fallback (`handle_path` strips the prefix). Locally
`shop-gateway` serves `/lps-media/*` the same way. WordPress/`ecom` does not serve these files.
Sync stores absolute URLs only (`_external_thumbnail_url` / `image_overrides.json`). New image
URLs come from tool env `LPS_MEDIA_BASE_URL` / `PUBLIC_URL_BASE` (default
`https://images.prinscosmetic.eu`). Settings `image_cdn_base_url` is on the dashboard and
hot-applied into Bun runtime via `applyRuntimeUrls`; it does **not** by itself rewrite URLs
already written on products — use overrides + a content rewrite.

```bash
docker network create ecom_network
docker network create redis_network
cp production-environment/.env.example production-environment/.env
cd production-environment && docker compose --env-file .env up -d
```

Compose: `production-environment/compose.yaml`. Env template: `production-environment/.env.example`.
Legacy `ecom_sites/compose.yaml` and `redis/compose.yaml` are thin includes only.

**Live VPS:** SSH `ovhe` (`ubuntu@139.99.61.71`, hostname `ovh-experi`) — shop
`prinscosmetic.eu`, dashboard `sillage.prinscosmetic.eu`, images `images.prinscosmetic.eu`.
App dir `~/sillage/`; data at `~/ecom_sites/data/`. Use `mariadb.vps.cnf` (1G buffer pool) —
WordPress, Valkey, Bun and MariaDB share ~4 GB RAM. SSH `ovh` (`51.79.255.226`) is empty/unused.
Resume context: [`HANDOFF.md`](HANDOFF.md).

One image, one role per container. `sillage-core` runs supercronic; the dashboard service overrides
`command` to run the API instead. A full sync must never be able to stall the dashboard, and either
container has to be restartable on its own.

Two things about supercronic that cost time to rediscover:

- The `CMD` must use the **absolute** path `/usr/local/bin/supercronic`. As PID 1 it re-execs itself
  to install a process reaper, using `argv[0]` with no `PATH` lookup, so a bare `supercronic` dies
  instantly with `Failed to fork exec: no such file or directory`.
- `FIXTURES_DIR` in `.env` is relative to the host checkout. The compose file overrides it to
  `/app/.feedscratch`, which is where the bind mount actually lands inside the container.

### Tooling gaps — plan around these

- The `ecom` / `wholesale-ecom` containers have **no WP-CLI** and **no mysql/mariadb client binary**. They have `php` and `curl`. Anything that needs WordPress bootstrapped goes through the plugin's REST endpoints.
- Apache inside those containers runs as **www-data (uid 33)** against a host bind-mount. `wp-content` must be owned by uid 33 or wp-admin Updates fail with `Could not create directory.: /var/www/html/wp-content/upgrade`. Fix: `scripts/fix-wp-content-perms.sh`. Do not leave `wp-content` as `ubuntu:ubuntu`.
- `ecom-db` has no `docker compose` healthcheck dependency from `sillage-core`; the app retries.

---

## 2. Databases

Two MariaDB **servers**. Retail and wholesale do **not** share a database process.

| Database | Server | Owner | Purpose |
|---|---|---|---|
| `earth` | `ecom-db` | WordPress (`lime`) | Retail WordPress + WooCommerce. Prefix `wp_` |
| `sillage` | `ecom-db` | sillage-core (`sillage`) | Retail engine. Prefix `sil_` |
| `earth_wpf` | `wholesale-db` | WordPress (`lime`) | Wholesale WordPress + WooCommerce |
| `sillage_wpf` | `wholesale-db` | sillage-core (`sillage`) | Wholesale engine. Lock prefix `sillage-wholesale:` |

Credentials are **not** in this file. They live in:
- `production-environment/.env` — **single** file for MariaDB, WordPress, sillage-core, vendors, Hub image tags, domains (gitignored; template `.env.example`)
- VPS: `~/sillage/.env` (same shape; compose `--env-file .env`)
- Local-dev only: `sillage-core/.env` for host-side `bun run`; `ecom_sites/.env` / `redis/.env` are deprecated leftovers — safe to delete once `~/sillage/.env` (or root `.env`) is in use

Always fully qualify cross-database table names (`earth.wp_posts`, `sillage.sil_offers`). Never
rely on a pooled connection's default schema, because `USE` state leaks between reused connections.

### Grants

`sillage` has `ALL` on `sillage.*` and **no DDL** on `earth` — only DML on this exact table list:

```
wp_posts  wp_postmeta  wp_terms  wp_termmeta  wp_term_taxonomy  wp_term_relationships
wp_wc_product_meta_lookup  wp_wc_product_attributes_lookup  wp_wc_category_lookup
```
plus `SELECT` on `wp_options`, `wp_wc_orders`, `wp_wc_order_addresses`,
`wp_wc_order_operational_data`, `wp_woocommerce_order_items`, `wp_woocommerce_order_itemmeta`.

Nothing on `wp_users`, `wp_usermeta`, or writes to `wp_options`.

`lime` (WordPress) gets `SELECT` on exactly the sillage tables the plugin reads:

```
sillage.sil_ean_index
sillage.sil_settings
sillage.sil_vendors
```

Granted by `ecom_sites/bootstrap-sillage.sh` and `scripts/deploy-vps.sh` / `vps-bootstrap.sh`
after migrate (table-level `GRANT` requires the tables to exist). `config/sillage-grants.sql`
documents the sillage-core user only; the lime grants stay in those post-migrate scripts.

### MariaDB tuning

`production-environment/ecom_sites/config/mariadb.cnf` is mounted into `ecom-db`. The stock
defaults (128 MB buffer pool, 16 MB packet) are too small for a 52k-product import.

---

## 3. WooCommerce 11.0.0 — the parts that differ from what you expect

Verified on the live database. Getting any of these wrong produces a store that looks fine and is
subtly broken.

### HPOS is enabled

`woocommerce_custom_orders_table_enabled = yes`. Orders live in `wp_wc_orders`,
`wp_wc_order_addresses`, `wp_wc_order_operational_data`, `wp_wc_orders_meta` — **not** in
`wp_posts` as `shop_order`. Line items are still in `wp_woocommerce_order_items` /
`wp_woocommerce_order_itemmeta`.

Note `wp_wc_orders_meta.meta_value` is `TEXT` (~64 KB), not `LONGTEXT` like `wp_postmeta`.

### Native brands taxonomy

`product_brand` exists (WooCommerce 9.4+). Vendor brand/manufacturer maps there. Do **not** invent
a custom brand taxonomy.

The name is **singular**. `product_brands` is not registered, and WordPress will accept term rows
written to an unregistered taxonomy without complaint — `get_the_terms()` then returns a `WP_Error`
and every brand archive, filter and coupon rule silently sees nothing. Confirm with
`get_object_taxonomies( 'product' )` rather than assuming.

### Native GTIN field

`wp_wc_product_meta_lookup.global_unique_id` and postmeta `_global_unique_id` are WooCommerce's
GTIN/UPC/EAN/ISBN field. Writing the primary EAN there gives wp-admin EAN search and schema.org
markup for free. It does not replace `sil_ean_index`, which exists because BeautyFort products can
carry up to 26 EANs each.

### Derived tables you must maintain by hand

Because we bypass WooCommerce's CRUD layer, nothing updates these for us:

| Table | Breaks if stale |
|---|---|
| `wp_wc_product_meta_lookup` | Price sorting, stock filters, catalog queries |
| `wp_wc_product_attributes_lookup` | Attribute/layered-nav filters return nothing |
| `wp_wc_category_lookup` | Category counts and hierarchical filtering |
| `wp_term_taxonomy.count` | Displayed term counts |
| `wp_blocksy_product_taxonomies_lookup` | Blocksy theme filters (regenerated via finalize hook) |

### Product visibility term IDs on this install

`term_id` currently equals `term_taxonomy_id`, but **do not hardcode these** — query
`taxonomy='product_visibility'` at the start of each run and cache in memory.

| slug | id |
|---|---|
| exclude-from-search | 6 |
| exclude-from-catalog | 7 |
| featured | 8 |
| outofstock | 9 |

### Other live settings

- `woocommerce_currency` — set to `EUR` by the infra step (was `USD`)
- Theme: `blocksy`. Active plugins: woocommerce, blocksy-companion-pro, elementor, fluentform
- Existing global attributes: `pa_volume`, `pa_skin-condition`. We add `pa_gender`, `pa_type`
- `product_tag` taxonomy is not registered
- Store started with 13 demo products — effectively a clean slate

---

## 4. Writing products — rules that matter

- **Slugs are deterministic:** `slugify(name).slice(0, 180) + '-' + sku.toLowerCase()`. Unique by
  construction because SKU is unique, so no check-then-suffix round trips and re-runs are
  idempotent. Category slugs are few enough to use collision suffixing.
- **`wp_postmeta` has no unique key** on `(post_id, meta_key)`, so `ON DUPLICATE KEY UPDATE` is not
  available. Delete our managed keys for the post, then bulk insert. Do not add a unique index to
  a WordPress core table.
- **`_product_attributes` is PHP-serialized**, not JSON. Use the `php-serialize` package.
- **Never set `_thumbnail_id`.** There are no attachments; images are external URLs rendered by a
  plugin filter. Vendor image URLs are stored and emitted byte-for-byte. The plugin makes a product
  report *its own post ID* as its thumbnail ID and resolves that ID to the vendor URL — see
  decision 14b. Both vendors ship exactly one image per product, so there is no gallery.
- **`wp_wc_product_meta_lookup.stock_quantity` is `double`**, and the table does support real
  upsert on its `product_id` primary key.
- **EANs are strings.** Never cast to int — 12% of BTS EANs and 2,854 BeautyFort EAN tokens have
  leading zeros.
- **`max_allowed_packet` caps a single statement.** Build multi-row INSERTs against a byte budget,
  not a fixed row count.
- Batch inside explicit transactions. One transaction per batch, not per run and not per row.

---

## 5. `sillage-bridge` — the plugin's complete job list

This is a closed list. If a task seems to require adding write logic here, it belongs in Bun.

1. Resolve external product images from `_external_thumbnail_url` through the attachment filters
   (`post_thumbnail_id`, `woocommerce_product_get_image_id`, `image_downsize`). Also override
   Blocksy live-search `ct_featured_media` — modern WP's `wp_get_attachment_url()` returns false
   before filters when the ID is not `post_type=attachment`, so product stand-in IDs never reach
   our URL filter in `/wp/v2/search?ct_live_search=true`
2. Short-circuit EAN-shaped searches to `sillage.sil_ean_index`
3. `POST /wp-json/sillage/v1/finalize` — WooCommerce cache-version bump, theme lookup regen
4. `POST /wp-json/sillage/v1/order-update` — write vendor tracking/status back through the
   WooCommerce order API
5. Fire an HMAC-signed webhook to sillage-core when an order reaches a dispatchable status
6. On activation: register `pa_gender` / `pa_item-type` / `pa_volume` via `wc_create_attribute()`
7. A read-only wp-admin status page linking to the dashboard
8. Apply the small-order cart fee (global `cart_min_*`) and hard-block cart/checkout when a
   vendor subtotal is below that vendor's `order_config.min_order_value_eur` (storefront-label
   shortfall message on retail; wholesale profile uses a “minimum order €X” notice). Same
   cart/checkout path for BF/BTS plus per-vendor MOQ. Wholesale shop seeds **€300**.
9. Catalog helpers for the **LPS retail** shop (BF/BTS): enforce WooCommerce catalog visibility
   (`exclude-from-catalog`), strip legacy LPS* cats from widgets/`get_terms`/nav, hide empty
   feed cats, rebuild Blocksy's taxonomy lookup via SQL on finalize (BF/BTS only), replace
   Blocksy's flat product_cat Ajax filter with `[sillage_shop_categories]` (top-level feed
   browse roots; counts from `wp_term_taxonomy` — WooCommerce's `wc_change_term_counts` zeroes
   `get_terms()` outside a product loop), and replace Blocksy's logo-mode brand filter
   (`showLabel:false`, often mis-set to unregistered `product_brands`) with
   `[sillage_shop_brands]` (names + counts, scrollable). Optional image-safety CSS. Vendor
   lanes are never `product_cat` and never a visible `pa_vendor` attribute — use `_sillage_vendor`
   postmeta only. The **wholesale** WordPress (`earth_wpf`) uses the same plugin with
   `SILLAGE_STOREFRONT_PROFILE=wholesale` and `SILLAGE_DB=sillage_wpf`. WPF on the retail
   install is parked via `product_visibility` from sillage-core. See [`WHOLESALE-SITE.md`](WHOLESALE-SITE.md).
10. **SEO** — Bun writes static sitemaps (`src/sync/sitemaps.ts`, Caddy serves
    `/wp-sitemap*.xml` + `/robots.txt`). PHP (`Sillage_Seo`) only **disables** core
    WP sitemaps and sends `noindex` on hidden product HTML. Do not query the
    catalogue in PHP for Google. Fast sync (dashboard **Minutes between syncs**)
    does not rebuild sitemaps.

**The plugin must not depend on the active theme.** Blocksy today; target **Kadence**. Theme-aware
code is allowed only as a guarded, additive shim that no-ops elsewhere.

All configuration lives in the sillage-core dashboard, not in wp-admin.

---

## 5b. Scheduling

`crontab` holds a single five-minute tick. It does **not** encode the cadence — `src/sync/schedule.ts`
reads that from `sil_settings` on every tick and decides what, if anything, is due. Changing the
cadence is a settings edit, not a rebuild.

| Setting | Default | Meaning |
|---|---|---|
| `sync_enabled` | `1` | Schedule kill switch. Manual Update works when off and does not turn this back on |
| `fast_sync_minutes` | `30` | Schedule cadence; kept equal to `live_feed_min_minutes` from Settings |
| `live_feed_min_minutes` | `30` | Per-vendor call interval. Daily download counters are recorded but never block |
| `full_sync_enabled` | seed `0`; **live shop `1`** | Routine once-per-day full import (new SKUs + WP categories). Keep on. Incremental 30-min checks still run. Sync → Rebuild remains the manual escape |
| `schedule_timezone` | `UTC` (live: `Asia/Dhaka`) | IANA zone for interpreting `full_sync_hour` and dashboard clocks |
| `full_sync_hour` | `3` (live: `23`) | Hour of day (0–23) in `schedule_timezone`. One attempt after this hour |
| `sync_source` | `live` | `live` hits vendors (no silent disk fallback when gated); `local` = fixtures; `cache` = rewrite-only internal |

Rules, all evaluated by the database so no clock skew is possible:

- The fast cadence measures from the last run of **either** mode. A full sync refreshes every price,
  so a fast sync two minutes later would be wasted work.
- Overlap is handled by the `GET_LOCK` advisory lock in `runSync` (`sillage:sync` on retail,
  `sillage-wholesale:sync` on wholesale), not by the scheduler.
- The full sync is attempted **once per day**, counting attempts rather than successes. A failure is
  surfaced on the dashboard for a deliberate retry instead of retrying every tick for 20 hours.

Manual escape hatches on `bun run sync`: `--redrive` re-marks products a previous run errored on,
and `--rewrite-all` clears the applied hashes so every product is rewritten. Offer hashes cover
vendor feed data only — a multiplier/tier change would look like “nothing changed” without an
explicit dirty mark. Dashboard Settings/Vendors Save marks dirty and kicks rewrite-only (prices)
or full/cache (description/volume). CLI: `--mode=fast --source=cache --rewrite-only`. Advisory
lock must use one dedicated pool connection (`GET_LOCK` is connection-scoped); see
[`HANDOFF.md`](HANDOFF.md) 2026-08 notes if Save queues forever.

---

## 6. Vendors

Operator roadmap and live-host facts: [`HANDOFF.md`](HANDOFF.md).

### Vendors versus image sources — read this before adding anything

Getting this wrong has already cost a rename. Two different kinds of external system exist and they
are **not** interchangeable.

A **vendor** is a supplier we buy from. It has a row in `sil_vendors`, a `VendorConnector`, a SKU
prefix, stock and prices, and an order path that spends real money. **There are exactly three in
code, and adding a fourth is a deliberate decision, not a side effect of finding a new feed.**

**Retail (`prinscosmetic.eu`) sells BeautyFort + BTS only.** Wholesale-perfumes is **parked** on
that WordPress (`PARKED_B2B_VENDOR_SLUGS`, excluded from retail `--vendor=all`).

**Wholesale (`wholesale.mirainikki.xyz`) sells wholesale-perfumes only** — same repo, compose
profile `wholesale`, `SILLAGE_PROFILE=wholesale`. BeautyFort + BTS are parked there. Dispatch is
sandbox-locked. The old [sillage-b2b](https://github.com/unseencurtain/sillage-b2b) tree is
**not** the live shop (`b2b-wholesale/` here is only a pointer). See [`WHOLESALE-SITE.md`](WHOLESALE-SITE.md).

| Vendor | Slug | SKU prefix | Storefront label | Retail shop | Wholesale shop |
|---|---|---|---|---|---|
| BTS Wholesaler | `bts` | `BTS` | LPS01 | **Yes** — REST + JWT | Parked |
| BeautyFort | `beautyfort` | `BF` | LPS02 | **Yes** — SOAP v4 | Parked |
| wholesale-perfumes.eu (SoleLuna spol. s.r.o.) | `wholesale-perfumes` | `WPF` | Wholesale | Parked | **Yes** — €300 MOQ, sandbox dispatch |

An **image source** only ever produces `EAN → image URL` pairs. It has no vendor row, no connector,
no stock, no prices and no order path. Images are matched to products by EAN alone, so any source
can illustrate any vendor's product.

| Image source | Where | Notes |
|---|---|---|
| oceanfragrances | `python-analysis/.../products/oceanfragrances.csv` | **This — and only this — is what "ocean" means.** A CSV. Not a vendor. |
| Brasty | Was VPS `~/brasty/` (removed 2026-09-03). Needed missing-SKU files copied to `~/ecom_sites/data/media/`. Tool `tools/images/brasty/` remains in git. Skip camera placeholders (`brasty_placeholders.py`). Not a supplier |
| Shopify export | `python-analysis/.../products/products_export_1.csv` | Historic export (`Variant Barcode` → `Image Src`) |
| Cross-vendor | `sil_offers` | One vendor's photo filling another's product, by EAN |
| wholesale-perfumes catalog XML | its `pictures/flask_front` | The one system that is *both* a vendor and an image source |

Naming rules, because these have been confused before:

- **Never call wholesale-perfumes.eu "ocean".** "Ocean" means oceanfragrances, the image CSV.
- Its credential is an **API token** from the portal user settings, used as the HTTP Basic password
  with the account email. There is no separate Sillage password for it.
- Its SKU prefix is `WPF`, not `WP` — `wp` means WordPress everywhere else in this codebase.

### Vendor API details

| | BeautyFort | BTS Wholesaler |
|---|---|---|
| Protocol | SOAP v4 over HTTPS | REST + JWT bearer |
| Endpoint | `https://www.beautyfort.com/api/soap/v4` | `https://api.btswholesaler.com/v1/api` |
| Auth | `base64(sha1(nonce + createdAt + secret))`, **fresh nonce per request** | `Authorization: Bearer <JWT>` |
| Catalog | `GetStockFile` → base64 JSON, whole file, no pagination | `getListProducts` paginated, 500/page |
| Delta | none — diff the full file locally | `getProductChanges(since)`, max 30 days |
| Products | 9,209 | 46,111 |
| Currency | EUR | EUR |
| Ships to | BE DE ES IT NL PT SE (7) | 25 EU + CH GB MC (28) |
| Shipping cost | Fixed table per country, €7.15–€10.65 | Live quote via `getShippingPrices` |
| Order flow | 4 steps: create → addItem × n → place | 1 step: `setCreateOrder` |
| Idempotency key | `yourOrderReference`, unique across test+live | **none available** |
| Sandbox | none (`mode: false` is live) | none |

Reference implementations are in `product-dropshipping/` and are **read-only**. The ported,
bug-fixed versions live in `sillage-core/src/vendors/`.

### Two bugs fixed during the port — do not reintroduce

1. BeautyFort decoded its base64 stock file with `atob()`, which is byte-wise and corrupts UTF-8
   (`Reisegröße` → `ReisegrÃ¶Ãe`). Use `Buffer.from(b64, 'base64').toString('utf8')`.
2. BeautyFort generated its auth nonce once in the constructor, so the second call on an instance
   failed with `Invalid credentials`. Generate nonce and timestamp per request.

### Order API quirks

- **BTS stock / shipping / create-order key products by EAN**, not by the numeric `id` used in the
  catalogue. Passing the internal id returns `not_found` / `product_error`. The adapter uses
  `primary_ean`.
- **BeautyFort has no stock-check endpoint.** Stock is verified against `sil_offers`, which the
  30-minute sync keeps fresh.
- **wholesale-perfumes cart `code` is the catalog product `id`** (not EAN). Cart is account-global;
  dry-run must not touch it. JSON responses use application-level `error` (0 = OK) on HTTP 200;
  see [sillage-b2b API notes](https://github.com/unseencurtain/sillage-b2b/blob/main/docs/wholesale-perfumes-api.md).
  Not used on this retail shop while parked.
- **Neither live retail vendor has a sandbox.** `orders_dry_run` defaults to `1` and
  `orders_auto_dispatch` to `0`. A live submit requires both an explicit `--live` (or setting
  change) and `--force` / auto-dispatch.

---

## 7. Offline development

`.feedscratch/` holds the real feeds. `--source=local` reads them instead of calling the vendors,
so the entire pipeline can be built and tested with zero API calls and zero risk.

| File | Contents |
|---|---|
| `beautyfort_full.json` | 9,209 products, 3.5 MB |
| `bts_products_full.json` | 46,111 products, 22.3 MB |
| `bts_categories_full.json` | 4,103 category nodes |
| `bts_countries.json`, `bts_feedstatus.json`, `bf_account.json` | Supporting reference data |

See `DATA-PROFILE.md` for field-level statistics and `DECISIONS.md` for why things are the way
they are.
