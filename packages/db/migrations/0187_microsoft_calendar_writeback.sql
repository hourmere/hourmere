-- Keep retry and ambiguous-create state with the destination pinned at booking time.
-- A group occurrence already pins its own destination independently of each seat.
ALTER TABLE booking_calendar_targets ADD COLUMN microsoft_writeback jsonb;
ALTER TABLE group_slots ADD COLUMN microsoft_writeback jsonb;

-- Due times use UTC ISO strings from the worker. Terminal work stays out of dispatch.
CREATE INDEX booking_calendar_targets_microsoft_due
  ON booking_calendar_targets ((microsoft_writeback->>'nextAttemptAt'))
  WHERE (microsoft_writeback->>'status') IN ('pending','retrying');
CREATE INDEX group_slots_microsoft_due
  ON group_slots ((microsoft_writeback->>'nextAttemptAt'))
  WHERE (microsoft_writeback->>'status') IN ('pending','retrying');
