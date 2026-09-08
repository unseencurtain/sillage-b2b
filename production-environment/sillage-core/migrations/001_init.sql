-- Stage 1 schema: vendors, settings, offers, products, term maps, EAN index, run log.
-- Every table is owned outright by sillage-core. WordPress reads only sil_ean_index.

CREATE TABLE IF NOT EXISTS sil_vendors (
  id                    TINYINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug                  VARCHAR(32)      NOT NULL,
  name                  VARCHAR(64)      NOT NULL,
  sku_prefix            VARCHAR(10)      NOT NULL,
  currency              CHAR(3)          NOT NULL DEFAULT 'EUR',
  -- Both vendors quote EUR, so this stays 1.0. It exists so a non-EUR vendor #3 needs no migration.
  fx_rate               DECIMAL(12,6)    NOT NULL DEFAULT 1.000000,
  -- NULL means "inherit the global default from sil_settings".
  price_multiplier      DECIMAL(6,3)     NULL,
  min_visible_stock     INT              NULL,
  -- ISO-3166 alpha-2 codes this vendor will ship to. BeautyFort serves 7, BTS serves 28.
  serviceable_countries JSON             NOT NULL,
  -- Vendor-specific order settings: payment method, shipping selection strategy, etc.
  order_config          JSON             NULL,
  active                TINYINT(1)       NOT NULL DEFAULT 1,
  created_at            DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sil_settings (
  setting_key   VARCHAR(100)  NOT NULL PRIMARY KEY,
  setting_value VARCHAR(1000) NOT NULL,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per storefront product. With EAN dedupe on, several offers can point at one row.
CREATE TABLE IF NOT EXISTS sil_products (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- 'ean:5013692280808' when deduping, otherwise 'bts:64220'.
  identity_key         VARCHAR(120)    NOT NULL,
  wp_post_id           BIGINT UNSIGNED NULL,
  primary_offer_id     BIGINT UNSIGNED NULL,
  sku                  VARCHAR(80)     NULL,
  slug                 VARCHAR(200)    NULL,
  -- Hashes of what was last WRITTEN to WordPress, so a re-run with no changes writes nothing.
  applied_content_hash CHAR(64)        NULL,
  applied_price_hash   CHAR(64)        NULL,
  needs_content_write  TINYINT(1)      NOT NULL DEFAULT 1,
  needs_price_write    TINYINT(1)      NOT NULL DEFAULT 1,
  last_error           TEXT            NULL,
  created_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_identity (identity_key),
  UNIQUE KEY uniq_wp_post (wp_post_id),
  KEY idx_content_dirty (needs_content_write),
  KEY idx_price_dirty (needs_price_write),
  KEY idx_primary_offer (primary_offer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per (vendor, vendor product). The raw normalized feed record.
CREATE TABLE IF NOT EXISTS sil_offers (
  id                       BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vendor_id                TINYINT UNSIGNED NOT NULL,
  vendor_product_id        VARCHAR(64)      NOT NULL,
  sku                      VARCHAR(80)      NOT NULL,
  -- Never cast an EAN to an integer: 12% of BTS EANs have leading zeros.
  primary_ean              VARCHAR(20)      NULL,
  eans                     JSON             NOT NULL,
  name                     VARCHAR(500)     NOT NULL,
  description              MEDIUMTEXT       NULL,
  brand                    VARCHAR(191)     NULL,
  category_refs            JSON             NOT NULL,
  attributes               JSON             NOT NULL,
  vendor_price             DECIMAL(12,4)    NOT NULL,
  vendor_recommended_price DECIMAL(12,4)    NULL,
  stock                    INT              NOT NULL DEFAULT 0,
  image_url                VARCHAR(1000)    NULL,
  gallery_urls             JSON             NOT NULL,
  -- Vendor extras kept for later phases: flammable, lead time, collection, size.
  extra                    JSON             NULL,
  checksum                 CHAR(64)         NOT NULL,
  product_id               BIGINT UNSIGNED  NULL,
  status                   ENUM('pending','applied','error') NOT NULL DEFAULT 'pending',
  last_error               TEXT             NULL,
  first_seen_at            DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at             DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  vanished_at              DATETIME         NULL,
  updated_at               DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_vendor_product (vendor_id, vendor_product_id),
  KEY idx_status (status),
  KEY idx_product (product_id),
  KEY idx_primary_ean (primary_ean),
  KEY idx_last_seen (vendor_id, last_seen_at),
  KEY idx_sku (sku)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Vendor category reference -> WordPress product_cat term.
-- BTS keys are numeric IDs as strings; BeautyFort keys are the running path prefix.
CREATE TABLE IF NOT EXISTS sil_category_map (
  vendor_id           TINYINT UNSIGNED NOT NULL,
  vendor_category_key VARCHAR(300)     NOT NULL,
  wp_term_id          BIGINT UNSIGNED  NOT NULL,
  wp_term_taxonomy_id BIGINT UNSIGNED  NOT NULL,
  depth               TINYINT UNSIGNED NOT NULL DEFAULT 0,
  is_leaf             TINYINT(1)       NOT NULL DEFAULT 1,
  updated_at          DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (vendor_id, vendor_category_key),
  KEY idx_term (wp_term_taxonomy_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Brands and product attributes share one map, keyed by taxonomy.
-- Covers product_brand, pa_gender, pa_item-type, pa_volume.
CREATE TABLE IF NOT EXISTS sil_term_map (
  taxonomy            VARCHAR(32)     NOT NULL,
  source_key          VARCHAR(300)    NOT NULL,
  wp_term_id          BIGINT UNSIGNED NOT NULL,
  wp_term_taxonomy_id BIGINT UNSIGNED NOT NULL,
  label               VARCHAR(200)    NOT NULL,
  updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (taxonomy, source_key),
  KEY idx_term (wp_term_taxonomy_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The one table WordPress reads directly, for the EAN search hook.
-- BeautyFort products carry up to 26 EANs, so this cannot live in a single postmeta row.
CREATE TABLE IF NOT EXISTS sil_ean_index (
  ean        VARCHAR(20)     NOT NULL,
  wp_post_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (ean, wp_post_id),
  KEY idx_post (wp_post_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sil_sync_runs (
  id                BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vendor_id         TINYINT UNSIGNED NULL,
  mode              ENUM('full','fast') NOT NULL DEFAULT 'full',
  source            ENUM('live','local') NOT NULL DEFAULT 'live',
  started_at        DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at       DATETIME         NULL,
  duration_ms       INT              NULL,
  products_fetched  INT              NOT NULL DEFAULT 0,
  products_new      INT              NOT NULL DEFAULT 0,
  products_updated  INT              NOT NULL DEFAULT 0,
  products_vanished INT              NOT NULL DEFAULT 0,
  posts_created     INT              NOT NULL DEFAULT 0,
  posts_updated     INT              NOT NULL DEFAULT 0,
  prices_updated    INT              NOT NULL DEFAULT 0,
  terms_created     INT              NOT NULL DEFAULT 0,
  errors            INT              NOT NULL DEFAULT 0,
  status            ENUM('running','success','partial','error') NOT NULL DEFAULT 'running',
  error_message     TEXT             NULL,
  stats             JSON             NULL,
  KEY idx_vendor_started (vendor_id, started_at),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Anything a human might need to see. Never swallow an error silently.
CREATE TABLE IF NOT EXISTS sil_events (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  level      ENUM('debug','info','warn','error') NOT NULL DEFAULT 'info',
  scope      VARCHAR(64)     NOT NULL,
  message    VARCHAR(1000)   NOT NULL,
  context    JSON            NULL,
  run_id     BIGINT UNSIGNED NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_created (created_at),
  KEY idx_level_created (level, created_at),
  KEY idx_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
