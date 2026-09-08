-- Small-order (Foodpanda-style) cart fee. Defaults OFF so deploy changes nothing until
-- an operator enables cart_min_enabled in the dashboard.
--
-- Per-vendor minimums are NOT global settings: they live under
-- sil_vendors.order_config.min_order_value_eur (JSON key). Absent key = no vendor floor.

INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  ('cart_min_enabled', '0'),
  ('cart_min_subtotal_eur', '50'),
  ('cart_min_fee_eur', '5'),
  -- {remaining} is replaced with a WooCommerce-formatted currency amount on the storefront.
  ('cart_min_message', 'Add {remaining} more to your order to remove the small-order fee.');
