-- Volume filter mode and ensure new settings keys exist.
-- volume_filter_mode: exact | ranges | off
INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  ('volume_filter_mode', 'ranges');
