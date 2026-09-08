-- Public base URL for self-hosted product images (lps-media). Absolute URLs in
-- image_overrides.json / _external_thumbnail_url are still authoritative; this knob
-- documents the intended host for tools and operators. Changing it does not rewrite
-- existing product rows — update overrides (or PUBLIC_URL_BASE / LPS_MEDIA_BASE_URL)
-- then sync with --rewrite-all.

INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  ('image_cdn_base_url', 'https://images.slilverbelt.xyz');
