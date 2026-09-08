-- Tiered retail markup and hide-without-image.
--
-- price_tiers defaults to [] so existing installs keep today's single global_price_multiplier
-- behaviour. An empty list means "fall back to the global (or per-vendor) multiplier". Operators
-- edit the JSON in the dashboard when they want cost bands (e.g. ≤80 × 1.7, above × 1.5).

INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  ('price_tiers', '[]'),
  -- When '1', products whose finally-resolved image is missing or a placeholder are excluded from
  -- catalog and search the same way the stock-threshold rule hides them.
  ('hide_products_without_image', '1');
