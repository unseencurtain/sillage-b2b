# CONTEXT — canonical facts (wholesale-perfumes shop)

Everything here was verified against the live wholesale stack. Trust this file over assumptions
about how WordPress and WooCommerce normally behave.

Retail BeautyFort + BTS lives in [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).

---

## 1. Running infrastructure

One Docker Compose project: `production-environment/compose.yaml` + one `.env`.
Project name: `sillage-wholesale`. Hub image: `unseencurtain/sillage-b2b:<sha>`.

| Container | Image | Role | Ports |
|---|---|---|---|
| `wholesale-ecom` | `unseencurtain/sillage-wordpress:<tag>` | Wholesale storefront | `127.0.0.1:106→80` |
| `wholesale-db` | `mariadb:latest` | MariaDB (`earth_wpf`, `sillage_wpf`) | `127.0.0.1:3308:3306` |
| `wholesale-valkey` | `valkey/valkey:8-alpine` | Object cache (this shop only) | internal |
| `wholesale-core` | `unseencurtain/sillage-b2b:<tag>` | API + dashboard | `127.0.0.1:4001→4000` |
| `wholesale-cron` | same as wholesale-core | Sync scheduler | internal |

Networks are **external** and must exist before `docker compose up`:
`ecom_network` and `redis_network`.

```bash
docker network create ecom_network
docker network create redis_network
cp production-environment/.env.example production-environment/.env
cd production-environment && docker compose --env-file .env up -d
```

**Live VPS:** SSH `ovhe` (`ubuntu@139.99.61.71`). Shop `https://wholesale.mirainikki.xyz`,
dashboard `https://sillage-wholesale.mirainikki.xyz`. App dir `~/sillage/` (or the wholesale
checkout). Independent Valkey `wholesale-valkey` — do not share MariaDB with retail.

Profile is always wholesale. `resolveDispatchDryRun()` always returns `true`.

### Tooling gaps

- The `wholesale-ecom` container has **no WP-CLI** and **no mysql/mariadb client**. Use `php` / `curl` / plugin REST.
- Apache runs as **www-data (uid 33)** against a host bind-mount.
- `supercronic` must use the absolute path `/usr/local/bin/supercronic`.

---

## 2. Databases

One MariaDB server: `wholesale-db`.

| Database | Owner | Purpose |
|---|---|---|
| `earth_wpf` | WordPress (`lime`) | WooCommerce. Prefix `wp_` |
| `sillage_wpf` | sillage-core (`sillage`) | Engine. Prefix `sil_`. Lock prefix `sillage-wholesale:` |

Credentials live in `production-environment/.env` (gitignored). Always fully qualify
cross-database table names (`earth_wpf.wp_posts`, `sillage_wpf.sil_offers`).

`sillage` has DML on Woo tables listed in older grants scripts; PHP never writes products.
`lime` gets `SELECT` on `sillage_wpf.sil_ean_index`, `sil_settings`, `sil_vendors`.

---

## 3. WooCommerce 11 — the parts that differ

### HPOS is enabled

Orders live in `wp_wc_orders`, `wp_wc_order_addresses`, `wp_wc_order_operational_data`,
`wp_wc_orders_meta` — **not** in `wp_posts` as `shop_order`.

### Native brands taxonomy

`product_brand` (singular). Do not invent a custom brand taxonomy.

### Native GTIN field

`_global_unique_id` / `wp_wc_product_meta_lookup.global_unique_id`. Extra EANs still live in
`sil_ean_index`. EANs are strings — never cast to int.

### Derived tables Bun must maintain

`wp_wc_product_meta_lookup`, `wp_wc_product_attributes_lookup`, `wp_wc_category_lookup`,
`wp_term_taxonomy.count`, `wp_blocksy_product_taxonomies_lookup` (finalize hook).

Vendor identity is `_sillage_vendor` postmeta only — never `product_cat` lanes, never visible `pa_vendor`.

---

## 4. Writing products

- **Bun writes products via raw SQL; PHP never does.**
- Slugs are deterministic: `slugify(name).slice(0, 180) + '-' + sku.toLowerCase()`. SKU prefix `WPF-`.
- Never set `_thumbnail_id`. Images are `_external_thumbnail_url`.
- Hide-without-image: empty / `None` / placeholder URLs get `exclude-from-catalog` + `exclude-from-search`.
- SKU is `{PREFIX}-{vendor_product_id}` (`WPF-12345`).

---

## 5. `sillage-bridge` — complete job list

Closed list. Product writes belong in Bun.

1. Resolve `_external_thumbnail_url` through attachment filters
2. Short-circuit EAN-shaped searches to `sil_ean_index`
3. `POST /wp-json/sillage/v1/finalize` — Woo cache bump, theme lookup regen
4. `POST /wp-json/sillage/v1/order-update` — tracking/status into HPOS
5. HMAC webhook to sillage-core when an order is dispatchable
6. On activation: register `pa_gender` / `pa_item-type` / `pa_volume`
7. Read-only wp-admin status page linking to the dashboard
8. Small-order cart fee + **€300 min order hard-block** (`order_config.min_order_value_eur`)
9. Catalog helpers: visibility, strip leftover LPS* cats, Blocksy lookup SQL (this shop’s products)
10. SEO: PHP disables core WP sitemaps / `noindex` on hidden products. Bun writes static XML

---

## 6. Vendor

**Exactly one vendor:** wholesale-perfumes.eu (SoleLuna). Slug `wholesale-perfumes`, SKU `WPF`,
storefront label Wholesale, MOQ €300, dispatch sandbox-locked.

Credentials: `WHOLESALE_PERFUMES_USER` + `WHOLESALE_PERFUMES_TOKEN` (HTTP Basic). Dashboard Secrets
or `.env`. No `BEAUTYFORT_*` / `BTS_*` in this repo.

Catalog XML (daily) + store XML (hourly price/stock). Cart `code` is catalog product `id`.
Dry-run must not `DELETE /cart` or `POST /cart/submit`.

Leftover `beautyfort` / `bts` rows in `sil_vendors` (if a DB was copied from retail) are parked
inactive and hidden. There are no connectors for them here.

---

## 7. Offline development

`.feedscratch/` holds live XML dumps (gitignored). `--source=local` reads fixtures under
`tests/fixtures/wholesale_perfumes_*.xml`.
