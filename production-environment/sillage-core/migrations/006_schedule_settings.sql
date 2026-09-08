-- Scheduling lives in settings, not in the crontab.
--
-- Cron ticks on a fixed short interval and the tick decides what, if anything, is due. That keeps
-- the dashboard authoritative: changing the cadence takes effect on the next tick with no redeploy
-- and no container restart.

INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  -- Master kill switch. Turning this off stops the scheduler without stopping the container, so
  -- manual runs from the dashboard still work.
  ('sync_enabled',       '1'),
  -- Minutes between fast (price/stock/visibility) syncs.
  ('fast_sync_minutes',  '30'),
  -- Whether the nightly full sync runs at all.
  ('full_sync_enabled',  '1'),
  -- Hour of day, 0-23, in the database server's time zone (UTC here), for the full sync.
  ('full_sync_hour',     '3'),
  -- 'live' hits the vendor APIs. 'local' replays the downloaded fixtures, for development.
  ('sync_source',        'live');
