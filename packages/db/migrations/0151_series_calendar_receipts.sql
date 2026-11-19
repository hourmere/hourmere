-- The dates listed in a series email can differ from the entries attached.
-- Leave old receipts unknown so they cannot authorize a cancellation entry.
ALTER TABLE booking_series_notifications
  ADD COLUMN calendar_ordinals smallint[],
  ADD CONSTRAINT booking_series_notifications_calendar_ordinals_check CHECK (
    calendar_ordinals IS NULL OR (
      outcome IS NOT DISTINCT FROM 'delivered'
      AND cardinality(calendar_ordinals) <= 12
      AND coalesce(array_ndims(calendar_ordinals), 1) = 1
      AND calendar_ordinals <@ reported_ordinals
    )
  );

-- An ordinary confirmation or move can be a body-only mail for a host with
-- a provider copy. Only mark a receipt when a series member's ICS was sent.
ALTER TABLE booking_notifications
  ADD COLUMN calendar_attached boolean,
  ADD CONSTRAINT booking_notifications_calendar_attached_check CHECK (
    calendar_attached IS NULL OR (
      calendar_attached AND outcome = 'sent' AND kind IN ('confirmed', 'rescheduled')
    )
  );
