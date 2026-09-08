-- FeedSource already includes "cache" (on-disk last live download / rewrite-only).
-- sil_sync_runs.source was still ENUM('live','local'), so pricing Save rewrite-only
-- failed with "Data truncated for column 'source'".
ALTER TABLE sil_sync_runs
  MODIFY COLUMN source ENUM('live', 'local', 'cache') NOT NULL DEFAULT 'live';
