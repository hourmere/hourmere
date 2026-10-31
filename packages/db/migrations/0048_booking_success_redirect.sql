-- Existing settings and bookings retain the ordinary confirmation behaviour.
ALTER TABLE event_types ADD COLUMN success_redirect jsonb
  CHECK (success_redirect IS NULL OR jsonb_typeof(success_redirect) = 'object');
ALTER TABLE bookings ADD COLUMN success_redirect jsonb
  CHECK (success_redirect IS NULL OR jsonb_typeof(success_redirect) = 'object');
