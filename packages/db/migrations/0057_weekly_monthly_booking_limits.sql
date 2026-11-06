-- NULL retains the existing unlimited behavior. No existing event or booking is
-- rewritten; limits apply only when evaluating a new booking or reschedule.
ALTER TABLE event_types
  ADD COLUMN max_bookings_per_week integer,
  ADD COLUMN max_bookings_per_month integer,
  ADD CONSTRAINT event_types_max_bookings_per_week_range
    CHECK (max_bookings_per_week BETWEEN 1 AND 1000),
  ADD CONSTRAINT event_types_max_bookings_per_month_range
    CHECK (max_bookings_per_month BETWEEN 1 AND 1000),
  ADD CONSTRAINT event_types_booking_limits_day_week
    CHECK (max_bookings_per_week >= max_bookings_per_day),
  ADD CONSTRAINT event_types_booking_limits_week_month
    CHECK (max_bookings_per_month >= max_bookings_per_week),
  ADD CONSTRAINT event_types_booking_limits_day_month
    CHECK (max_bookings_per_month >= max_bookings_per_day);
