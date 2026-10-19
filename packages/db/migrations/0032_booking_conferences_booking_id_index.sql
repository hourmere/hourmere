-- The root is the intent's unique identity; booking_id is its mutable current target.
-- Keep the predecessor's non-unique target semantics while indexing booking hydration.
CREATE INDEX IF NOT EXISTS booking_conferences_booking_id ON booking_conferences (booking_id);
