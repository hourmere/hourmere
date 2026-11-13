-- Invitee change deadlines: how long before a meeting starts its invitee may no longer
-- reschedule, and (separately) no longer cancel, through the invitee's own link.
-- NULL keeps today's behavior: invitees may change a booking until it starts.
-- Each booking stores the values that applied when it was booked, so a later event type
-- edit never changes an existing booking's deadlines. Rows written before this migration
-- have no deadline, exactly as before. Hosts and team admins are never limited by them.
ALTER TABLE event_types
  ADD COLUMN reschedule_cutoff_minutes integer,
  ADD COLUMN cancel_cutoff_minutes integer,
  ADD CONSTRAINT event_types_reschedule_cutoff_range
    CHECK (reschedule_cutoff_minutes BETWEEN 1 AND 525600),
  ADD CONSTRAINT event_types_cancel_cutoff_range
    CHECK (cancel_cutoff_minutes BETWEEN 1 AND 525600);

ALTER TABLE bookings
  ADD COLUMN reschedule_cutoff_minutes integer,
  ADD COLUMN cancel_cutoff_minutes integer,
  ADD CONSTRAINT bookings_reschedule_cutoff_range
    CHECK (reschedule_cutoff_minutes BETWEEN 1 AND 525600),
  ADD CONSTRAINT bookings_cancel_cutoff_range
    CHECK (cancel_cutoff_minutes BETWEEN 1 AND 525600);
