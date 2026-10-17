-- Keep the original creation attribution while recording who withdrew each booking.
-- Existing withdrawals remain unknown rather than being assigned a fabricated origin.
ALTER TABLE bookings
  ADD COLUMN cancelled_source text CHECK (cancelled_source IN ('web', 'embed', 'api', 'mcp')),
  ADD COLUMN cancelled_api_key_id uuid,
  ADD CONSTRAINT booking_cancellation_origin_status CHECK (
    status = 'cancelled' OR (cancelled_source IS NULL AND cancelled_api_key_id IS NULL)
  ),
  ADD CONSTRAINT booking_cancellation_key_origin CHECK (
    cancelled_api_key_id IS NULL OR
    (cancelled_source IS NOT NULL AND cancelled_source IN ('api', 'mcp'))
  );
-- As with api_key_id, retain the identifier after the key itself is deleted.
