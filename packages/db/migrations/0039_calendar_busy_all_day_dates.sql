-- All-day events are floating calendar dates: expand them in the evaluated host's
-- schedule zone, never the provider calendar zone. Timed events remain instants.
ALTER TABLE calendar_busy
  ALTER COLUMN period DROP NOT NULL,
  ADD COLUMN all_day_start date,
  ADD COLUMN all_day_end date,
  ADD CONSTRAINT calendar_busy_representation CHECK (
    (period IS NOT NULL AND all_day_start IS NULL AND all_day_end IS NULL)
    OR
    (period IS NULL AND all_day_start IS NOT NULL AND all_day_end IS NOT NULL
      AND isfinite(all_day_start) AND isfinite(all_day_end)
      AND all_day_start >= DATE '0001-01-01' AND all_day_end <= DATE '9999-12-31'
      AND all_day_end > all_day_start)
  );

-- Keep the existing GiST index for timed overlap; date overlap is per calendar.
CREATE INDEX calendar_busy_calendar_all_day
  ON calendar_busy (calendar_id, all_day_start, all_day_end)
  WHERE all_day_start IS NOT NULL;

-- Old instant ranges cannot unambiguously recover original all-day dates. Retain
-- busy rows until the next complete sync atomically replaces them. Invalidating
-- every Google cursor also covers calendars that are selected again later. The
-- freshness guard refuses availability until a complete new snapshot succeeds.
UPDATE calendars c SET sync_state = NULL, last_synced_at = NULL
  FROM calendar_connections cc
  WHERE c.connection_id = cc.id AND cc.provider = 'google';
