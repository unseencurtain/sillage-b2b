-- Vanished-from-feed detection originally compared last_seen_at against the run's start time.
-- That is unsafe: last_seen_at is a DATETIME with one-second resolution, so every offer written
-- during the run's first second compared as older than the run and was wrongly delisted. On a
-- cold import that silently hid 7,600 products.
--
-- Tag each offer with the run that last saw it instead. Exact, and immune to clock resolution.

ALTER TABLE sil_offers
  ADD COLUMN last_seen_run_id BIGINT UNSIGNED NULL AFTER last_seen_at,
  ADD KEY idx_vendor_run (vendor_id, last_seen_run_id);
