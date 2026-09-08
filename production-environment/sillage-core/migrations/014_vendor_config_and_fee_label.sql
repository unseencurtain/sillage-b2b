-- Per-vendor live-feed caps on the vendor row (no more vendor-named setting keys for new
-- suppliers), plus an editable cart fee line-item label.

ALTER TABLE sil_vendors
  ADD COLUMN live_max_per_day INT UNSIGNED NULL
    COMMENT 'Max live catalogue downloads per calendar day; NULL = use legacy setting / default'
    AFTER active,
  ADD COLUMN store_live_max_per_day INT UNSIGNED NULL
    COMMENT 'Optional secondary feed daily cap (wholesale-perfumes store XML)'
    AFTER live_max_per_day,
  ADD COLUMN store_live_min_minutes INT UNSIGNED NULL
    COMMENT 'Optional secondary feed min interval minutes (wholesale-perfumes store XML)'
    AFTER store_live_max_per_day;

-- Backfill catalogue caps from the legacy per-vendor setting keys (008).
-- beautyfort_live_max_per_day / bts_live_max_per_day only — wholesale-perfumes never used those keys.
UPDATE sil_vendors v
INNER JOIN sil_settings s ON s.setting_key = CONCAT(v.slug, '_live_max_per_day')
SET v.live_max_per_day = CAST(s.setting_value AS UNSIGNED);

-- Defensive defaults when a setting row was never present.
UPDATE sil_vendors SET live_max_per_day = 20 WHERE slug = 'beautyfort' AND live_max_per_day IS NULL;
UPDATE sil_vendors SET live_max_per_day = 48 WHERE slug = 'bts' AND live_max_per_day IS NULL;
UPDATE sil_vendors SET live_max_per_day = 1 WHERE slug = 'wholesale-perfumes' AND live_max_per_day IS NULL;

-- wholesale-perfumes store (price/stock) feed: hourly, separate from the once-per-day catalog cap.
UPDATE sil_vendors
SET store_live_max_per_day = 24, store_live_min_minutes = 60
WHERE slug = 'wholesale-perfumes'
  AND (store_live_max_per_day IS NULL OR store_live_min_minutes IS NULL);

-- Cart fee line-item text (PHP bridge reads this; blank/missing falls back to the same default).
INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  ('cart_min_fee_label', 'Small order fee');
