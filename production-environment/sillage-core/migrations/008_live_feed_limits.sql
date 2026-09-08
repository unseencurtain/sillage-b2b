-- Hard limits on live vendor API downloads (BeautyFort ~40 SOAP/day budget).
INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  -- Minimum minutes between live catalogue downloads (cache is used in between).
  ('live_feed_min_minutes', '60'),
  -- Daily caps (successful live downloads). BeautyFort is the scarce one.
  ('beautyfort_live_max_per_day', '20'),
  ('bts_live_max_per_day', '48');
