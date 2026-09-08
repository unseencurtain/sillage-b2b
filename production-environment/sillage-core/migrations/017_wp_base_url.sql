-- Public shop URL for dashboard WooCommerce links and customer-facing tracking pushes.
-- Bootstrap default comes from env WP_BASE_URL; operators can override in Settings after login.
-- In-Docker finalize still uses WORDPRESS_INTERNAL_URL (http://ecom) when set.

INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  ('wp_base_url', '');
