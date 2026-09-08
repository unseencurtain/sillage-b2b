-- Stage 2 schema: order dispatch state machine, line items, tracking, transition log.

CREATE TABLE IF NOT EXISTS sil_vendor_orders (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- HPOS order id from earth.wp_wc_orders. WooCommerce 11 does not use wp_posts for orders.
  wc_order_id         BIGINT UNSIGNED  NOT NULL,
  wc_order_number     VARCHAR(64)      NULL,
  vendor_id           TINYINT UNSIGNED NOT NULL,
  status              ENUM('received','approved','submitting','submitted','confirmed',
                           'dispatched','delivered','failed','cancelled','needs_attention')
                      NOT NULL DEFAULT 'received',
  -- Our reference. For BeautyFort this is a genuine idempotency key (yourOrderReference).
  -- BTS accepts no client reference, which is why its recovery path differs.
  our_reference       VARCHAR(64)      NOT NULL,
  vendor_order_number VARCHAR(64)      NULL,
  currency            CHAR(3)          NOT NULL DEFAULT 'EUR',
  destination_country CHAR(2)          NOT NULL,
  -- What we pay the vendor.
  items_cost          DECIMAL(12,2)    NOT NULL DEFAULT 0,
  shipping_cost       DECIMAL(12,2)    NULL,
  total_cost          DECIMAL(12,2)    NULL,
  -- What the customer paid for these lines, so the dashboard can show margin.
  revenue             DECIMAL(12,2)    NOT NULL DEFAULT 0,
  shipping_option_id  VARCHAR(64)      NULL,
  shipping_company    VARCHAR(128)     NULL,
  -- Recorded before the HTTP call so a crash mid-submit is diagnosable.
  request_payload     JSON             NULL,
  payload_hash        CHAR(64)         NULL,
  response_payload    JSON             NULL,
  dry_run             TINYINT(1)       NOT NULL DEFAULT 1,
  attempts            INT              NOT NULL DEFAULT 0,
  last_error          TEXT             NULL,
  approved_at         DATETIME         NULL,
  submitted_at        DATETIME         NULL,
  dispatched_at       DATETIME         NULL,
  delivered_at        DATETIME         NULL,
  last_polled_at      DATETIME         NULL,
  created_at          DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- One vendor order per (WooCommerce order, vendor). A mixed cart produces two rows.
  UNIQUE KEY uniq_order_vendor (wc_order_id, vendor_id),
  UNIQUE KEY uniq_reference (our_reference),
  KEY idx_status (status),
  KEY idx_poll (status, last_polled_at),
  KEY idx_vendor_created (vendor_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sil_vendor_order_items (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vendor_order_id   BIGINT UNSIGNED NOT NULL,
  wc_order_item_id  BIGINT UNSIGNED NULL,
  wp_post_id        BIGINT UNSIGNED NULL,
  offer_id          BIGINT UNSIGNED NULL,
  sku               VARCHAR(80)     NOT NULL,
  vendor_product_id VARCHAR(64)     NOT NULL,
  ean               VARCHAR(20)     NULL,
  name              VARCHAR(500)    NOT NULL,
  quantity          INT             NOT NULL,
  unit_cost         DECIMAL(12,4)   NOT NULL,
  unit_price        DECIMAL(12,4)   NOT NULL,
  KEY idx_vendor_order (vendor_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sil_vendor_order_tracking (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vendor_order_id BIGINT UNSIGNED NOT NULL,
  courier         VARCHAR(128)    NULL,
  tracking_code   VARCHAR(190)    NOT NULL,
  tracking_url    VARCHAR(1000)   NULL,
  dispatched_at   DATETIME        NULL,
  -- Set once the tracking has been pushed back into WooCommerce via the bridge plugin.
  pushed_to_wc    TINYINT(1)      NOT NULL DEFAULT 0,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_tracking (vendor_order_id, tracking_code),
  KEY idx_pending_push (pushed_to_wc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sil_order_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vendor_order_id BIGINT UNSIGNED NOT NULL,
  from_status     VARCHAR(32)     NULL,
  to_status       VARCHAR(32)     NULL,
  message         VARCHAR(1000)   NOT NULL,
  context         JSON            NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_vendor_order (vendor_order_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
