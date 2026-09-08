# S1-writer — the WooCommerce write path

The highest-risk component. It bypasses WooCommerce's CRUD layer, so anything WooCommerce would
normally maintain for us is now our responsibility. A miss here produces a store that looks correct
and filters wrongly.

## Input

Rows from `sillage.sil_products` joined to their primary `sil_offers` row where `status='pending'`.
Driven in batches: `SELECT ... LIMIT ?`, loop until empty, **one transaction per batch**. A bad row
in batch 40 must not roll back batches 1–39.

## Per-batch sequence

### 1. `earth.wp_posts`

New products only. Existing ones are resolved through `sil_products.wp_post_id` — an O(1) unique-key
lookup. **Never** resolve by scanning `wp_postmeta WHERE meta_key='_vendor_product_id'`;
`meta_value` has no usable index.

```sql
INSERT INTO earth.wp_posts
  (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt,
   post_status, comment_status, ping_status, post_name, post_modified, post_modified_gmt,
   post_type, post_parent, menu_order, to_ping, pinged, post_content_filtered, post_password, guid)
VALUES (1, NOW(), UTC_TIMESTAMP(), ?, ?, '', 'publish', 'closed', 'closed', ?,
        NOW(), UTC_TIMESTAMP(), 'product', 0, 0, '', '', '', '', '');
```

Every column is `NOT NULL` in WordPress's schema — omitting `to_ping`, `pinged`,
`post_content_filtered` or `post_password` fails in strict mode. Set `guid` afterwards to
`{siteurl}/?post_type=product&p={ID}` and write the new ID straight back to
`sil_products.wp_post_id`.

Updates touch only `post_title`, `post_content`, `post_name`, `post_modified*`.

### 2. `earth.wp_postmeta`

No unique key exists on `(post_id, meta_key)`, so upsert is unavailable and adding an index to a
core table is off-limits. Delete our managed keys for the batch's post IDs, then one multi-row
insert.

Managed keys:

```
_sku _global_unique_id _regular_price _sale_price _price
_stock _stock_status _manage_stock _backorders
_tax_status _tax_class _virtual _downloadable _sold_individually
_weight _length _width _height
_product_attributes _product_version
_sillage_vendor _sillage_vendor_product_id _sillage_offer_id
_external_thumbnail_url _external_gallery_urls
```

`_sale_price` is written only when a sale price exists. `_product_attributes` is **PHP-serialized**
via the `php-serialize` package. **Never write `_thumbnail_id`.**

### 3. Terms — `earth.wp_term_relationships`

Delete then insert per post, scoped to the taxonomies we own so we never clobber a manually
assigned term:

- `product_cat` — resolved leaf terms only; WooCommerce walks ancestors itself
- `product_brand` — singular; the plural spelling is not a registered taxonomy
- `pa_gender`, `pa_item-type`, `pa_volume` — `pa_type` is impossible, WordPress reserves `type`
- `product_type` — without it WooCommerce does not treat the post as a product
- `product_visibility` — `exclude-from-catalog` + `exclude-from-search` when hidden, `outofstock`
  when out of stock

Visibility term IDs are queried once per run and cached. Do not hardcode them.

### 4. `earth.wp_wc_product_meta_lookup`

Real upsert — `product_id` is the primary key.

```sql
INSERT INTO earth.wp_wc_product_meta_lookup
  (product_id, sku, global_unique_id, virtual, downloadable, min_price, max_price,
   onsale, stock_quantity, stock_status, rating_count, average_rating, total_sales,
   tax_status, tax_class)
VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 0, 0.00, 0, 'taxable', '')
ON DUPLICATE KEY UPDATE
  sku=VALUES(sku), global_unique_id=VALUES(global_unique_id),
  min_price=VALUES(min_price), max_price=VALUES(max_price), onsale=VALUES(onsale),
  stock_quantity=VALUES(stock_quantity), stock_status=VALUES(stock_status);
```

`min_price` and `max_price` are both the effective price (simple products). `onsale` is 1 when a
sale price is set. `stock_quantity` is a `double`. Leave `rating_count`, `average_rating` and
`total_sales` alone on update — they are WooCommerce's, not ours.

### 5. `earth.wp_wc_product_attributes_lookup`

Composite primary key `(product_id, product_or_parent_id, taxonomy, term_id)`. Delete by
`product_id`, then insert one row per attribute term with `product_or_parent_id = product_id`,
`is_variation_attribute = 0`, `in_stock` matching the product. Skip this and layered navigation
silently returns nothing.

### 6. `sillage.sil_ean_index`

Delete by `wp_post_id`, bulk insert the product's EANs. BeautyFort rows carry up to 26.

## End of run, once — not per batch

1. **Term counts** — one `UPDATE ... SET count = (SELECT COUNT(*) ...)` per owned taxonomy
2. **`wp_wc_category_lookup`** — truncate and rebuild with a recursive CTE over `product_cat`
3. **`POST /wp-json/sillage/v1/finalize`** — WooCommerce cache-version bump and Blocksy lookup
   regeneration, authenticated with the shared secret

## Batching

Build multi-row `INSERT` statements against a **byte budget**, not a row count. `max_allowed_packet`
is raised to 64 MB by the infra step; cap statements at 4 MB for headroom. `wp_postmeta` is the
binding constraint at roughly 20 rows per product.

## Acceptance

- Cold import of 52.7k products completes in under 8 minutes
- Re-running immediately reports zero changes and creates zero duplicate posts
- After a run: `wp_wc_product_meta_lookup` row count equals published product count; attribute and
  category filters return correct counts; no product has a `_thumbnail_id`
- A batch that throws leaves earlier batches committed and marks only its own rows `error`
