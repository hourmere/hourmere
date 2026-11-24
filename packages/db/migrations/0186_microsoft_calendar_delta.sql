ALTER TABLE calendars DROP CONSTRAINT calendars_sync_error_check;
ALTER TABLE calendars ADD CONSTRAINT calendars_sync_error_check
  CHECK (sync_error IN ('needs_reauth', 'permissions_missing', 'provider_unavailable', 'calendar_removed'));

-- A recurring exception can have a different event ID from the occurrence it replaces.
ALTER TABLE calendar_busy
  ADD COLUMN microsoft_series_id text,
  ADD COLUMN microsoft_original_start text;
CREATE INDEX calendar_busy_microsoft_series
  ON calendar_busy (calendar_id, microsoft_series_id, microsoft_original_start)
  WHERE microsoft_series_id IS NOT NULL;

-- Keep incomplete Graph rounds separate from published busy intervals.
CREATE TABLE calendar_microsoft_changes (
  calendar_id uuid REFERENCES calendars(id) ON DELETE CASCADE,
  position integer,
  external_event_id text NOT NULL,
  microsoft_series_id text,
  microsoft_original_start text,
  period tstzrange,
  last_modified_at timestamptz,
  removes_series boolean NOT NULL,
  is_exception boolean NOT NULL,
  PRIMARY KEY (calendar_id, position)
);
