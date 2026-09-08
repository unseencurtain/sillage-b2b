-- Operator timezone for full-sync hour and dashboard clocks.
-- IANA name (e.g. Europe/Madrid). Hour in sil_settings.full_sync_hour is local to this zone.
-- MariaDB timestamps stay UTC; default UTC preserves existing schedule behaviour.

INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  ('schedule_timezone', 'UTC');
