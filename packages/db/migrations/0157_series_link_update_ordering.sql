-- A link update waits for aggregate actions through the series revision it saw
-- when queued. Older series receipt and outbox rows retain their original state.
ALTER TABLE booking_series_notifications
  ADD COLUMN after_action_revision bigint,
  ADD COLUMN waiting_for_earlier boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT booking_series_notifications_after_action_revision_check CHECK (
    after_action_revision IS NULL OR
      (row_type = 'outbox' AND kind = 'link_update' AND after_action_revision > 0)
  ),
  ADD CONSTRAINT booking_series_notifications_waiting_for_earlier_check CHECK (
    NOT waiting_for_earlier OR (
      after_action_revision IS NOT NULL AND outbox_state IS NOT DISTINCT FROM 'pending'
      AND lease_id IS NULL
    )
  );
