-- One cadence, one number.
--
-- Settings shows a single "Minutes between syncs" field, but two rows back it: fast_sync_minutes
-- (how often the scheduler ticks) and live_feed_min_minutes (how long a vendor must cool down
-- before it may be downloaded again). Saving the field writes both. Their seeded defaults did not
-- match — 30 and 60 — so any install where nobody had ever saved that field ticked every 30
-- minutes while the dashboard displayed 60, and every second tick logged the vendors as blocked.
--
-- Take the value the operator can actually see and make the hidden one agree with it.
UPDATE sil_settings s
   JOIN (SELECT setting_value AS v FROM sil_settings WHERE setting_key = 'live_feed_min_minutes') l
   SET s.setting_value = l.v
 WHERE s.setting_key = 'fast_sync_minutes'
   AND s.setting_value <> l.v;
