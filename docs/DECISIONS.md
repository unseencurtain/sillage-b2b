# DECISIONS — wholesale-perfumes shop

Locked choices for this storefront. Retail BeautyFort + BTS decisions live in
[unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).

| # | Decision | Why |
|---|---|---|
| 1 | Currency is EUR everywhere, no FX conversion | wholesale-perfumes quotes EUR. `fx_rate` exists at `1.0` so a future non-EUR vendor needs no migration |
| 2 | Price is `vendor_price × fx_rate × multiplier`, a plain float | `0.5`, `1.2`, `2` all valid. No percentage arithmetic to get wrong |
| 4 | Two databases, one MariaDB server | Cross-database writes stay in one ACID transaction; sillage-core stays independently testable |
| 5 | Bun performs every bulk write via raw SQL; PHP performs none | Request-time rendering, search, and Woo cache invalidation need WordPress. Product writes do not |
| 6 | SKU is `WPF-{vendor_product_id}` | Unique by construction |
| 9 | Vanished from feed → soft-hide, never delete | Hard deletion orphans order history |
| 10 | Below stock threshold → hidden **and** `outofstock` | Catalog/search exclusion alone still leaves the product addable via a direct link |
| 11 | Threshold comparison is `stock <= threshold`, inclusive | |
| 12 | Product slug is `slugify(name) + '-' + sku` | Unique by construction; re-runs stay idempotent |
| 13 | Call-interval fast sync (price/stock via store XML); daily full catalogue rebuild | A full pipeline every 30 min would rewrite huge Woo tables to change a handful of prices. Catalog XML is capped separately from store XML |
| 14 | Brands go to native `product_brand` (singular) | WooCommerce 9.4+ ships it |
| 14b | External images fake the attachment layer, never override a theme gallery | `image_downsize` resolves the product post ID to the vendor URL |
| 14c | The plugin must work on any theme | Theme-specific code is a guarded shim only |
| 15 | Primary EAN also written to `_global_unique_id` | WooCommerce GTIN field |
| 18 | Real cron inside wholesale-core; WP-Cron disabled | WP-Cron is traffic-triggered and PHP-timeout-bound |
| 19 | Auto-dispatch defaults **off**; this shop is sandbox-locked | `resolveDispatchDryRun()` is always true. The vendor API has no sandbox |
| 21 | Dashboard owns all configuration; wp-admin gets a read-only status page | Keeps the plugin thin |
| 22 | Multiplier precedence: matching `price_tiers` band > global multiplier | Tiers are operator-editable JSON in `sil_settings` |
| 23 | Products with no usable image are hidden when `hide_products_without_image` is on | Empty / placeholder URLs get `exclude-from-catalog` + `exclude-from-search`. Default on |
| 24 | Cart minimums live in the PHP bridge; knobs live in sillage | Global floor (`cart_min_*`) plus this shop’s €300 MOQ hard-block at checkout |
| 25 | wholesale-perfumes cart mutations run under `GET_LOCK`; dry-run does zero remote I/O | Account-global mutable cart. Crash mid-submit → `needs_attention`, never auto-retry. Cart line `code` is catalog product `id` |
| 26 | Per-vendor configuration lives on the vendor row | This shop has one vendor: wholesale-perfumes |
| 28 | Vendor identity is `_sillage_vendor` postmeta, not `product_cat` | Browse taxonomy is feed **type**; brands stay on `product_brand`. Leftover BeautyFort/BTS rows from a copied DB are parked |
| 29 | rewrite-only syncs reload taxonomy maps from the DB | A full rewrite with empty `categoryMaps` deletes every `product_cat` and brand relationship |

## Open

| Question | Status |
|---|---|
| Product descriptions | Feed blurbs may be empty. `description_mode` is `none` (title in `<p>`) or `template` (brand/type/size). Settings → Advanced |
| Live vendor spend | Locked off. Do not enable until an operator changes `resolveDispatchDryRun` in code |
